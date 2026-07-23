import assert from 'node:assert/strict';
import test from 'node:test';
import { closeProvider, createProviderServer, listenProvider } from './provider-sdk.mjs';
import { preflightProvider } from './provider-preflight.mjs';

const serverManifest = {
  schemaVersion: 1,
  provider: 'OfficeTools',
  mappings: [{ status: 'provider', operation: 'NormalizePhone' }],
};

async function withProvider(run) {
  const server = createProviderServer({
    manifest: serverManifest,
    handlers: { NormalizePhone: async payload => payload },
    token: 'very-secret-token',
    logger: null,
  });
  const url = await listenProvider(server);
  try {
    await run(url);
  } finally {
    await closeProvider(server);
  }
}

function config(url, token = 'very-secret-token') {
  return `[Provider:OfficeTools]\nUrl=${url}/\nToken=${token}\nTimeoutMs=5000\n`;
}

test('preflight validates config, auth, health and operation capabilities', async () => {
  await withProvider(async url => {
    const report = await preflightProvider({ manifest: serverManifest, configText: config(url) });
    assert.equal(report.ok, true);
    assert.deepEqual(report.requiredOperations, ['NormalizePhone']);
    assert.equal(report.health.status, 'ready');
    assert.equal(report.capabilities.provider, 'OfficeTools');
    assert.doesNotMatch(JSON.stringify(report), /very-secret-token/);
  });
});

test('preflight reports missing operations and authentication failures safely', async () => {
  await withProvider(async url => {
    const extended = {
      ...serverManifest,
      mappings: [...serverManifest.mappings, { status: 'provider', operation: 'ExportPdf' }],
    };
    const missing = await preflightProvider({ manifest: extended, configText: config(url) });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missingOperations, ['ExportPdf']);
    assert.ok(missing.errors.some(item => item.code === 'provider-operations-missing'));

    const unauthorized = await preflightProvider({ manifest: serverManifest, configText: config(url, 'wrong-secret') });
    assert.equal(unauthorized.ok, false);
    assert.ok(unauthorized.errors.some(item => item.code === 'provider-auth-failed'));
    assert.doesNotMatch(JSON.stringify(unauthorized), /wrong-secret/);
  });
});

test('manual mappings require an explicit preflight override', async () => {
  await withProvider(async url => {
    const incomplete = {
      ...serverManifest,
      mappings: [...serverManifest.mappings, { status: 'manual', operation: 'OpenDesktopDialog' }],
    };
    const blocked = await preflightProvider({ manifest: incomplete, configText: config(url) });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some(item => item.code === 'manifest-manual-adaptation'));

    const allowed = await preflightProvider({ manifest: incomplete, configText: config(url), allowManual: true });
    assert.equal(allowed.ok, true);
    assert.ok(allowed.warnings.some(item => item.code === 'manifest-manual-adaptation'));
  });
});

test('inline-only manifests do not require a provider section or network call', async () => {
  const report = await preflightProvider({
    manifest: {
      schemaVersion: 1,
      provider: 'Portable',
      mappings: [{ status: 'web-script', operation: 'INLINE' }],
    },
    configText: '',
    fetchImpl: () => {
      throw new Error('fetch must not be called');
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.providerRequired, false);
  assert.deepEqual(report.requiredOperations, []);
});
