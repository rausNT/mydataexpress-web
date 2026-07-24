#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProviderManifest } from './provider-sdk.mjs';

export const PROVIDER_SDK_FILENAME = 'dataexpress-provider-sdk.mjs';

export function installProviderSdk(outputDirectory, filename = PROVIDER_SDK_FILENAME) {
  const sourceFile = fileURLToPath(new URL('./provider-sdk.mjs', import.meta.url));
  const output = resolve(outputDirectory, filename);
  const source = readFileSync(sourceFile, 'utf8');
  if (existsSync(output) && readFileSync(output, 'utf8') !== source) {
    throw new Error(`Provider SDK already exists with different contents: ${output}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, source);
  return output;
}

function importPath(fromFile, toFile) {
  let value = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
  if (!value.startsWith('.')) value = `./${value}`;
  return value;
}

function requiredOperations(manifest) {
  const handlers = Object.fromEntries(
    (manifest?.mappings || [])
      .filter(mapping => mapping?.status === 'provider')
      .map(mapping => [mapping.operation, () => {}]),
  );
  return validateProviderManifest(manifest, handlers).operations;
}

export function generateProviderScaffold(manifest, {
  manifestImport = './extension.manifest.json',
  sdkImport = './tools/provider-sdk.mjs',
  port = 9081,
} = {}) {
  const operations = requiredOperations(manifest);
  const mappingByOperation = new Map(
    manifest.mappings.map(mapping => [mapping.operation, mapping]),
  );
  const lines = [
    "import { readFileSync } from 'node:fs';",
    `import { createHttpGetHandler, createProviderServer, listenProvider } from ${JSON.stringify(sdkImport)};`,
    '',
    `const manifest = JSON.parse(readFileSync(new URL(${JSON.stringify(manifestImport)}, import.meta.url), 'utf8'));`,
    '',
    'const handlers = Object.create(null);',
    '',
  ];

  for (const operation of operations) {
    const mapping = mappingByOperation.get(operation) || {};
    const parameters = (mapping.parameters || [])
      .map(parameter => `${parameter.name}: ${parameter.type}`)
      .join(', ');
    lines.push(`// ${mapping.kind || 'operation'} ${operation}${parameters ? ` (${parameters})` : ''}`);
    if (mapping.providerRecipe?.kind === 'http-get') {
      lines.push(
        `handlers[${JSON.stringify(operation)}] = createHttpGetHandler({`,
        `  urlParameter: ${JSON.stringify(mapping.providerRecipe.urlParameter || 'URL')},`,
        '});',
        `handlers[${JSON.stringify(operation)}].dataExpressImplemented = true;`,
        '',
      );
      continue;
    }
    if (mapping.providerRecipe) {
      throw new Error(`Unsupported provider recipe: ${mapping.providerRecipe.kind || 'missing'}`);
    }
    lines.push(
      `handlers[${JSON.stringify(operation)}] = async (payload, context) => {`,
      '  void payload;',
      '  void context;',
      `  throw new Error(${JSON.stringify(`TODO: implement provider operation ${operation}`)});`,
      '};',
      `handlers[${JSON.stringify(operation)}].dataExpressImplemented = false; // Set true after implementing this handler.`,
      '',
    );
  }

  lines.push(
    "const token = process.env.DX_PROVIDER_TOKEN || '';",
    "if (!token) throw new Error('DX_PROVIDER_TOKEN is required');",
    'const server = createProviderServer({ manifest, handlers, token });',
    'const url = await listenProvider(server, {',
    "  host: process.env.DX_PROVIDER_HOST || '127.0.0.1',",
    `  port: Number(process.env.DX_PROVIDER_PORT || ${Number(port)}),`,
    '});',
    'console.log(`DataExpress provider ${manifest.provider} listening at ${url}`);',
    '',
  );
  return lines.join('\n');
}

export function generateProviderConfig(manifest, { url = 'http://127.0.0.1:9081/' } = {}) {
  requiredOperations(manifest);
  return [
    `[Provider:${manifest.provider}]`,
    `Url=${url}`,
    'Token=replace-with-a-long-random-token',
    'TimeoutMs=30000',
    'AllowInsecure=False',
    '',
  ].join('\n');
}

export function generateProviderEnvironment(manifest, { port = 9081 } = {}) {
  const operations = requiredOperations(manifest);
  const mappingByOperation = new Map(
    manifest.mappings.map(mapping => [mapping.operation, mapping]),
  );
  const hasHttpGet = operations.some(operation =>
    mappingByOperation.get(operation)?.providerRecipe?.kind === 'http-get');
  return [
    'DX_PROVIDER_TOKEN=replace-with-the-same-long-random-token-as-dxwebsrv.cfg',
    'DX_PROVIDER_HOST=127.0.0.1',
    `DX_PROVIDER_PORT=${Number(port)}`,
    ...(hasHttpGet ? [
      'DX_HTTP_ALLOW_HOSTS=example.com',
      'DX_HTTP_ALLOW_PRIVATE=false',
      'DX_HTTP_ALLOW_INSECURE=false',
      'DX_HTTP_TIMEOUT_MS=15000',
      'DX_HTTP_MAX_RESPONSE_BYTES=2097152',
      'DX_HTTP_MAX_REDIRECTS=3',
    ] : []),
    '',
  ].join('\n');
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (!args[index + 1]) throw new Error(`${name} requires a file path`);
  return args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('Usage: node tools/extension-provider-scaffold.mjs <manifest.json> [--output provider.mjs] [--config-output provider.cfg.example] [--env-output provider.env.example] [--no-config] [--no-env]');
    process.exitCode = 2;
    return;
  }

  try {
    const manifestFile = resolve(args[0]);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const extension = extname(manifestFile);
    const base = manifestFile.endsWith('.manifest.json')
      ? manifestFile.slice(0, -'.manifest.json'.length)
      : manifestFile.slice(0, -extension.length);
    const output = resolve(optionValue(args, '--output') || `${base}.provider.mjs`);
    const configOutput = args.includes('--no-config')
      ? ''
      : resolve(optionValue(args, '--config-output') || `${base}.provider.cfg.example`);
    const environmentOutput = args.includes('--no-env')
      ? ''
      : resolve(optionValue(args, '--env-output') || `${base}.provider.env.example`);
    const sdkFile = installProviderSdk(dirname(output));

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, generateProviderScaffold(manifest, {
      manifestImport: importPath(output, manifestFile),
      sdkImport: importPath(output, sdkFile),
    }));
    process.stdout.write(`${output}\n`);
    process.stdout.write(`${sdkFile}\n`);

    if (configOutput) {
      mkdirSync(dirname(configOutput), { recursive: true });
      writeFileSync(configOutput, generateProviderConfig(manifest));
      process.stdout.write(`${configOutput}\n`);
    }
    if (environmentOutput) {
      mkdirSync(dirname(environmentOutput), { recursive: true });
      writeFileSync(environmentOutput, generateProviderEnvironment(manifest));
      process.stdout.write(`${environmentOutput}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
