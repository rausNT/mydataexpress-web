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
  const match = new RegExp(`\\b${kind}\\s+${escaped}\\b`, 'i').exec(source);
  if (!match) return '';
  let depth = 0;
  for (let index = match.index; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth = Math.max(0, depth - 1);
    else if (source[index] === ';' && depth === 0) return source.slice(match.index, index + 1).trim();
  }
  return '';
}

function parameters(decl) {
  const block = decl.match(/\(([\s\S]*?)\)/)?.[1] || '';
  return block.split(';').flatMap(group => {
    const colon = group.lastIndexOf(':');
    if (colon < 0) return [];
    let namesPart = group.slice(0, colon).trim();
    const qualifier = namesPart.match(/^(const|var|out)\s+/i)?.[1]?.toLowerCase() || '';
    namesPart = namesPart.replace(/^(const|var|out)\s+/i, '');
    const type = group.slice(colon + 1).split('=')[0].trim();
    return namesPart.split(',')
      .map(name => name.trim())
      .filter(name => /^[A-Za-z_]\w*$/.test(name))
      .map(name => ({ name, type, qualifier }));
  });
}

function payloadLines(params) {
  if (!params.length) return ["  ProviderPayload := '{}';"];
  const result = ["  ProviderPayload := '{';"];
  params.forEach((parameter, index) => {
    const prefix = index ? ',' : '';
    result.push(`  ProviderPayload := ProviderPayload + '${prefix}"${parameter.name}":' + ExtensionProviderEncodeValue(${parameter.name});`);
  });
  result.push("  ProviderPayload := ProviderPayload + '}';");
  return result;
}

function resultType(decl) {
  return decl.match(/:\s*([\w.]+)\s*;$/i)?.[1]?.toLowerCase() || '';
}

const stringTypes = new Set(['string', 'ansistring', 'unicodestring', 'widestring']);
const booleanTypes = new Set(['boolean', 'bool']);
const integerTypes = new Set([
  'byte', 'shortint', 'smallint', 'word', 'integer', 'longint', 'cardinal',
  'longword', 'int64', 'qword', 'nativeint', 'nativeuint',
]);
const floatTypes = new Set(['single', 'double', 'extended', 'real', 'currency', 'comp']);
const dateTypes = new Set(['tdatetime', 'tdate', 'ttime']);

function normalizedType(type) {
  return type.replace(/\s+/g, '').toLowerCase();
}

function supportedParameter(parameter) {
  if (parameter.qualifier === 'var' || parameter.qualifier === 'out') {
    return `by-reference-parameter:${parameter.name}`;
  }
  const type = normalizedType(parameter.type);
  if (stringTypes.has(type) || booleanTypes.has(type) || integerTypes.has(type) ||
      floatTypes.has(type) || dateTypes.has(type) || type === 'variant' ||
      ['char', 'ansichar', 'widechar'].includes(type)) return '';
  return `unsupported-parameter-type:${parameter.type || 'unknown'}`;
}

function resultAdapter(type) {
  const normalized = normalizedType(type);
  if (stringTypes.has(normalized)) return 'ExtensionProviderCall';
  if (booleanTypes.has(normalized)) return 'ExtensionProviderCallBoolean';
  if (integerTypes.has(normalized)) return 'ExtensionProviderCallInt64';
  if (floatTypes.has(normalized)) return 'ExtensionProviderCallFloat';
  if (dateTypes.has(normalized)) return 'ExtensionProviderCallDateTime';
  if (normalized === 'variant') return 'ExtensionProviderCallVariant';
  return '';
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
    const params = parameters(decl);
    const issues = params.map(supportedParameter).filter(Boolean);
    const type = spec.kind === 'function' ? resultType(decl) : '';
    const adapter = spec.kind === 'function' ? resultAdapter(type) : 'ExtensionProviderCall';
    if (spec.kind === 'function' && !adapter) issues.push(`unsupported-result-type:${type || 'unknown'}`);
    const automatic = issues.length === 0;

    lines.push(decl);
    if (automatic) {
      lines.push('var', spec.kind === 'action'
        ? '  ProviderPayload, ProviderResponse: String;'
        : '  ProviderPayload: String;', 'begin');
      lines.push(...payloadLines(params));
      const call = `${adapter}(${pascalString(moduleName)}, ${pascalString(operation)}, ProviderPayload)`;
      if (spec.kind === 'function') lines.push(`  Result := ${call};`);
      else lines.push(`  ProviderResponse := ${call};`);
    } else {
      lines.push('begin', `  { TODO: manual provider adapter required: ${issues.join(', ')}. }`);
    }
    lines.push('end;', '');
    mappings.push({
      kind: spec.kind,
      name: spec.name,
      id: spec.id,
      origName: spec.origName,
      args: spec.args,
      result: spec.result,
      resultType: type,
      parameters: params,
      operation,
      status: automatic ? 'provider' : 'manual',
      reason: automatic ? '' : issues[0],
      issues,
      wireFormat: 'json-v1',
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
