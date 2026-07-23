#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource, buildRuntimeCompatibility, collectExtensionFiles } from './extension-audit.mjs';
import { generateWebModule } from './extension-migrate.mjs';
import {
  generateProviderConfig,
  generateProviderScaffold,
  installProviderSdk,
} from './extension-provider-scaffold.mjs';

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function importPath(fromFile, toFile) {
  let value = portablePath(relative(dirname(fromFile), toFile));
  if (!value.startsWith('.')) value = `./${value}`;
  return value;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function mappingKey(spec) {
  return spec.kind === 'function'
    ? `function:${spec.name.toUpperCase()}`
    : `action:${spec.id}`;
}

function ensureSeparateOutput(inputRoot, outputRoot) {
  const relation = relative(inputRoot, outputRoot);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw new Error('Output directory must be outside the source directory');
  }
}

function classifyDesktopModules(desktopReports, compatibility, duplicateDesktopFiles) {
  const entries = [...compatibility.functions, ...compatibility.actions];
  return desktopReports.map(report => {
    const moduleEntries = entries.filter(item => item.desktopModule === report.file);
    if (duplicateDesktopFiles.has(report.file)) {
      return { report, state: 'blocked', reason: 'duplicate-desktop-mapping', ready: false };
    }
    if (report.formatIssues.length) {
      return { report, state: 'blocked', reason: 'invalid-desktop-metadata', ready: false };
    }
    if (!moduleEntries.length) {
      return { report, state: 'blocked', reason: 'no-extension-specifications', ready: false };
    }
    if (moduleEntries.some(item => item.status === 'duplicate-web')) {
      return { report, state: 'blocked', reason: 'duplicate-web-mapping', ready: false };
    }
    const covered = moduleEntries.filter(item => item.status !== 'missing');
    if (covered.length === 0) return { report, state: 'generate', reason: '', ready: true };
    if (covered.length !== moduleEntries.length) {
      return { report, state: 'blocked', reason: 'partial-web-coverage', ready: false };
    }
    const hasProvider = moduleEntries.some(item => item.status.startsWith('provider'));
    const ready = moduleEntries.every(item => item.status === 'web-script');
    return {
      report,
      state: 'preserve',
      reason: ready ? '' : hasProvider
        ? 'provider-preflight-required'
        : 'existing-web-module-needs-review',
      ready,
      webModules: [...new Set(moduleEntries.map(item => item.webModule).filter(Boolean))],
      providers: [...new Set(moduleEntries.flatMap(item => item.providers))],
    };
  });
}

export function buildBatchMigrationPlan(inputRoot, { forceProvider = false } = {}) {
  const files = collectExtensionFiles(inputRoot)
    .filter(file => ['.epas', '.wepas'].includes(extname(file).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
  const reports = files.map(file => auditSource(readFileSync(file, 'utf8'), file));
  const desktopReports = reports.filter(report => report.sourceKind === 'desktop');
  const webReports = reports.filter(report => report.sourceKind === 'web');
  const compatibility = buildRuntimeCompatibility(reports);

  const desktopKeys = new Map();
  for (const report of desktopReports) {
    for (const spec of report.specifications.filter(item => item.formatValid)) {
      const key = mappingKey(spec);
      const owners = desktopKeys.get(key) || new Set();
      owners.add(report.file);
      desktopKeys.set(key, owners);
    }
  }
  const duplicateDesktopFiles = new Set([...desktopKeys.values()]
    .filter(owners => owners.size > 1)
    .flatMap(owners => [...owners]));
  const modules = classifyDesktopModules(desktopReports, compatibility, duplicateDesktopFiles);

  const providerOwners = new Map();
  for (const item of modules.filter(module => module.state === 'generate')) {
    item.providerRequired = generateWebModule(
      readFileSync(item.report.file, 'utf8'),
      item.report.file,
      { forceProvider },
    ).manifest.mappings.some(mapping => mapping.status === 'provider');
    if (!item.providerRequired) continue;
    const provider = basename(item.report.file, extname(item.report.file)).toLowerCase();
    const owners = providerOwners.get(provider) || [];
    owners.push(item);
    providerOwners.set(provider, owners);
  }
  for (const owners of providerOwners.values()) {
    if (owners.length < 2) continue;
    for (const item of owners) {
      item.state = 'blocked';
      item.reason = 'duplicate-provider-name';
      item.ready = false;
    }
  }

  const webFiles = new Set(webReports.map(report => report.file.toLowerCase()));
  for (const item of modules.filter(module => module.state === 'generate')) {
    const expectedWeb = item.report.file.slice(0, -extname(item.report.file).length) + '.wepas';
    if (webFiles.has(expectedWeb.toLowerCase())) {
      item.state = 'blocked';
      item.reason = 'output-web-module-collision';
      item.ready = false;
    }
  }

  return { files, reports, desktopReports, webReports, compatibility, modules };
}

export function writeBatchMigration(inputRoot, outputRoot, {
  startPort = 9081,
  forceProvider = false,
} = {}) {
  const plan = buildBatchMigrationPlan(inputRoot, { forceProvider });
  if (!plan.desktopReports.length) throw new Error('No .epas extension modules found');
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    throw new Error('Output directory must be empty');
  }
  mkdirSync(outputRoot, { recursive: true });

  for (const source of plan.files) {
    const destination = resolve(outputRoot, relative(inputRoot, source));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  const generatedModules = plan.modules.filter(item => item.state === 'generate');
  let sdkFile = '';
  const configs = [];
  let manualMappings = 0;
  let providerImplementationsRequired = 0;
  let inlineMappings = 0;
  let providerPortIndex = 0;
  generatedModules.forEach(item => {
    const sourceRelative = relative(inputRoot, item.report.file);
    const webRelative = sourceRelative.slice(0, -extname(sourceRelative).length) + '.wepas';
    const webFile = resolve(outputRoot, webRelative);
    const base = webFile.slice(0, -extname(webFile).length);
    const manifestFile = `${base}.manifest.json`;
    const providerFile = `${base}.provider.mjs`;
    const configFile = `${base}.provider.cfg.example`;
    const source = readFileSync(item.report.file, 'utf8');
    const generated = generateWebModule(source, item.report.file, { forceProvider });
    generated.manifest.webModule = basename(webFile);
    manualMappings += generated.manifest.summary.manual;
    inlineMappings += generated.manifest.summary.webScript;
    const implementationOperations = generated.manifest.mappings
      .filter(mapping => mapping.status === 'provider')
      .map(mapping => mapping.operation);
    providerImplementationsRequired += implementationOperations.length;

    mkdirSync(dirname(webFile), { recursive: true });
    writeFileSync(webFile, generated.module + '\n');
    writeFileSync(manifestFile, JSON.stringify(generated.manifest, null, 2) + '\n');

    item.generated = {
      webModule: portablePath(relative(outputRoot, webFile)),
      manifest: portablePath(relative(outputRoot, manifestFile)),
      complete: generated.manifest.summary.complete,
      inlineMappings: generated.manifest.summary.webScript,
      manualMappings: generated.manifest.summary.manual,
      implementationOperations,
    };
    if (implementationOperations.length) {
      const port = startPort + providerPortIndex++;
      if (port > 65535) throw new Error('Provider port range exceeds 65535');
      if (!sdkFile) sdkFile = installProviderSdk(outputRoot);
      writeFileSync(providerFile, generateProviderScaffold(generated.manifest, {
        manifestImport: importPath(providerFile, manifestFile),
        sdkImport: importPath(providerFile, sdkFile),
        port,
      }));
      const config = generateProviderConfig(generated.manifest, {
        url: `http://127.0.0.1:${port}/`,
      });
      writeFileSync(configFile, config);
      configs.push(config.trim());
      Object.assign(item.generated, {
        provider: portablePath(relative(outputRoot, providerFile)),
        config: portablePath(relative(outputRoot, configFile)),
        port,
      });
    }
    item.ready = generated.manifest.summary.complete && implementationOperations.length === 0;
    item.reason = !generated.manifest.summary.complete
      ? 'manual-adaptation-required'
      : implementationOperations.length
        ? 'provider-implementation-required'
        : '';
  });

  const blocked = plan.modules.filter(item => item.state === 'blocked').length;
  const existingNeedsReview = plan.modules.filter(item => item.state === 'preserve' && !item.ready).length;
  const globalIssues = plan.compatibility.orphanWebMappings.length +
    plan.compatibility.invalidMappings.length;
  const complete = blocked === 0 && existingNeedsReview === 0 && manualMappings === 0 &&
    providerImplementationsRequired === 0 && globalIssues === 0;
  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      desktopModules: plan.desktopReports.length,
      webModules: plan.webReports.length,
      generated: generatedModules.length,
      preserved: plan.modules.filter(item => item.state === 'preserve').length,
      blocked,
      existingNeedsReview,
      manualMappings,
      inlineMappings,
      providerImplementationsRequired,
      orphanWebMappings: plan.compatibility.orphanWebMappings.length,
      invalidMappings: plan.compatibility.invalidMappings.length,
      complete,
    },
    modules: plan.modules.map(item => ({
      source: portablePath(relative(inputRoot, item.report.file)),
      state: item.state,
      ready: item.ready,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.webModules ? { webModules: item.webModules.map(file => portablePath(relative(inputRoot, file))) } : {}),
      ...(item.providers?.length ? { providers: item.providers } : {}),
      ...(item.generated ? { generated: item.generated } : {}),
    })),
  };
  const indexFile = resolve(outputRoot, 'migration-index.json');
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
  if (configs.length) {
    writeFileSync(resolve(outputRoot, 'dxwebsrv.providers.cfg.example'), configs.join('\n\n') + '\n');
  }
  return { index, indexFile, sdkFile };
}

function usage() {
  return 'Usage: node tools/extension-batch-migrate.mjs <extensions-directory> [--output-dir <directory>] [--start-port <port>] [--all-providers] [--strict]';
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const inputRoot = resolve(args[0]);
    if (!statSync(inputRoot).isDirectory()) throw new Error('Batch migration input must be a directory');
    const outputOption = optionValue(args, '--output-dir');
    const outputRoot = resolve(outputOption || join(dirname(inputRoot), `${basename(inputRoot)}-web-migration`));
    ensureSeparateOutput(inputRoot, outputRoot);
    const startPortValue = optionValue(args, '--start-port');
    const startPort = startPortValue ? Number(startPortValue) : 9081;
    if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
      throw new Error('--start-port must be an integer between 1 and 65535');
    }
    const forceProvider = args.includes('--all-providers');
    const plan = buildBatchMigrationPlan(inputRoot, { forceProvider });
    if (!plan.desktopReports.length) throw new Error('No .epas extension modules found');
    const providerCount = plan.modules
      .filter(item => item.state === 'generate')
      .filter(item => item.providerRequired)
      .length;
    if (startPort + Math.max(0, providerCount - 1) > 65535) {
      throw new Error('Provider port range exceeds 65535');
    }
    const result = writeBatchMigration(inputRoot, outputRoot, { startPort, forceProvider });
    console.log(JSON.stringify({ output: outputRoot, ...result.index.summary }, null, 2));
    if (args.includes('--strict') && !result.index.summary.complete) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
