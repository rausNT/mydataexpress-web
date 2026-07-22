#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const RULES = [
  { id: 'ole', severity: 'blocking', replacement: 'HTTP/API provider or server-side document service', pattern: /\b(CreateOleObject|GetActiveOleObject|OleVariant|ComObj)\b/gi },
  { id: 'dll', severity: 'blocking', replacement: 'cross-platform service provider', pattern: /\b(LoadLibrary|GetProcAddress|FreeLibrary|RegisterDll|external)\b/gi },
  { id: 'shell', severity: 'blocking', replacement: 'server task provider', pattern: /\b(ShellExecute|WinExec|CreateProcess|cmd\.exe|powershell(?:\.exe)?)\b/gi },
  { id: 'windows-api', severity: 'blocking', replacement: 'portable runtime API', pattern: /\b(WinApi(?:\.\w+)?|HKEY_\w+|TRegistry|SendMessage|PostMessage|GetWindowHandle|HWND)\b/gi },
  { id: 'desktop-ui', severity: 'manual', replacement: 'web form/message API', pattern: /\b(ShowMessage|MessageDlg|InputQuery|OpenDialog|SaveDialog|Screen|Application\.MainForm)\b/gi },
  { id: 'local-files', severity: 'manual', replacement: 'sandboxed file-storage provider', pattern: /\b([A-Z]:\\|\\\\|ExtractFilePath\(ParamStr|GetAppConfigDir|GetTempDir)\b/gi },
  { id: 'office-files', severity: 'manual', replacement: 'server-side DOCX/XLSX/ODS renderer', pattern: /\b(Word\.Application|Excel\.Application|LibreOffice|soffice)\b/gi },
  { id: 'network', severity: 'review', replacement: 'HTTP client with allow-list and timeouts', pattern: /\b(THttpClient|TFPHttpClient|IdHTTP|DownloadFile|HTTPMethod)\b/gi },
];

const MODULE_RE = /\{@module\s+([\s\S]*?)@\}/i;
const FUNCTION_RE = /\{@function\s+([\s\S]*?)@\}/gi;
const ACTION_RE = /\{@?action\s+([\s\S]*?)@\}/gi;
const PROVIDER_CALL_RE = /\bExtensionProviderCall(?:Boolean|Int64|Float|DateTime|Variant)?\s*\(/i;
const EXTENSION_SOURCE_TYPES = new Map([
  ['.epas', 'desktop'],
  ['.wepas', 'web'],
]);

function field(block, name) {
  const match = block.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'im'));
  return match ? match[1].trim() : '';
}

function specifications(source, regex, kind) {
  const result = [];
  for (const match of source.matchAll(regex)) {
    result.push({
      kind,
      name: field(match[1], 'Name'),
      id: field(match[1], 'Id'),
      origName: field(match[1], 'OrigName'),
      args: field(match[1], 'Args'),
      result: field(match[1], 'Result'),
    });
  }
  return result;
}

function sourceKind(filename, specs) {
  const fromExtension = EXTENSION_SOURCE_TYPES.get(extname(filename).toLowerCase());
  if (fromExtension) return fromExtension;
  if (!specs.length) return 'unknown';
  return specs.every(spec => !spec.origName) ? 'web' : 'desktop';
}

function validateSpecifications(specs, kind) {
  const issues = [];
  const add = (index, code, message) => issues.push({
    specification: index,
    kind: specs[index].kind,
    name: specs[index].name,
    id: specs[index].id,
    code,
    message,
  });

  specs.forEach((spec, index) => {
    if (spec.kind === 'function' && !spec.name) {
      add(index, 'function-name-required', 'Function metadata must contain Name');
    }
    if (spec.kind === 'action' && !spec.id) {
      add(index, 'action-id-required', 'Action metadata must contain a stable Id');
    }
    if (kind === 'desktop' && !spec.origName) {
      add(index, 'desktop-origname-required', 'Desktop extension metadata must contain OrigName');
    }
    if (kind === 'web' && spec.origName) {
      add(index, 'web-origname-not-allowed', 'Web extension metadata must not contain OrigName');
    }
  });
  return issues;
}

export function auditSource(source, filename = '<memory>') {
  const header = source.match(MODULE_RE)?.[1] || '';
  const findings = [];
  for (const rule of RULES) {
    const matches = [...source.matchAll(rule.pattern)].map(item => item[0]);
    if (matches.length) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        replacement: rule.replacement,
        occurrences: matches.length,
        examples: [...new Set(matches)].slice(0, 5),
      });
    }
  }

  const specs = [
    ...specifications(source, FUNCTION_RE, 'function'),
    ...specifications(source, ACTION_RE, 'action'),
  ];
  const kind = sourceKind(filename, specs);
  const formatIssues = validateSpecifications(specs, kind);
  const invalidSpecifications = new Set(formatIssues.map(issue => issue.specification));
  const checkedSpecs = specs.map((spec, index) => ({
    ...spec,
    formatValid: !invalidSpecifications.has(index),
  }));
  const blocking = findings.filter(item => item.severity === 'blocking').length;

  return {
    file: filename,
    module: {
      author: field(header, 'Author'),
      version: field(header, 'Version'),
      description: field(header, 'Description'),
    },
    sourceKind: kind,
    moduleType: kind === 'web' ? 'web-or-compatible' : 'desktop-or-unknown',
    providerBacked: PROVIDER_CALL_RE.test(source),
    specifications: checkedSpecs,
    formatIssues,
    compatibility: blocking ? 'requires-provider' : findings.length ? 'review' : 'portable',
    findings,
  };
}

function runtimeKey(spec) {
  if (spec.kind === 'function') return `function:${spec.name.toUpperCase()}`;
  return `action:${spec.id}`;
}

export function buildRuntimeCompatibility(reports) {
  const desktopSpecs = [];
  const webByKey = new Map();
  const orphanWebMappings = [];
  const duplicateWebMappings = [];
  const invalidMappings = [];

  for (const report of reports) {
    for (const spec of report.specifications) {
      const entry = { ...spec, module: report.file, providerBacked: report.providerBacked };
      if (spec.formatValid === false) {
        invalidMappings.push({
          kind: spec.kind,
          name: spec.name,
          id: spec.id,
          module: report.file,
          issues: report.formatIssues
            .filter(issue => issue.specification === report.specifications.indexOf(spec))
            .map(issue => issue.code),
        });
        continue;
      }
      if (report.sourceKind !== 'web') {
        desktopSpecs.push(entry);
        continue;
      }

      const key = runtimeKey(spec);
      const mappings = webByKey.get(key) || [];
      mappings.push(entry);
      webByKey.set(key, mappings);
    }
  }

  const desktopKeys = new Set(desktopSpecs.map(runtimeKey));
  for (const [key, mappings] of webByKey) {
    if (!desktopKeys.has(key)) orphanWebMappings.push(...mappings);
    if (mappings.length > 1) duplicateWebMappings.push({ key, modules: mappings.map(item => item.module) });
  }

  let providerBacked = 0;
  const entries = desktopSpecs.map(spec => {
    const mappings = webByKey.get(runtimeKey(spec)) || [];
    let status = 'missing';
    let webModule = '';
    if (mappings.length > 1) {
      status = 'duplicate-web';
    } else if (mappings.length === 1) {
      webModule = mappings[0].module;
      status = mappings[0].providerBacked ? 'provider' : 'web-script';
      if (status === 'provider') providerBacked++;
    }

    return {
      kind: spec.kind,
      name: spec.name,
      id: spec.id,
      origName: spec.origName,
      desktopModule: spec.module,
      webModule,
      status,
    };
  });

  const functions = entries.filter(item => item.kind === 'function');
  const actions = entries.filter(item => item.kind === 'action');
  const isCompatible = item => item.status === 'provider' || item.status === 'web-script';
  const functionsCompatible = functions.filter(isCompatible).length;
  const actionsCompatible = actions.filter(isCompatible).length;

  return {
    schemaVersion: 1,
    summary: {
      functionsTotal: functions.length,
      functionsCompatible,
      actionsTotal: actions.length,
      actionsCompatible,
      providerBacked,
      duplicateWebMappings: duplicateWebMappings.length,
      orphanWebMappings: orphanWebMappings.length,
      invalidMappings: invalidMappings.length,
      complete: functionsCompatible === functions.length &&
        actionsCompatible === actions.length &&
        duplicateWebMappings.length === 0 && orphanWebMappings.length === 0 &&
        invalidMappings.length === 0,
    },
    functions,
    actions,
    duplicateWebMappings,
    orphanWebMappings,
    invalidMappings,
  };
}

export function collectExtensionFiles(path) {
  const info = statSync(path);
  if (info.isFile()) {
    return ['.epas', '.wepas', '.pas', '.txt', '.dxm'].includes(extname(path).toLowerCase())
      ? [path]
      : [];
  }
  return readdirSync(path).flatMap(name => collectExtensionFiles(join(path, name)));
}

function summary(reports) {
  return {
    files: reports.length,
    portable: reports.filter(item => item.compatibility === 'portable').length,
    review: reports.filter(item => item.compatibility === 'review').length,
    requiresProvider: reports.filter(item => item.compatibility === 'requires-provider').length,
    desktopModules: reports.filter(item => item.sourceKind === 'desktop').length,
    webModules: reports.filter(item => item.sourceKind === 'web').length,
    formatIssues: reports.reduce((count, report) => count + report.formatIssues.length, 0),
    missingWebIds: reports.flatMap(report => report.specifications
      .filter(spec => spec.kind === 'action' && !spec.id)
      .map(spec => ({ file: report.file, name: spec.name }))),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node tools/extension-audit.mjs <file-or-directory> [--output report.json] [--strict]');
    process.exitCode = 2;
    return;
  }
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && !args[outputIndex + 1]) {
    console.error('--output requires a file path');
    process.exitCode = 2;
    return;
  }
  const output = outputIndex >= 0 ? args[outputIndex + 1] : '';
  const input = resolve(args[0]);
  const reports = collectExtensionFiles(input).map(file => auditSource(readFileSync(file, 'utf8'), file));
  const reportSummary = summary(reports);
  const runtimeCompatibility = buildRuntimeCompatibility(reports);
  const mappingsFound = reports.reduce(
    (count, report) => count + report.specifications.length,
    0,
  );
  const strictValidation = {
    filesFound: reports.length > 0,
    mappingsFound: mappingsFound > 0,
    runtimeComplete: runtimeCompatibility.summary.complete,
  };
  strictValidation.passed = Object.values(strictValidation).every(Boolean);
  const result = {
    generatedAt: new Date().toISOString(),
    summary: reportSummary,
    strictValidation,
    runtimeCompatibility,
    modules: reports,
  };
  const json = JSON.stringify(result, null, 2);
  if (output) writeFileSync(resolve(output), json + '\n');
  else process.stdout.write(json + '\n');
  if (args.includes('--strict') && !strictValidation.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) main();
