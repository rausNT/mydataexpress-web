#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { auditSource } from './extension-audit.mjs';

function pascalString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function declaration(source, spec) {
  if (!spec.origName) return '';
  const kind = spec.kind === 'function' ? 'function' : 'procedure';
  const escaped = spec.origName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${kind}\\s+${escaped}\\b[\\s\\S]*?;`, 'i');
  return source.match(regex)?.[0]?.trim() || '';
}

function parameterNames(decl) {
  const block = decl.match(/\(([\s\S]*?)\)/)?.[1] || '';
  return block.split(';').flatMap(group => {
    const beforeType = group.split(':')[0]?.replace(/^\s*(const|var|out)\s+/i, '') || '';
    return beforeType.split(',').map(name => name.trim()).filter(name => /^[A-Za-z_]\w*$/.test(name));
  });
}

function payloadLines(decl) {
  const names = parameterNames(decl);
  if (!names.length) return ["  ProviderPayload := '{}';"];
  const result = ["  ProviderPayload := '{';"];
  names.forEach((name, index) => {
    const prefix = index ? ',' : '';
    result.push(`  ProviderPayload := ProviderPayload + '${prefix}"${name}":' + StringToJSONString(VarToStr(${name}), True);`);
  });
  result.push("  ProviderPayload := ProviderPayload + '}';");
  return result;
}

function resultType(decl) {
  return decl.match(/:\s*([\w.]+)\s*;$/i)?.[1]?.toLowerCase() || '';
}

function defaultResult(decl) {
  const type = resultType(decl);
  if (['string', 'ansistring', 'unicodestring'].includes(type)) return "''";
  if (['boolean', 'bool'].includes(type)) return 'False';
  if (['variant'].includes(type)) return 'Null';
  return '0';
}

export function generateWebModule(source, filename = 'Extension.epas') {
  const report = auditSource(source, filename);
  const moduleName = basename(filename, extname(filename));
  const specs = report.specifications.filter(spec => spec.name || spec.id);
  const lines = [
    '{@module',
    `Author=${report.module.author || 'DataExpress migration tool'}`,
    `Version=${report.module.version || '1.0'}-web`,
    `Description=Generated web adapter for ${moduleName}. Review provider mappings before production use.`,
    '@}',
    '',
  ];
  const mappings = [];

  for (const spec of specs) {
    if (spec.kind === 'function') {
      lines.push('{@function', `Name=${spec.name}`, '@}', '');
    } else {
      lines.push('{@action', `Id=${spec.id}`, '@}', '');
    }

    const decl = declaration(source, spec);
    if (!decl) {
      lines.push(`{ TODO: declaration for ${spec.origName || spec.name || spec.id} was not found. }`, '');
      mappings.push({
        kind: spec.kind,
        name: spec.name,
        id: spec.id,
        origName: spec.origName,
        args: spec.args,
        result: spec.result,
        operation: spec.name || spec.id,
        status: 'manual',
        reason: 'declaration-not-found',
      });
      continue;
    }

    const operation = spec.kind === 'function' ? spec.name : spec.id;
    lines.push(decl, 'var', '  ProviderPayload, ProviderResponse: String;', 'begin');
    lines.push(...payloadLines(decl));
    lines.push(`  ProviderResponse := ExtensionProviderCall(${pascalString(moduleName)}, ${pascalString(operation)}, ProviderPayload);`);
    if (spec.kind === 'function') {
      if (/:\s*(String|AnsiString|UnicodeString)\s*;$/i.test(decl)) lines.push('  Result := ProviderResponse;');
      else lines.push('  { TODO: convert ProviderResponse to the function result type. }', `  Result := ${defaultResult(decl)};`);
    }
    lines.push('end;', '');
    const automatic = spec.kind === 'action' || ['string', 'ansistring', 'unicodestring'].includes(resultType(decl));
    mappings.push({
      kind: spec.kind,
      name: spec.name,
      id: spec.id,
      origName: spec.origName,
      args: spec.args,
      result: spec.result,
      operation,
      status: automatic ? 'provider' : 'manual',
      reason: automatic ? '' : `unsupported-result-type:${resultType(decl) || 'unknown'}`,
    });
  }

  const compatible = mappings.filter(item => item.status === 'provider').length;
  const manifest = {
    schemaVersion: 1,
    provider: moduleName,
    sourceModule: basename(filename),
    webModule: `${moduleName}Web.epas`,
    summary: {
      total: mappings.length,
      compatible,
      manual: mappings.length - compatible,
      complete: compatible === mappings.length,
    },
    mappings,
  };

  return { module: lines.join('\n'), report, manifest };
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('Usage: node tools/extension-migrate.mjs <extension.epas> [--output extensionWeb.epas] [--manifest extensionWeb.manifest.json] [--no-manifest]');
    process.exitCode = 2;
    return;
  }
  const input = resolve(args[0]);
  const source = readFileSync(input, 'utf8');
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && !args[outputIndex + 1]) {
    console.error('--output requires a file path');
    process.exitCode = 2;
    return;
  }
  const defaultName = `${basename(input, extname(input))}Web.epas`;
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : defaultName);
  const manifestIndex = args.indexOf('--manifest');
  if (manifestIndex >= 0 && !args[manifestIndex + 1]) {
    console.error('--manifest requires a file path');
    process.exitCode = 2;
    return;
  }
  const outputExtension = extname(output);
  const manifestBase = outputExtension ? output.slice(0, -outputExtension.length) : output;
  const manifestOutput = args.includes('--no-manifest') ? '' : resolve(
    manifestIndex >= 0
      ? args[manifestIndex + 1]
      : `${manifestBase}.manifest.json`
  );
  const generated = generateWebModule(source, input);
  generated.manifest.webModule = basename(output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated.module + '\n');
  if (manifestOutput) {
    mkdirSync(dirname(manifestOutput), { recursive: true });
    writeFileSync(manifestOutput, JSON.stringify(generated.manifest, null, 2) + '\n');
  }
  process.stdout.write(`${output}\n`);
  if (manifestOutput) process.stdout.write(`${manifestOutput}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) main();
