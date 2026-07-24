#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource } from './extension-audit.mjs';
import {
  detectExtensionCapability,
  normalizedPascalType,
  parameterWireAdapter,
  resultWireAdapter,
} from './extension-capabilities.mjs';
import {
  generateProviderConfig,
  generateProviderEnvironment,
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

function identifierSkeleton(value) {
  const homoglyphs = new Map(Object.entries({
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h',
    о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y',
  }));
  return [...value.toLowerCase()]
    .map(character => homoglyphs.get(character) || character)
    .join('');
}

function commonPrefixRatio(left, right) {
  left = identifierSkeleton(left);
  right = identifierSkeleton(right);
  let length = 0;
  while (length < left.length && length < right.length &&
      left[length] === right[length]) length++;
  return length / Math.max(1, Math.min(left.length, right.length));
}

function declarationRange(source, spec) {
  if (!spec.origName) return '';
  // Desktop metadata uses {@function ... @} for expression functions and
  // procedures alike (an empty Result means a procedure).
  const allowedKinds = new Set(['function', 'procedure']);
  const firstMetadata = source.search(/\{@(?:module|function|action)\b/i);
  const forumWrapped = firstMetadata > 0 &&
    /\[(?:\/?code|\/?b|\/?i)\]/i.test(source.slice(0, firstMetadata));
  const tokens = pascalTokens(source, forumWrapped ? firstMetadata : 0);
  const candidates = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    if (!allowedKinds.has(tokens[index].lower)) continue;
    const name = tokens[index + 1].value;
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    candidates.push({
      kind: tokens[index].lower,
      name,
      index: tokens[index].start,
    });
  }
  const declaredNames = [spec.origName];
  if (spec.kind === 'function' && spec.name) declaredNames.push(spec.name);
  let match = candidates.find(candidate =>
    declaredNames.some(name => candidate.name.toLowerCase() === name.toLowerCase()));
  let normalizedMatch = false;
  let metadataFallback = false;
  if (!match) {
    const normalized = candidates.filter(candidate =>
      declaredNames.some(name =>
        identifierSkeleton(candidate.name) === identifierSkeleton(name)));
    if (normalized.length === 1) {
      [match] = normalized;
      normalizedMatch = true;
    }
  }
  if (!match) {
    const escapedName = spec.origName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const field = new RegExp(`(?:^|\\r?\\n)\\s*OrigName\\s*=\\s*${escapedName}\\s*(?:\\r?\\n|$)`, 'i');
    const fieldMatch = field.exec(source);
    if (fieldMatch) {
      const blockEnd = source.indexOf('@}', fieldMatch.index + fieldMatch[0].length);
      const nextBlock = blockEnd >= 0 ? source.indexOf('{@', blockEnd + 2) : -1;
      const nearby = blockEnd >= 0
        ? candidates.filter(candidate =>
          candidate.index > blockEnd && (nextBlock < 0 || candidate.index < nextBlock) &&
          commonPrefixRatio(candidate.name, spec.origName) >= 0.75)
        : [];
      if (nearby.length === 1) {
        [match] = nearby;
        metadataFallback = true;
      }
    }
  }
  if (!match) return '';
  let depth = 0;
  for (let index = match.index; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth = Math.max(0, depth - 1);
    else if (source[index] === ';' && depth === 0) {
      return {
        kind: match.kind,
        matchedName: match.name,
        normalizedMatch,
        metadataFallback,
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
          kind: range.kind,
          matchedName: range.matchedName,
          normalizedMatch: range.normalizedMatch,
          metadataFallback: range.metadataFallback,
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
  abs ansichar ansistring arctan assigned boolean byte cardinal char chr comp
  copy cos currency date datetime dayof decodedate decodetime double encodedate
  encodetime ercustomerror exp extended false floattostr format frac high inc int64 integer
  inttostr length ln longint longword low lowercase max min nativeint nativeuint
  now null ord pi pos pred qword raiseexception real round self session setlength shortint sin
  single sizeof smallint sqrt string stringreplace strtofloat succ time tdate
  tdatetime trim trunc true ttime trystrtofloat trystrtoint trystrtoint64
  uppercase unicodestring variant widechar widestring word evalexpr sqlselect
  sqlexecute
`.trim().toLowerCase().split(/\s+/));

function registeredRuntimeIdentifiers() {
  const globals = new Set();
  const members = new Set();
  let source = '';
  try {
    source = readFileSync(new URL('../compilerdecls.pas', import.meta.url), 'utf8');
  } catch {
    return { globals, members };
  }
  source = source
    .replace(/\{[\s\S]*?\}/g, ' ')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  const globalPatterns = [
    /\bAddClassN\([\s\S]*?,\s*'([A-Za-z_]\w*)'\s*\)/gi,
    /\bAddTypeS\(\s*'([A-Za-z_]\w*)'/gi,
    /\bAddConstantN\(\s*'([A-Za-z_]\w*)'/gi,
    /\bAddDelphiFunction\(\s*'(?:function|procedure)\s+([A-Za-z_]\w*)/gi,
  ];
  const memberPatterns = [
    /\bRegisterMethod\(\s*'(?:constructor|destructor|function|procedure)\s+([A-Za-z_]\w*)/gi,
    /\bRegisterProperty\(\s*'([A-Za-z_]\w*)'/gi,
  ];
  for (const pattern of globalPatterns) {
    for (const match of source.matchAll(pattern)) globals.add(match[1].toLowerCase());
  }
  for (const pattern of memberPatterns) {
    for (const match of source.matchAll(pattern)) members.add(match[1].toLowerCase());
  }
  for (const match of source.matchAll(/\bAddTypeS\(\s*'[A-Za-z_]\w*'\s*,\s*'([^']*)'/gi)) {
    for (const token of match[1].matchAll(/[A-Za-z_]\w*/g)) {
      globals.add(token[0].toLowerCase());
    }
  }
  return { globals, members };
}

const registeredRuntime = registeredRuntimeIdentifiers();
for (const identifier of registeredRuntime.globals) {
  portableIdentifiers.add(identifier);
}

function localVariableNames(preamble) {
  const varStart = preamble.search(/\bvar\b/i);
  if (varStart < 0) return [];
  const declarations = preamble.slice(varStart + 3);
  const names = [];
  for (const match of declarations.matchAll(/(?:^|;)\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:/gm)) {
    names.push(...match[1].split(',').map(name => name.trim().toLowerCase()));
  }
  return names;
}

function nextNonWhitespace(source, index) {
  while (/\s/.test(source[index] || '')) index++;
  return source[index] || '';
}

function previousNonWhitespace(source, index) {
  index--;
  while (index >= 0 && /\s/.test(source[index])) index--;
  return source[index] || '';
}

function inlineRoutineAnalysis(implementation, params, routineName, routineNames = new Set()) {
  if (!implementation.source) {
    return { portable: false, issues: [implementation.reason], reviews: [], dependencies: [] };
  }
  const findings = auditSource(implementation.source, '<routine>').findings;
  const issues = findings
    .filter(item => item.severity !== 'review')
    .map(item => `platform-dependency:${item.rule}`);
  const reviews = findings
    .filter(item => item.severity === 'review')
    .map(item => `review:${item.rule}`);
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
    ...[...implementation.body.matchAll(/\bon\s+([A-Za-z_]\w*)\s*:/gi)]
      .map(match => match[1].toLowerCase()),
  ]);
  const dependencies = new Set();
  const implementationText = `${implementation.preamble}\n${implementation.body}`;
  for (const token of pascalTokens(implementationText)) {
    if (previousNonWhitespace(implementationText, token.start) === '.' &&
        registeredRuntime.members.has(token.lower)) continue;
    if (routineNames.has(token.lower) && token.lower !== routineName.toLowerCase() &&
        nextNonWhitespace(implementationText, token.end) === '(' &&
        previousNonWhitespace(implementationText, token.start) !== '.') {
      dependencies.add(token.lower);
      continue;
    }
    if (!allowed.has(token.lower)) issues.push(`external-dependency:${token.value}`);
  }
  return {
    portable: issues.length === 0,
    issues: [...new Set(issues)],
    reviews: [...new Set(reviews)],
    dependencies: [...dependencies],
  };
}

function routineCatalog(source) {
  const result = new Map();
  const firstMetadata = source.search(/\{@(?:module|function|action)\b/i);
  const forumWrapped = firstMetadata > 0 &&
    /\[(?:\/?code|\/?b|\/?i)\]/i.test(source.slice(0, firstMetadata));
  const tokens = pascalTokens(source, forumWrapped ? firstMetadata : 0);
  for (let index = 0; index < tokens.length - 1; index++) {
    const kind = tokens[index].lower;
    if (!['function', 'procedure'].includes(kind)) continue;
    const name = tokens[index + 1].value;
    if (!/^[A-Za-z_]\w*$/.test(name) || result.has(name.toLowerCase())) continue;
    const implementation = routineImplementation(source, { kind, origName: name });
    if (!implementation.source) continue;
    result.set(name.toLowerCase(), {
      name,
      kind,
      implementation,
      params: parameters(implementation.declaration),
    });
  }
  return result;
}

function inlineClosure(catalog, rootName) {
  const routineNames = new Set(catalog.keys());
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  const issues = [];
  const reviews = [];

  function visit(name) {
    const lower = name.toLowerCase();
    if (visited.has(lower)) return;
    if (visiting.has(lower)) {
      issues.push(`recursive-routine-cycle:${name}`);
      return;
    }
    const routine = catalog.get(lower);
    if (!routine) {
      issues.push(`routine-not-found:${name}`);
      return;
    }
    visiting.add(lower);
    const analysis = inlineRoutineAnalysis(
      routine.implementation,
      routine.params,
      routine.name,
      routineNames,
    );
    issues.push(...analysis.issues.map(issue => `${routine.name}:${issue}`));
    reviews.push(...analysis.reviews.map(review => `${routine.name}:${review}`));
    for (const dependency of analysis.dependencies) visit(dependency);
    visiting.delete(lower);
    visited.add(lower);
    order.push(lower);
  }

  visit(rootName);
  return {
    portable: issues.length === 0,
    issues: [...new Set(issues)],
    reviews: [...new Set(reviews)],
    order,
  };
}

function rewriteWebPascal(source) {
  const replacements = new Map([
    ['evalexpr', 'Session.EvalExpr'],
    ['sqlselect', 'Session.SQLSelect'],
    ['sqlexecute', 'Session.SQLExecute'],
  ]);
  let result = source;
  const edits = [];
  for (const token of pascalTokens(source)) {
    const replacement = replacements.get(token.lower);
    if (!replacement) continue;
    if (previousNonWhitespace(source, token.start) === '.') continue;
    if (nextNonWhitespace(source, token.end) !== '(') continue;
    edits.push({ start: token.start, end: token.end, replacement });
  }
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
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
    const encoder = parameterWireAdapter(parameter).encoder || 'ExtensionProviderEncodeValue';
    result.push(`  ProviderPayload := ProviderPayload + '${prefix}"${parameter.name}":' + ${encoder}(${parameter.name});`);
  });
  result.push("  ProviderPayload := ProviderPayload + '}';");
  return result;
}

function resultType(decl) {
  return decl.match(/:\s*([\w.]+)\s*;$/i)?.[1]?.toLowerCase() || '';
}

function normalizedType(type) {
  return normalizedPascalType(type);
}

function supportedParameter(parameter) {
  return parameterWireAdapter(parameter).issue;
}

function supportedInlineType(type, label) {
  const unknown = pascalTokens(type)
    .map(token => token.lower)
    .filter(token => !pascalKeywords.has(token) && !portableIdentifiers.has(token));
  return unknown.length ? `unsupported-inline-type:${label}:${type || 'unknown'}` : '';
}

function resultAdapter(type) {
  return resultWireAdapter(type);
}

function httpRequestActionLines(moduleName, operation, decl, recipe) {
  const method = recipe.methodParameter;
  const url = recipe.urlParameter;
  const authType = recipe.authTypeParameter;
  const authValue = recipe.authValueParameter;
  const contentType = recipe.contentTypeParameter;
  const headers = recipe.headersParameter;
  const params = recipe.paramsParameter;
  return [
    decl,
    'var',
    '  Method, Url, AuthType, AuthValue, ContentType: String;',
    '  ProviderPayload, ProviderResponse, ProviderSeparator: String;',
    '  HeaderName, HeaderValue, ParamName, ParamValue: String;',
    '  i: Integer;',
    'begin',
    `  Method := UpperCase(${method});`,
    `  Url := VarToStr(Session.EvalExpr(${url}, Self));`,
    `  AuthType := ${authType};`,
    `  AuthValue := VarToStr(Session.EvalExpr(${authValue}, Self));`,
    `  ContentType := ${contentType};`,
    '  if Url = \'\' then Exit;',
    '  ProviderPayload := \'{"Method":\' + ExtensionProviderEncodeValue(Method) +',
    '    \',"URL":\' + ExtensionProviderEncodeValue(Url) + \',"Headers":[\';',
    '  ProviderSeparator := \'\';',
    '  HeaderName := \'Content-Type\';',
    '  HeaderValue := ContentType;',
    '  ProviderPayload := ProviderPayload + \'{"name":\' + ExtensionProviderEncodeValue(HeaderName) +',
    '    \',"value":\' + ExtensionProviderEncodeValue(HeaderValue) + \'}\';',
    '  ProviderSeparator := \',\';',
    '  case AuthType of',
    '    \'Basic Auth\': begin HeaderName := \'Authorization\'; HeaderValue := \'Basic \' + EncodeBase64(AuthValue); end;',
    '    \'Bearer Token\': begin HeaderName := \'Authorization\'; HeaderValue := \'Bearer \' + AuthValue; end;',
    '    \'API Key\': begin HeaderName := \'X-API-Key\'; HeaderValue := AuthValue; end;',
    '    \'DaData Token\': begin HeaderName := \'Authorization\'; HeaderValue := \'Token \' + AuthValue; end;',
    '  else',
    '    HeaderName := \'\';',
    '  end;',
    '  if HeaderName <> \'\' then',
    '    ProviderPayload := ProviderPayload + ProviderSeparator + \'{"name":\' +',
    '      ExtensionProviderEncodeValue(HeaderName) + \',"value":\' +',
    '      ExtensionProviderEncodeValue(HeaderValue) + \'}\';',
    `  for i := Low(${headers}) to High(${headers}) do`,
    '  begin',
    `    HeaderName := VarToStr(Session.EvalExpr(${headers}[i][0], Self));`,
    `    HeaderValue := VarToStr(Session.EvalExpr(${headers}[i][1], Self));`,
    '    ProviderPayload := ProviderPayload + ProviderSeparator + \'{"name":\' +',
    '      ExtensionProviderEncodeValue(HeaderName) + \',"value":\' +',
    '      ExtensionProviderEncodeValue(HeaderValue) + \'}\';',
    '  end;',
    '  ProviderPayload := ProviderPayload + \'],"Params":[\';',
    '  ProviderSeparator := \'\';',
    `  for i := Low(${params}) to High(${params}) do`,
    '  begin',
    `    ParamName := VarToStr(Session.EvalExpr(${params}[i][0], Self));`,
    `    ParamValue := VarToStr(Session.EvalExpr(${params}[i][1], Self));`,
    '    ProviderPayload := ProviderPayload + ProviderSeparator + \'{"name":\' +',
    '      ExtensionProviderEncodeValue(ParamName) + \',"value":\' +',
    '      ExtensionProviderEncodeValue(ParamValue) + \'}\';',
    '    ProviderSeparator := \',\';',
    '  end;',
    '  ProviderPayload := ProviderPayload + \']}\';',
    `  ProviderResponse := ExtensionProviderCall(${pascalString(moduleName)}, ${pascalString(operation)}, ProviderPayload);`,
    '  Session.SetExprVar(\'request_result\', ProviderResponse);',
    'end;',
  ];
}

export function generateWebModule(source, filename = 'Extension.epas', { forceProvider = false } = {}) {
  const report = auditSource(source, filename);
  const moduleName = basename(filename, extname(filename));
  const specs = report.specifications.filter(spec => spec.name || spec.id);
  const catalog = routineCatalog(source);
  const exportedRoutineNames = new Set(specs
    .map(spec => spec.origName?.toLowerCase())
    .filter(Boolean));
  const emittedHelpers = new Set();
  const lines = [
    '{@module',
    `Author=${report.module.author || 'DataExpress migration tool'}`,
    `Version=${report.module.version || '1.0'}-web`,
    `Description=Generated portable web module for ${moduleName}. Review migration manifest before production use.`,
    '@}',
    '',
  ];
  const mappings = [];

  for (const spec of specs) {
    const mappingHeader = spec.kind === 'function'
      ? ['{@function', `Name=${spec.name}`, '@}', '']
      : ['{@action', `Id=${spec.id}`, '@}', ''];

    const implementation = routineImplementation(source, spec);
    const decl = implementation.declaration || declaration(source, spec);
    if (!decl) {
      lines.push(...mappingHeader);
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
    const routineName = implementation.matchedName || spec.origName || operation;
    const identifierDiagnostics = implementation.normalizedMatch
      ? [`identifier-homoglyph-normalized:${spec.origName}->${routineName}`]
      : implementation.metadataFallback
        ? [`metadata-routine-name-resolved:${spec.origName}->${routineName}`]
        : [];
    const params = parameters(decl);
    const routineKind = implementation.kind || (spec.kind === 'function' ? 'function' : 'procedure');
    const type = routineKind === 'function' ? resultType(decl) : '';
    const adapter = routineKind === 'function' ? resultAdapter(type) : 'ExtensionProviderCall';
    const signatureIssues = params.map(supportedParameter).filter(Boolean);
    if (routineKind === 'function' && !adapter) {
      signatureIssues.push(`unsupported-result-type:${type || 'unknown'}`);
    }
    const inlineSignatureIssues = params
      .map(parameter => supportedInlineType(parameter.type, parameter.name))
      .filter(Boolean);
    if (routineKind === 'function') {
      const inlineResultIssue = supportedInlineType(type, 'result');
      if (inlineResultIssue) inlineSignatureIssues.push(inlineResultIssue);
    }
    const inline = forceProvider
      ? { portable: false, issues: ['provider-forced'], reviews: [], order: [] }
      : inlineClosure(catalog, routineName);
    const recipe = detectExtensionCapability({
      spec,
      operation,
      params,
      type,
      inline,
      report,
      source,
    });
    if (inline.portable && inlineSignatureIssues.length === 0 && !recipe) {
      for (const helperName of inline.order) {
        if (helperName === routineName.toLowerCase() ||
            exportedRoutineNames.has(helperName) || emittedHelpers.has(helperName)) continue;
        lines.push(rewriteWebPascal(catalog.get(helperName).implementation.source), '');
        emittedHelpers.add(helperName);
      }
      lines.push(...mappingHeader);
      lines.push(rewriteWebPascal(implementation.source), '');
      mappings.push({
        kind: spec.kind,
        name: spec.name,
        id: spec.id,
        origName: spec.origName,
        args: spec.args,
        result: spec.result,
        resultType: type,
        routineKind,
        parameters: params,
        operation,
        status: 'web-script',
        reason: '',
        issues: [...identifierDiagnostics, ...inline.reviews],
        reviewRequired: inline.reviews.length > 0,
        wireFormat: 'pascal-script',
      });
      continue;
    }
    const issues = [...signatureIssues];
    const wireable = Boolean(recipe) || issues.length === 0;

    lines.push(...mappingHeader);
    if (recipe?.kind === 'http-request' &&
        recipe.contract === 'send-http-request-action-v1') {
      lines.push(...httpRequestActionLines(moduleName, operation, decl, recipe), '');
    } else {
      lines.push(decl);
    }
    if (wireable) {
      if (recipe?.kind === 'http-request' &&
          recipe.contract === 'send-http-request-action-v1') {
        // The action requires local expression/grid evaluation before calling
        // the provider, so its complete body was emitted above.
      } else {
        if (recipe?.kind === 'dadata-suggest') {
          lines.push(
            'var',
            '  ProviderPayload, ProviderResponse: String;',
            '  ProviderState, ProviderVariables, ProviderEntry, ProviderName, ProviderValue: TJSONData;',
            '  ProviderIndex: Integer;',
            'begin',
          );
        } else {
          lines.push('var', routineKind === 'procedure'
            ? '  ProviderPayload, ProviderResponse: String;'
            : '  ProviderPayload: String;', 'begin');
        }
        lines.push(...payloadLines(params));
        const call = `${adapter}(${pascalString(moduleName)}, ${pascalString(operation)}, ProviderPayload)`;
        if (recipe?.kind === 'dadata-suggest') {
          lines.push(
            `  ProviderResponse := ${call};`,
            '  ProviderState := ReadJSONFromString(ProviderResponse);',
            '  try',
            "    ProviderVariables := ProviderState.FindPath('variables');",
            '    if ProviderVariables <> nil then',
            '      for ProviderIndex := 0 to ProviderVariables.Count - 1 do',
            '      begin',
            '        ProviderEntry := ProviderVariables.Items[ProviderIndex];',
            "        ProviderName := ProviderEntry.FindPath('name');",
            "        ProviderValue := ProviderEntry.FindPath('value');",
            '        if (ProviderName <> nil) and (ProviderValue <> nil) then',
            '          Session.SetExprVar(ProviderName.AsString, ProviderValue.Value);',
            '      end;',
            "    ProviderValue := ProviderState.FindPath('value');",
            "    if ProviderValue = nil then Result := ''",
            '    else Result := ProviderValue.AsString;',
            '  finally',
            '    ProviderState.Free;',
            '  end;',
          );
        } else if (routineKind === 'function') lines.push(`  Result := ${call};`);
        else lines.push(`  ProviderResponse := ${call};`);
      }
    } else {
      lines.push('begin', `  { TODO: manual provider adapter required: ${issues.join(', ')}. }`);
    }
    if (!(recipe?.kind === 'http-request' &&
        recipe.contract === 'send-http-request-action-v1')) {
      lines.push('end;', '');
    }
    mappings.push({
      kind: spec.kind,
      name: spec.name,
      id: spec.id,
      origName: spec.origName,
      args: spec.args,
      result: spec.result,
      resultType: type,
      routineKind,
      parameters: params,
      operation,
      status: wireable ? 'provider' : 'manual',
      providerReady: Boolean(recipe),
      reason: recipe ? '' : wireable ? 'capability-unresolved' : issues[0],
      issues: wireable
        ? [...identifierDiagnostics, ...inline.issues, ...inline.reviews, ...inlineSignatureIssues]
        : [...identifierDiagnostics, ...inline.issues, ...inline.reviews, ...inlineSignatureIssues, ...issues],
      reviewRequired: false,
      wireFormat: recipe?.kind === 'dadata-suggest'
        ? 'json-state-v1'
        : recipe?.kind === 'http-request'
          ? 'json-http-request-v1'
          : 'json-v1',
      ...(recipe ? { providerRecipe: recipe } : {}),
    });
  }

  const provider = mappings.filter(item => item.status === 'provider').length;
  const automatedProvider = mappings.filter(item => item.providerRecipe).length;
  const pendingProvider = mappings.filter(item =>
    item.status === 'provider' && !item.providerReady).length;
  const webScript = mappings.filter(item => item.status === 'web-script').length;
  const reviewRequired = mappings.filter(item => item.reviewRequired).length;
  const compatible = automatedProvider + webScript;
  const manual = mappings.filter(item => item.status === 'manual').length;
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
      automatedProvider,
      pendingProvider,
      reviewRequired,
      manual,
      complete: manual === 0 && pendingProvider === 0,
    },
    mappings,
  };

  return { module: lines.join('\n'), report, manifest };
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('Usage: node tools/extension-migrate.mjs <extension.epas> [--output extension.wepas] [--manifest extension.manifest.json] [--provider-output extension.provider.mjs] [--provider-config extension.provider.cfg.example] [--provider-env extension.provider.env.example] [--all-providers] [--no-provider] [--no-manifest]');
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
  const providerEnvironmentIndex = args.indexOf('--provider-env');
  if (providerEnvironmentIndex >= 0 && !args[providerEnvironmentIndex + 1]) {
    console.error('--provider-env requires a file path');
    process.exitCode = 2;
    return;
  }
  if (!manifestOutput &&
      (providerIndex >= 0 || providerConfigIndex >= 0 || providerEnvironmentIndex >= 0)) {
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
  const providerEnvironmentOutput = providerOutput && !args.includes('--no-provider-env')
    ? resolve(providerEnvironmentIndex >= 0
      ? args[providerEnvironmentIndex + 1]
      : `${manifestBase}.provider.env.example`)
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
  if (providerEnvironmentOutput) {
    mkdirSync(dirname(providerEnvironmentOutput), { recursive: true });
    writeFileSync(providerEnvironmentOutput, generateProviderEnvironment(generated.manifest));
    process.stdout.write(`${providerEnvironmentOutput}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) main();
