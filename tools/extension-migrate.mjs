#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource } from './extension-audit.mjs';
import {
  generateProviderConfig,
  generateProviderScaffold,
  installProviderSdk,
} from './extension-provider-scaffold.mjs';

function pascalString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function relativeImportPath(fromFile, toFile) {
  let value = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
  if (!value.startsWith('.')) value = `./${value}`;
  return value;
}

function declarationRange(source, spec) {
  if (!spec.origName) return '';
  const kind = spec.kind === 'function' ? 'function' : 'procedure';
  const escaped = spec.origName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${kind}\\s+${escaped}\\b`, 'i').exec(source);
  if (!match) return '';
  let depth = 0;
  for (let index = match.index; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth = Math.max(0, depth - 1);
    else if (source[index] === ';' && depth === 0) {
      return {
        start: match.index,
        end: index + 1,
        text: source.slice(match.index, index + 1).trim(),
      };
    }
  }
  return '';
}

function declaration(source, spec) {
  return declarationRange(source, spec)?.text || '';
}

function pascalTokens(source, start = 0) {
  const tokens = [];
  let index = start;
  while (index < source.length) {
    if (source[index] === "'") {
      index++;
      while (index < source.length) {
        if (source[index] !== "'") index++;
        else if (source[index + 1] === "'") index += 2;
        else { index++; break; }
      }
      continue;
    }
    if (source[index] === '{') {
      const end = source.indexOf('}', index + 1);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('(*', index)) {
      const end = source.indexOf('*)', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(source[index])) {
      const tokenStart = index++;
      while (/[A-Za-z0-9_]/.test(source[index] || '')) index++;
      tokens.push({
        value: source.slice(tokenStart, index),
        lower: source.slice(tokenStart, index).toLowerCase(),
        start: tokenStart,
        end: index,
      });
      continue;
    }
    index++;
  }
  return tokens;
}

function routineImplementation(source, spec) {
  const range = declarationRange(source, spec);
  if (!range) return { source: '', reason: 'declaration-not-found' };
  const tokens = pascalTokens(source, range.end);
  const bodyIndex = tokens.findIndex(token => token.lower === 'begin');
  if (bodyIndex < 0) return { source: '', reason: 'implementation-not-found' };
  if (tokens.slice(0, bodyIndex).some(token => ['function', 'procedure'].includes(token.lower))) {
    return { source: '', reason: 'nested-routine-or-forward-declaration' };
  }
  let depth = 0;
  for (let index = bodyIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (['begin', 'case', 'try', 'asm'].includes(token.lower)) depth++;
    else if (token.lower === 'end') {
      depth--;
      if (depth === 0) {
        let end = token.end;
        while (/\s/.test(source[end] || '')) end++;
        if (source[end] === ';') end++;
        return {
          source: source.slice(range.start, end).trim(),
          declaration: range.text,
          preamble: source.slice(range.end, tokens[bodyIndex].start),
          body: source.slice(tokens[bodyIndex].start, token.end),
          reason: '',
        };
      }
    }
  }
  return { source: '', reason: 'implementation-end-not-found' };
}

const pascalKeywords = new Set(`
  and array as asm begin case class const constructor destructor div do downto
  else end except exit exports file finalization finally for function goto if
  implementation in inherited initialization inline interface is label mod nil
  not object of on operator or packed procedure program property raise record
  repeat result set shl shr then threadvar to true try type unit until uses var
  while with xor false
`.trim().split(/\s+/));

const portableIdentifiers = new Set(`
  abs ansichar ansistring boolean byte cardinal char comp copy currency date
  datetime dayof decodedate decodetime double encodeDate encodetime extended
  floatToStr format frac inc int64 integer intToStr length longint longword
  lowercase max min nativeint nativeuint now pos qword real round shortint
  single smallint string stringreplace time tdate tdatetime trim trunc ttime
  trystrtofloat trystrtoint trystrtoint64 uppercase unicodestring variant
  widechar widestring word
`.trim().toLowerCase().split(/\s+/));

function localVariableNames(preamble) {
  const names = [];
  for (const match of preamble.matchAll(/(?:^|;)\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:/gm)) {
    names.push(...match[1].split(',').map(name => name.trim().toLowerCase()));
  }
  return names;
}

function inlineRoutineAnalysis(implementation, params, routineName) {
  if (!implementation.source) return { portable: false, issues: [implementation.reason] };
  const findings = auditSource(implementation.source, '<routine>').findings;
  const issues = findings.map(item => `platform-dependency:${item.rule}`);
  const preambleTokens = pascalTokens(implementation.preamble);
  for (const token of preambleTokens) {
    if (['const', 'type', 'function', 'procedure', 'uses', 'label'].includes(token.lower)) {
      issues.push(`unsupported-local-declaration:${token.lower}`);
    }
  }

  const allowed = new Set([
    ...pascalKeywords,
    ...portableIdentifiers,
    routineName.toLowerCase(),
    ...params.flatMap(parameter => [
      parameter.name.toLowerCase(),
      ...pascalTokens(parameter.type).map(token => token.lower),
    ]),
    ...localVariableNames(implementation.preamble),
  ]);
  for (const token of pascalTokens(`${implementation.preamble}\n${implementation.body}`)) {
    if (!allowed.has(token.lower)) issues.push(`external-dependency:${token.value}`);
  }
  return { portable: issues.length === 0, issues: [...new Set(issues)] };
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

export function generateWebModule(source, filename = 'Extension.epas', { forceProvider = false } = {}) {
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

    const implementation = routineImplementation(source, spec);
    const decl = implementation.declaration || declaration(source, spec);
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
    const type = spec.kind === 'function' ? resultType(decl) : '';
    const adapter = spec.kind === 'function' ? resultAdapter(type) : 'ExtensionProviderCall';
    const signatureIssues = params.map(supportedParameter).filter(Boolean);
    if (spec.kind === 'function' && !adapter) {
      signatureIssues.push(`unsupported-result-type:${type || 'unknown'}`);
    }
    const inline = forceProvider
      ? { portable: false, issues: ['provider-forced'] }
      : inlineRoutineAnalysis(implementation, params, spec.origName || operation);
    if (inline.portable && signatureIssues.length === 0) {
      lines.push(implementation.source, '');
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
        status: 'web-script',
        reason: '',
        issues: [],
        wireFormat: 'pascal-script',
      });
      continue;
    }
    const issues = [...signatureIssues];
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
      issues: automatic ? inline.issues : [...inline.issues, ...issues],
      wireFormat: 'json-v1',
    });
  }

  const provider = mappings.filter(item => item.status === 'provider').length;
  const webScript = mappings.filter(item => item.status === 'web-script').length;
  const compatible = provider + webScript;
  const manifest = {
    schemaVersion: 1,
    provider: moduleName,
    sourceModule: basename(filename),
    webModule: `${moduleName}.wepas`,
    summary: {
      total: mappings.length,
      compatible,
      webScript,
      provider,
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
    console.error('Usage: node tools/extension-migrate.mjs <extension.epas> [--output extension.wepas] [--manifest extension.manifest.json] [--provider-output extension.provider.mjs] [--provider-config extension.provider.cfg.example] [--all-providers] [--no-provider] [--no-manifest]');
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
  const defaultName = `${basename(input, extname(input))}.wepas`;
  const output = outputIndex >= 0
    ? resolve(args[outputIndex + 1])
    : resolve(dirname(input), defaultName);
  if (extname(output).toLowerCase() !== '.wepas') {
    console.error('Web extension output must use the official .wepas extension');
    process.exitCode = 2;
    return;
  }
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
  const providerIndex = args.indexOf('--provider-output');
  if (providerIndex >= 0 && !args[providerIndex + 1]) {
    console.error('--provider-output requires a file path');
    process.exitCode = 2;
    return;
  }
  const providerConfigIndex = args.indexOf('--provider-config');
  if (providerConfigIndex >= 0 && !args[providerConfigIndex + 1]) {
    console.error('--provider-config requires a file path');
    process.exitCode = 2;
    return;
  }
  if (!manifestOutput && (providerIndex >= 0 || providerConfigIndex >= 0)) {
    console.error('Provider scaffold requires a manifest; remove --no-manifest');
    process.exitCode = 2;
    return;
  }
  const generated = generateWebModule(source, input, {
    forceProvider: args.includes('--all-providers'),
  });
  const hasProviderMappings = generated.manifest.mappings.some(mapping => mapping.status === 'provider');
  const providerOutput = manifestOutput && hasProviderMappings && !args.includes('--no-provider')
    ? resolve(providerIndex >= 0 ? args[providerIndex + 1] : `${manifestBase}.provider.mjs`)
    : '';
  const providerConfigOutput = providerOutput && !args.includes('--no-provider-config')
    ? resolve(providerConfigIndex >= 0
      ? args[providerConfigIndex + 1]
      : `${manifestBase}.provider.cfg.example`)
    : '';
  generated.manifest.webModule = basename(output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated.module + '\n');
  if (manifestOutput) {
    mkdirSync(dirname(manifestOutput), { recursive: true });
    writeFileSync(manifestOutput, JSON.stringify(generated.manifest, null, 2) + '\n');
  }
  process.stdout.write(`${output}\n`);
  if (manifestOutput) process.stdout.write(`${manifestOutput}\n`);
  if (providerOutput) {
    const sdkFile = installProviderSdk(dirname(providerOutput));
    mkdirSync(dirname(providerOutput), { recursive: true });
    writeFileSync(providerOutput, generateProviderScaffold(generated.manifest, {
      manifestImport: relativeImportPath(providerOutput, manifestOutput),
      sdkImport: relativeImportPath(providerOutput, sdkFile),
    }));
    process.stdout.write(`${providerOutput}\n`);
    process.stdout.write(`${sdkFile}\n`);
  }
  if (providerConfigOutput) {
    mkdirSync(dirname(providerConfigOutput), { recursive: true });
    writeFileSync(providerConfigOutput, generateProviderConfig(generated.manifest));
    process.stdout.write(`${providerConfigOutput}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) main();
