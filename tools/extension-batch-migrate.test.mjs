import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeBatchMigration } from './extension-batch-migrate.mjs';
import { preflightProvider } from './provider-preflight.mjs';

const cli = fileURLToPath(new URL('./extension-batch-migrate.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('./extension-bundle-verify.mjs', import.meta.url));

function desktop(operation, secondOperation = '') {
  const declaration = name => `
{@function
OrigName=${name}Impl
Name=${name}
Args=s
Result=s
@}
function ${name}Impl(Value: String): String;
begin
  Result := Value;
end;
`;
  return `{@module
Author=Batch test
Version=1.0
Description=Batch fixture
@}
${declaration(operation)}${secondOperation ? declaration(secondOperation) : ''}`;
}

function web(operation) {
  return `{@module
Author=Batch test
Version=1.0-web
Description=Existing web module
@}
{@function
Name=${operation}
@}
function ${operation}Impl(Value: String): String;
begin
  Result := Value;
end;
`;
}

function legacyHttpGetDesktop() {
  return readFileSync(
    new URL('../test/fixtures/extensions/legacy-http-get.epas', import.meta.url),
    'utf8',
  );
}

function legacyDadataDesktop() {
  return readFileSync(
    new URL('../test/fixtures/extensions/legacy-dadata.epas', import.meta.url),
    'utf8',
  );
}

function legacyOfficeDesktop() {
  return readFileSync(
    new URL('../test/fixtures/extensions/legacy-office.epas', import.meta.url),
    'utf8',
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-batch-'));
  const input = join(root, 'extensions');
  const output = join(root, 'bundle');
  mkdirSync(input);
  return { root, input, output };
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}

async function freePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

async function waitForProvider(url, child, diagnostics) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Generated provider exited early: ${diagnostics.join('')}`);
    }
    try {
      const response = await fetch(new URL('/health', url), {
        headers: { authorization: 'Bearer live-secret' },
      });
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await delay(25);
  }
  throw new Error(`Generated provider did not start: ${diagnostics.join('')}`);
}

test('batch migration preserves existing web modules and creates a portable provider bundle', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'nested', 'Alpha.epas'), desktop('ALPHA'));
    write(join(input, 'Beta.epas'), desktop('BETA'));
    write(join(input, 'BetaWeb.wepas'), web('BETA'));

    const result = spawnSync(process.execPath, [
      cli, input, '--output-dir', output, '--start-port', '12000', '--strict',
      '--all-providers',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);

    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.deepEqual(index.summary, {
      desktopModules: 2,
      webModules: 1,
      generated: 1,
      preserved: 1,
      blocked: 0,
      existingNeedsReview: 0,
      manualMappings: 0,
      inlineMappings: 0,
      providerImplementationsRequired: 1,
      orphanWebMappings: 0,
      invalidMappings: 0,
      complete: false,
    });
    assert.ok(existsSync(join(output, 'Beta.epas')));
    assert.ok(existsSync(join(output, 'BetaWeb.wepas')));
    assert.ok(existsSync(join(output, 'nested', 'Alpha.epas')));
    assert.ok(existsSync(join(output, 'nested', 'Alpha.wepas')));
    assert.ok(existsSync(join(output, 'dataexpress-provider-sdk.mjs')));

    const provider = join(output, 'nested', 'Alpha.provider.mjs');
    assert.match(readFileSync(provider, 'utf8'), /\.\.\/dataexpress-provider-sdk\.mjs/);
    assert.match(readFileSync(join(output, 'dxwebsrv.providers.cfg.example'), 'utf8'), /127\.0\.0\.1:12000/);
    const syntax = spawnSync(process.execPath, ['--check', provider], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch migration produces a ready provider-free bundle for portable routines', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'Portable.epas'), desktop('PORTABLE'));
    const result = spawnSync(process.execPath, [
      cli, input, '--output-dir', output, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.inlineMappings, 1);
    assert.equal(index.summary.providerImplementationsRequired, 0);
    assert.equal(index.summary.complete, true);
    assert.equal(index.modules[0].ready, true);
    assert.equal(existsSync(join(output, 'Portable.provider.mjs')), false);
    assert.equal(existsSync(join(output, 'dataexpress-provider-sdk.mjs')), false);
    assert.doesNotMatch(readFileSync(join(output, 'Portable.wepas'), 'utf8'), /ExtensionProviderCall/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch migration creates an offline-ready provider for legacy HTTP_GET', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'LegacyHttp.epas'), legacyHttpGetDesktop());
    const result = spawnSync(process.execPath, [
      cli, input, '--output-dir', output, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.providerImplementationsRequired, 0);
    assert.equal(index.summary.complete, true);
    assert.deepEqual(index.modules[0].generated.automatedProviderOperations, ['HTTP_GET']);
    assert.equal(index.modules[0].ready, true);

    const provider = readFileSync(join(output, 'LegacyHttp.provider.mjs'), 'utf8');
    assert.match(provider, /createHttpGetHandler/);
    assert.match(provider, /dataExpressImplemented = true/);
    assert.doesNotMatch(provider, /TODO: implement provider operation HTTP_GET/);
    const environment = readFileSync(join(output, 'LegacyHttp.provider.env.example'), 'utf8');
    assert.match(environment, /DX_HTTP_ALLOW_HOSTS=example\.com/);

    const verified = spawnSync(process.execPath, [verifier, output, '--offline'], {
      encoding: 'utf8',
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).summary.pendingHandlers, 0);

    rmSync(join(output, 'LegacyHttp.provider.env.example'));
    const missingEnvironment = spawnSync(process.execPath, [verifier, output, '--offline'], {
      encoding: 'utf8',
    });
    assert.equal(missingEnvironment.status, 1, missingEnvironment.stderr);
    assert.ok(JSON.parse(missingEnvironment.stdout).errors
      .some(error => error.code === 'bundle-file-missing'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated HTTP_GET provider passes live preflight and returns target content', async () => {
  const { root, input, output } = fixture();
  const target = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`provider-live:${request.url}`);
  });
  let child;
  try {
    const targetPort = await listen(target);
    const providerPort = await freePort();
    write(join(input, 'LegacyHttp.epas'), legacyHttpGetDesktop());
    writeBatchMigration(input, output, { startPort: providerPort });

    const providerFile = join(output, 'LegacyHttp.provider.mjs');
    const diagnostics = [];
    child = spawn(process.execPath, [providerFile], {
      cwd: output,
      env: {
        ...process.env,
        DX_PROVIDER_TOKEN: 'live-secret',
        DX_PROVIDER_PORT: String(providerPort),
        DX_HTTP_ALLOW_HOSTS: '127.0.0.1',
        DX_HTTP_ALLOW_PRIVATE: 'true',
        DX_HTTP_ALLOW_INSECURE: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', chunk => diagnostics.push(chunk.toString()));
    child.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
    const providerUrl = `http://127.0.0.1:${providerPort}/`;
    await waitForProvider(providerUrl, child, diagnostics);

    const manifest = JSON.parse(readFileSync(join(output, 'LegacyHttp.manifest.json'), 'utf8'));
    const configText = [
      '[Provider:LegacyHttp]',
      `Url=${providerUrl}`,
      'Token=live-secret',
      'TimeoutMs=3000',
      'AllowInsecure=False',
      '',
    ].join('\n');
    const preflight = await preflightProvider({ manifest, configText, timeoutMs: 3000 });
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
    assert.deepEqual(preflight.requiredOperations, ['HTTP_GET']);

    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer live-secret',
        'content-type': 'application/json',
        'x-dataexpress-provider': 'LegacyHttp',
      },
      body: JSON.stringify({
        operation: 'HTTP_GET',
        payload: { URL: `http://127.0.0.1:${targetPort}/legacy?q=1` },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      result: 'provider-live:/legacy?q=1',
    });
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(1000)]);
    }
    await close(target);
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated DaData provider preserves XML results and session variables end to end', async () => {
  const { root, input, output } = fixture();
  const requests = [];
  const dadata = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      suggestions: [{
        value: 'ПАО ПРОВАЙДЕР',
        data: {
          inn: '7700000000',
          state: { status: 'ACTIVE' },
        },
      }],
    }));
  });
  let child;
  try {
    const dadataPort = await listen(dadata);
    const providerPort = await freePort();
    write(join(input, 'LegacyDadata.epas'), legacyDadataDesktop());
    const migration = writeBatchMigration(input, output, { startPort: providerPort });
    assert.equal(migration.index.summary.providerImplementationsRequired, 0);
    assert.equal(migration.index.summary.complete, true);
    assert.deepEqual(
      migration.index.modules[0].generated.automatedProviderOperations,
      ['DA_FIRM_GET', 'DA_BANK_GET', 'DA_ADDR_GET'],
    );
    const webModule = readFileSync(join(output, 'LegacyDadata.wepas'), 'utf8');
    assert.match(webModule, /Session\.SetExprVar/);
    assert.match(webModule, /ReadJSONFromString\(ProviderResponse\)/);

    const diagnostics = [];
    child = spawn(process.execPath, [join(output, 'LegacyDadata.provider.mjs')], {
      cwd: output,
      env: {
        ...process.env,
        DX_PROVIDER_TOKEN: 'live-secret',
        DX_PROVIDER_PORT: String(providerPort),
        DX_DADATA_BASE_URL: `http://127.0.0.1:${dadataPort}/suggest/`,
        DX_DADATA_ALLOW_PRIVATE: 'true',
        DX_DADATA_ALLOW_INSECURE: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', chunk => diagnostics.push(chunk.toString()));
    child.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
    const providerUrl = `http://127.0.0.1:${providerPort}/`;
    await waitForProvider(providerUrl, child, diagnostics);

    const manifest = JSON.parse(readFileSync(join(output, 'LegacyDadata.manifest.json'), 'utf8'));
    const configText = [
      '[Provider:LegacyDadata]',
      `Url=${providerUrl}`,
      'Token=live-secret',
      'TimeoutMs=3000',
      'AllowInsecure=False',
      '',
    ].join('\n');
    const preflight = await preflightProvider({ manifest, configText, timeoutMs: 3000 });
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
    assert.deepEqual(preflight.requiredOperations, [
      'DA_FIRM_GET',
      'DA_BANK_GET',
      'DA_ADDR_GET',
    ]);

    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer live-secret',
        'content-type': 'application/json',
        'x-dataexpress-provider': 'LegacyDadata',
      },
      body: JSON.stringify({
        operation: 'DA_FIRM_GET',
        payload: { ApiKey: 'test-api-key', SearhStr: 'провайдер' },
      }),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.ok, true);
    assert.match(envelope.result.value, /<value>ПАО ПРОВАЙДЕР<\/value>/);
    const variables = Object.fromEntries(
      envelope.result.variables.map(item => [item.name, item.value]),
    );
    assert.equal(variables['data.inn'], '7700000000');
    assert.equal(variables['data.state.status'], 'Действующая');
    assert.equal(variables.DA_FIRM_FIELD, envelope.result.value);
    assert.deepEqual(requests, [{
      url: '/suggest/party',
      authorization: 'Token test-api-key',
      body: { query: 'провайдер', count: 1 },
    }]);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(1000)]);
    }
    await close(dadata);
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated Office provider converts a document end to end', async () => {
  const { root, input, output } = fixture();
  const providerPort = await freePort();
  const files = join(root, 'files');
  const converted = join(root, 'converted');
  mkdirSync(files);
  mkdirSync(converted);
  const sourceDocument = join(files, 'sample document.docx');
  writeFileSync(sourceDocument, 'synthetic-office-document');
  const mockSoffice = join(root, 'mock-soffice.mjs');
  writeFileSync(mockSoffice, `
    import { copyFileSync, mkdirSync } from 'node:fs';
    import { join, parse } from 'node:path';
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--version') {
      process.stdout.write('LibreOffice mock 1.0');
      process.exit(0);
    }
    const convertIndex = args.indexOf('--convert-to');
    const outdirIndex = args.indexOf('--outdir');
    if (convertIndex < 0 || outdirIndex < 0) process.exit(2);
    const extension = args[convertIndex + 1].split(':', 1)[0];
    const outdir = args[outdirIndex + 1];
    const input = args.at(-1);
    mkdirSync(outdir, { recursive: true });
    copyFileSync(input, join(outdir, parse(input).name + '.' + extension));
  `);
  let child;
  try {
    write(join(input, 'LegacyOffice.epas'), legacyOfficeDesktop());
    const migration = writeBatchMigration(input, output, { startPort: providerPort });
    assert.equal(migration.index.summary.providerImplementationsRequired, 0);
    assert.equal(migration.index.summary.complete, true);
    assert.deepEqual(
      migration.index.modules[0].generated.automatedProviderOperations,
      [
        '7032FCD8-4797-4FC2-AAFA-04DBC1EDCFCA',
        '814E06E5-E298-4368-8AC7-45F2E25E1578',
      ],
    );

    const diagnostics = [];
    child = spawn(process.execPath, [join(output, 'LegacyOffice.provider.mjs')], {
      cwd: output,
      env: {
        ...process.env,
        DX_PROVIDER_TOKEN: 'live-secret',
        DX_PROVIDER_PORT: String(providerPort),
        DX_OFFICE_BINARY: process.execPath,
        DX_OFFICE_BINARY_ARGS: JSON.stringify([mockSoffice]),
        DX_OFFICE_INPUT_ROOTS: files,
        DX_OFFICE_OUTPUT_ROOTS: converted,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', chunk => diagnostics.push(chunk.toString()));
    child.stderr.on('data', chunk => diagnostics.push(chunk.toString()));
    const providerUrl = `http://127.0.0.1:${providerPort}/`;
    await waitForProvider(providerUrl, child, diagnostics);

    const manifest = JSON.parse(readFileSync(join(output, 'LegacyOffice.manifest.json'), 'utf8'));
    const configText = [
      '[Provider:LegacyOffice]',
      `Url=${providerUrl}`,
      'Token=live-secret',
      'TimeoutMs=3000',
      'AllowInsecure=False',
      '',
    ].join('\n');
    const preflight = await preflightProvider({ manifest, configText, timeoutMs: 3000 });
    assert.equal(preflight.ok, true, JSON.stringify(preflight));

    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer live-secret',
        'content-type': 'application/json',
        'x-dataexpress-provider': 'LegacyOffice',
      },
      body: JSON.stringify({
        operation: '7032FCD8-4797-4FC2-AAFA-04DBC1EDCFCA',
        payload: {
          aInputFile: sourceDocument,
          aOutputFile: join(converted, 'result'),
          itemListExt: '.PDF - wdFormatPDF - PDF',
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(readFileSync(join(converted, 'result.pdf'), 'utf8'), 'synthetic-office-document');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(1000)]);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict batch migration blocks partial web coverage without adding duplicates', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'Partial.epas'), desktop('ONE', 'TWO'));
    write(join(input, 'Existing.wepas'), web('ONE'));
    const result = spawnSync(process.execPath, [cli, input, '--output-dir', output, '--strict'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.complete, false);
    assert.equal(index.modules[0].state, 'blocked');
    assert.equal(index.modules[0].reason, 'partial-web-coverage');
    assert.equal(existsSync(join(output, 'Partial.wepas')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict batch migration reports provider-name collisions and manual mappings', () => {
  const collision = fixture();
  try {
    write(join(collision.input, 'one', 'Shared.epas'), desktop('FIRST'));
    write(join(collision.input, 'two', 'Shared.epas'), desktop('SECOND'));
    const result = spawnSync(process.execPath, [
      cli, collision.input, '--output-dir', collision.output, '--strict', '--all-providers',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(collision.output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.blocked, 2);
    assert.ok(index.modules.every(item => item.reason === 'duplicate-provider-name'));
  } finally {
    rmSync(collision.root, { recursive: true, force: true });
  }

  const manual = fixture();
  try {
    write(join(manual.input, 'Unsafe.epas'), `
{@function
OrigName=Mutate
Name=MUTATE
Args=n
Result=b
@}
function Mutate(var Value: Integer): Boolean;
begin
  Result := DesktopOnly(Value);
end;
`);
    const result = spawnSync(process.execPath, [
      cli, manual.input, '--output-dir', manual.output, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(manual.output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.manualMappings, 1);
    assert.equal(index.modules[0].reason, 'manual-adaptation-required');
  } finally {
    rmSync(manual.root, { recursive: true, force: true });
  }
});

test('batch migration refuses a non-empty output directory', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'Safe.epas'), desktop('SAFE'));
    write(join(output, 'keep.txt'), 'user data');
    const result = spawnSync(process.execPath, [cli, input, '--output-dir', output], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Output directory must be empty/);
    assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'user data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
