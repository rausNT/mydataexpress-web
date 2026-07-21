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

function defaultResult(decl) {
  const type = decl.match(/:\s*([\w.]+)\s*;$/i)?.[1]?.toLowerCase() || '';
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

  for (const spec of specs) {
    if (spec.kind === 'function') {
      lines.push('{@function', `Name=${spec.name}`, '@}', '');
    } else {
      lines.push('{@action', `Id=${spec.id}`, '@}', '');
    }

    const decl = declaration(source, spec);
    if (!decl) {
      lines.push(`{ TODO: declaration for ${spec.origName || spec.name || spec.id} was not found. }`, '');
      continue;
    }

    const operation = spec.name || spec.id;
    lines.push(decl, 'var', '  ProviderPayload, ProviderResponse: String;', 'begin');
    lines.push(...payloadLines(decl));
    lines.push(`  ProviderResponse := ExtensionProviderCall(${pascalString(moduleName)}, ${pascalString(operation)}, ProviderPayload);`);
    if (spec.kind === 'function') {
      if (/:\s*(String|AnsiString|UnicodeString)\s*;$/i.test(decl)) lines.push('  Result := ProviderResponse;');
      else lines.push('  { TODO: convert ProviderResponse to the function result type. }', `  Result := ${defaultResult(decl)};`);
    }
    lines.push('end;', '');
  }

  return { module: lines.join('\n'), report };
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('Usage: node tools/extension-migrate.mjs <extension.epas> [--output extensionWeb.epas]');
    process.exitCode = 2;
    return;
  }
  const input = resolve(args[0]);
  const source = readFileSync(input, 'utf8');
  const outputIndex = args.indexOf('--output');
  const defaultName = `${basename(input, extname(input))}Web.epas`;
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : defaultName);
  const generated = generateWebModule(source, input);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated.module + '\n');
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) main();
