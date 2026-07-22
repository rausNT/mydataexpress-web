#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource, buildRuntimeCompatibility, collectExtensionFiles } from './extension-audit.mjs';
import { configuredProviderNames, parseProviderConfig } from './provider-config.mjs';
import { preflightProvider } from './provider-preflight.mjs';
import { validateProviderManifest } from './provider-sdk.mjs';

function diagnostic(code, details = {}) {
  return { code, ...details };
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function bundleFile(bundleRoot, reference, errors, code = 'bundle-file-missing') {
  if (typeof reference !== 'string' || !reference.trim()) {
    errors.push(diagnostic('bundle-path-invalid'));
    return '';
  }
  const candidate = resolve(bundleRoot, reference);
  if (!inside(bundleRoot, candidate)) {
    errors.push(diagnostic('bundle-path-escape', { file: reference }));
    return '';
  }
  if (!existsSync(candidate)) {
    errors.push(diagnostic(code, { file: reference }));
    return '';
  }
  if (!statSync(candidate).isFile()) {
    errors.push(diagnostic('bundle-path-not-file', { file: reference }));
    return '';
  }
  const real = realpathSync(candidate);
  if (!inside(realpathSync(bundleRoot), real)) {
    errors.push(diagnostic('bundle-symlink-escape', { file: reference }));
    return '';
  }
  return real;
}

function recursiveFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return recursiveFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function stripJavaScriptComments(source) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const quote = char;
      result += char;
      index++;
      while (index < source.length) {
        result += source[index];
        if (source[index] === '\\') {
          index++;
          if (index < source.length) result += source[index];
        } else if (source[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === '`') {
      result += ' ';
      index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '`') break;
      }
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      if (end < 0) break;
      result += '\n';
      index = end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      result += ' ';
      continue;
    }
    result += char;
    index++;
  }
  return result;
}

function parseImplementationMarkers(source) {
  const result = new Map();
  const pattern = /handlers\[((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\]\.dataExpressImplemented\s*=\s*(true|false)\s*;/g;
  for (const match of stripJavaScriptComments(source).matchAll(pattern)) {
    let operation;
    try {
      operation = match[1][0] === '"'
        ? JSON.parse(match[1])
        : match[1].slice(1, -1).replaceAll("\\'", "'").replaceAll('\\\\', '\\');
    } catch {
      continue;
    }
    result.set(operation, match[2] === 'true');
  }
  return result;
}

function validateManifest(manifest) {
  const handlers = Object.create(null);
  for (const mapping of manifest?.mappings || []) {
    if (mapping?.status === 'provider' && typeof mapping.operation === 'string') {
      handlers[mapping.operation] = () => {};
    }
  }
  return validateProviderManifest(manifest, handlers);
}

function manifestCatalog(bundleRoot, generatedManifestFiles, errors, warnings, allowManual) {
  const discovered = recursiveFiles(bundleRoot)
    .filter(file => file.toLowerCase().endsWith('.manifest.json'));
  const files = [...new Set([...generatedManifestFiles, ...discovered])];
  const byProvider = new Map();
  for (const file of files) {
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const contract = validateManifest(manifest);
      const key = contract.provider.toLowerCase();
      if (byProvider.has(key)) {
        errors.push(diagnostic('provider-manifest-duplicate', { provider: contract.provider }));
        continue;
      }
      if (!contract.complete) {
        const entry = diagnostic('manifest-manual-adaptation', {
          provider: contract.provider,
          operations: contract.manualOperations.map(item => item.operation),
        });
        (allowManual ? warnings : errors).push(entry);
      }
      byProvider.set(key, { file, manifest, contract });
    } catch (error) {
      errors.push(diagnostic('provider-manifest-invalid', {
        file: relative(bundleRoot, file).replaceAll('\\', '/'),
        message: error.message,
      }));
    }
  }
  return byProvider;
}

export async function verifyExtensionBundle({
  bundleRoot,
  configText = null,
  offline = false,
  allowManual = false,
  timeoutMs = 10000,
  fetchImpl = globalThis.fetch,
}) {
  const root = realpathSync(resolve(bundleRoot));
  const errors = [];
  const warnings = [];
  const indexFile = bundleFile(root, 'migration-index.json', errors, 'migration-index-missing');
  if (!indexFile) {
    return { schemaVersion: 1, ok: false, mode: offline ? 'offline' : 'live', errors, warnings };
  }

  let index;
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      mode: offline ? 'offline' : 'live',
      errors: [diagnostic('migration-index-invalid', { message: error.message })],
      warnings,
    };
  }
  if (index.schemaVersion !== 1 || !Array.isArray(index.modules)) {
    errors.push(diagnostic('migration-index-schema-invalid'));
  }

  const generated = [];
  const generatedManifestFiles = [];
  for (const module of Array.isArray(index.modules) ? index.modules : []) {
    bundleFile(root, module.source, errors);
    for (const webModule of module.webModules || []) bundleFile(root, webModule, errors);
    if (!module.generated) continue;
    const webModule = bundleFile(root, module.generated.webModule, errors);
    const manifest = bundleFile(root, module.generated.manifest, errors);
    const provider = bundleFile(root, module.generated.provider, errors);
    bundleFile(root, module.generated.config, errors);
    if (manifest) generatedManifestFiles.push(manifest);
    generated.push({ module, webModule, manifest, provider });
  }
  if (generated.length) bundleFile(root, 'dataexpress-provider-sdk.mjs', errors);

  const manifests = manifestCatalog(root, generatedManifestFiles, errors, warnings, allowManual);
  let pendingHandlers = 0;
  for (const item of generated) {
    if (!item.manifest || !item.provider) continue;
    try {
      const manifest = JSON.parse(readFileSync(item.manifest, 'utf8'));
      const operations = validateManifest(manifest).operations;
      const markers = parseImplementationMarkers(readFileSync(item.provider, 'utf8'));
      const pending = operations.filter(operation => markers.get(operation) !== true);
      if (pending.length) {
        pendingHandlers += pending.length;
        errors.push(diagnostic('provider-handlers-pending', {
          provider: manifest.provider,
          operations: pending,
        }));
      }
    } catch (error) {
      errors.push(diagnostic('provider-scaffold-invalid', {
        file: relative(root, item.provider).replaceAll('\\', '/'),
        message: error.message,
      }));
    }
  }

  let configuration = null;
  let configuredProviders = null;
  if (!offline) {
    configuration = parseProviderConfig(configText || '');
    configuredProviders = configuredProviderNames(configuration);
    errors.push(...configuration.errors.map(item => diagnostic('config-invalid', { detail: item.code })));
    warnings.push(...configuration.warnings.map(item => diagnostic('config-warning', { detail: item.code })));
  }

  const extensionFiles = collectExtensionFiles(root)
    .filter(file => ['.epas', '.wepas'].some(extension => file.toLowerCase().endsWith(extension)));
  const reports = extensionFiles.map(file => auditSource(readFileSync(file, 'utf8'), file));
  const runtimeCompatibility = buildRuntimeCompatibility(reports, { configuredProviders });
  if (!runtimeCompatibility.summary.complete) {
    errors.push(diagnostic('extension-runtime-incomplete'));
  }

  const providerNames = [...new Set(reports.flatMap(report => report.providers))];
  const providerReports = [];
  if (offline) {
    if (providerNames.length) {
      warnings.push(diagnostic('provider-live-check-skipped', { providers: providerNames }));
    }
  } else {
    for (const providerName of providerNames) {
      const entry = manifests.get(providerName.toLowerCase());
      if (!entry) {
        errors.push(diagnostic('provider-manifest-missing', { provider: providerName }));
        continue;
      }
      const report = await preflightProvider({
        manifest: entry.manifest,
        configText,
        fetchImpl,
        allowManual,
        timeoutMs,
      });
      providerReports.push(report);
      if (!report.ok) errors.push(diagnostic('provider-preflight-failed', { provider: providerName }));
    }
  }
  for (const { contract } of manifests.values()) {
    if (!providerNames.some(name => name.toLowerCase() === contract.provider.toLowerCase())) {
      warnings.push(diagnostic('provider-manifest-unused', { provider: contract.provider }));
    }
  }

  const ok = errors.length === 0;
  return {
    schemaVersion: 1,
    ok,
    mode: offline ? 'offline' : 'live',
    summary: {
      modules: index.modules?.length || 0,
      extensionFiles: extensionFiles.length,
      manifests: manifests.size,
      providersReferenced: providerNames.length,
      providersChecked: providerReports.length,
      pendingHandlers,
      runtimeComplete: runtimeCompatibility.summary.complete,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
    runtimeCompatibility,
    providers: providerReports,
  };
}

function usage() {
  return 'Usage: node tools/extension-bundle-verify.mjs <bundle-directory> (--config <dxwebsrv.cfg> | --offline) [--allow-manual] [--timeout <ms>]';
}

async function main(argv) {
  const bundleRoot = argv[0];
  const configIndex = argv.indexOf('--config');
  const offline = argv.includes('--offline');
  if (!bundleRoot || (configIndex < 0 && !offline) || (configIndex >= 0 && offline) ||
      (configIndex >= 0 && !argv[configIndex + 1])) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const timeoutIndex = argv.indexOf('--timeout');
  const timeoutMs = timeoutIndex < 0 ? 10000 : Number(argv[timeoutIndex + 1]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    console.error('--timeout must be an integer between 1 and 300000');
    process.exitCode = 2;
    return;
  }
  try {
    const configText = configIndex < 0 ? null : readFileSync(resolve(argv[configIndex + 1]), 'utf8');
    const report = await verifyExtensionBundle({
      bundleRoot,
      configText,
      offline,
      allowManual: argv.includes('--allow-manual'),
      timeoutMs,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      errors: [diagnostic('bundle-input-error', { message: error.message })],
    }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}
