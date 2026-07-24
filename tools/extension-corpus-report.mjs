import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { collectExtensionFiles } from './extension-audit.mjs';
import { generateWebModule } from './extension-migrate.mjs';

function portablePath(path) {
  return path.split('\\').join('/');
}

function mappingReport(mapping) {
  return {
    kind: mapping.kind,
    name: mapping.name,
    id: mapping.id,
    origName: mapping.origName,
    operation: mapping.operation,
    status: mapping.status,
    reason: mapping.reason || '',
    providerReady: Boolean(mapping.providerReady),
    reviewRequired: Boolean(mapping.reviewRequired),
    issues: mapping.issues || [],
    ...(mapping.providerRecipe ? { providerRecipe: mapping.providerRecipe } : {}),
  };
}

export function buildExtensionCorpusReport(inputPath, { generatedAt = new Date().toISOString() } = {}) {
  const root = resolve(inputPath);
  const files = collectExtensionFiles(root)
    .filter(file => extname(file).toLowerCase() === '.epas')
    .sort((left, right) => left.localeCompare(right, 'en'));

  const modules = files.map(file => {
    const source = readFileSync(file, 'utf8');
    const generated = generateWebModule(source, basename(file));
    return {
      file: portablePath(relative(root, file) || basename(file)),
      sourceCompatibility: generated.report.compatibility,
      sourceFindings: generated.report.findings.map(finding => ({
        rule: finding.rule,
        severity: finding.severity,
      })),
      summary: generated.manifest.summary,
      mappings: generated.manifest.mappings.map(mappingReport),
    };
  });

  const summary = modules.reduce((result, module) => {
    result.modules += 1;
    result.mappings += module.summary.total;
    result.webScript += module.summary.webScript;
    result.provider += module.summary.provider;
    result.automatedProvider += module.summary.automatedProvider;
    result.pendingProvider += module.summary.pendingProvider || 0;
    result.manual += module.summary.manual;
    result.reviewRequired += module.summary.reviewRequired;
    return result;
  }, {
    modules: 0,
    mappings: 0,
    webScript: 0,
    provider: 0,
    automatedProvider: 0,
    pendingProvider: 0,
    manual: 0,
    reviewRequired: 0,
    complete: false,
  });
  summary.complete = summary.modules > 0 && summary.mappings > 0 &&
    summary.manual === 0 && summary.pendingProvider === 0;

  return {
    schemaVersion: 1,
    generatedAt,
    summary,
    modules,
  };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return '';
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${option} requires a file path`);
  }
  return args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input || input.startsWith('--')) {
    console.error('Usage: node tools/extension-corpus-report.mjs <directory> [--output report.json] [--strict] [--strict-review]');
    process.exitCode = 2;
    return;
  }

  try {
    const output = optionValue(args, '--output');
    const report = buildExtensionCorpusReport(input);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (output) writeFileSync(resolve(output), json);
    else process.stdout.write(json);

    const strictFailed = args.includes('--strict') && !report.summary.complete;
    const reviewFailed = args.includes('--strict-review') &&
      (!report.summary.complete || report.summary.reviewRequired > 0);
    if (strictFailed || reviewFailed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] &&
    resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) {
  main();
}
