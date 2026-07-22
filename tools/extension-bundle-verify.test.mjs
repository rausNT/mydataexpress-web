import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeBatchMigration } from './extension-batch-migrate.mjs';
import { verifyExtensionBundle } from './extension-bundle-verify.mjs';
import { closeProvider, createProviderServer, listenProvider } from './provider-sdk.mjs';

const cli = fileURLToPath(new URL('./extension-bundle-verify.mjs', import.meta.url));
const desktop = `
{@module
Author=Verifier test
Version=1.0
Description=Verifier fixture
@}
{@function
OrigName=AlphaImpl
Name=ALPHA
Args=s
Result=s
@}
function AlphaImpl(Value: String): String;
begin
  Result := Value;
end;
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-bundle-verify-'));
  const input = join(root, 'input');
  const bundle = join(root, 'bundle');
  mkdirSync(input);
  writeFileSync(join(input, 'Alpha.epas'), desktop);
  writeBatchMigration(input, bundle, { startPort: 13000 });
  return { root, bundle };
}

function implementProvider(bundle) {
  const file = join(bundle, 'Alpha.provider.mjs');
  const source = readFileSync(file, 'utf8')
    .replace(/throw new Error\("TODO: implement provider operation ALPHA"\);/, 'return payload;')
    .replace('handlers["ALPHA"].dataExpressImplemented = false;', 'handlers["ALPHA"].dataExpressImplemented = true;');
  writeFileSync(file, source);
}

test('offline verifier blocks pending handlers and accepts an explicitly completed bundle', async () => {
  const { root, bundle } = fixture();
  try {
    const pending = await verifyExtensionBundle({ bundleRoot: bundle, offline: true });
    assert.equal(pending.ok, false);
    assert.equal(pending.summary.pendingHandlers, 1);
    assert.ok(pending.errors.some(item => item.code === 'provider-handlers-pending'));

    implementProvider(bundle);
    const providerFile = join(bundle, 'Alpha.provider.mjs');
    const implemented = readFileSync(providerFile, 'utf8');
    writeFileSync(providerFile, implemented.replace(
      'handlers["ALPHA"].dataExpressImplemented = true;',
      '// handlers["ALPHA"].dataExpressImplemented = true;',
    ));
    const commented = await verifyExtensionBundle({ bundleRoot: bundle, offline: true });
    assert.equal(commented.ok, false);
    assert.equal(commented.summary.pendingHandlers, 1);
    writeFileSync(providerFile, implemented);

    const ready = await verifyExtensionBundle({ bundleRoot: bundle, offline: true });
    assert.equal(ready.ok, true);
    assert.equal(ready.summary.runtimeComplete, true);
    assert.equal(ready.summary.pendingHandlers, 0);
    assert.ok(ready.warnings.some(item => item.code === 'provider-live-check-skipped'));

    const cliResult = spawnSync(process.execPath, [cli, bundle, '--offline'], { encoding: 'utf8' });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.equal(JSON.parse(cliResult.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live verifier checks every referenced provider without exposing its token', async () => {
  const { root, bundle } = fixture();
  implementProvider(bundle);
  const manifest = JSON.parse(readFileSync(join(bundle, 'Alpha.manifest.json'), 'utf8'));
  const server = createProviderServer({
    manifest,
    handlers: { ALPHA: async payload => payload },
    token: 'live-verifier-secret',
    logger: null,
  });
  const url = await listenProvider(server);
  try {
    const config = `[Provider:Alpha]\nUrl=${url}/\nToken=live-verifier-secret\n`;
    const report = await verifyExtensionBundle({ bundleRoot: bundle, configText: config });
    assert.equal(report.ok, true);
    assert.equal(report.summary.providersChecked, 1);
    assert.equal(report.providers[0].health.status, 'ready');
    assert.doesNotMatch(JSON.stringify(report), /live-verifier-secret/);

    const rejected = await verifyExtensionBundle({
      bundleRoot: bundle,
      configText: `[Provider:Alpha]\nUrl=${url}/\nToken=wrong-live-secret\n`,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(item => item.code === 'provider-preflight-failed'));
    assert.doesNotMatch(JSON.stringify(rejected), /wrong-live-secret/);
  } finally {
    await closeProvider(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundle verifier rejects index paths outside the bundle', async () => {
  const { root, bundle } = fixture();
  try {
    const indexFile = join(bundle, 'migration-index.json');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    index.modules[0].source = '../outside.epas';
    writeFileSync(indexFile, JSON.stringify(index));
    const report = await verifyExtensionBundle({ bundleRoot: bundle, offline: true });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some(item => item.code === 'bundle-path-escape'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
