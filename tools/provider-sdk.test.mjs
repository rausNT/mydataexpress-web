import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeProvider,
  createProviderServer,
  listenProvider,
  ProviderManifestError,
  validateProviderManifest,
} from './provider-sdk.mjs';

async function call(url, body, token = 'secret') {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-dataexpress-provider': 'TestProvider',
    },
    body: JSON.stringify(body),
  });
}

test('dispatches a provider operation and returns the stable envelope', async () => {
  const server = createProviderServer({
    token: 'secret',
    logger: null,
    handlers: { sum: payload => payload.a + payload.b },
  });
  const url = await listenProvider(server);
  try {
    const response = await call(url, { operation: 'sum', payload: { a: 2, b: 3 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: 5 });
  } finally {
    await closeProvider(server);
  }
});

test('rejects invalid tokens and unknown operations', async () => {
  const server = createProviderServer({ token: 'secret', logger: null, handlers: {} });
  const url = await listenProvider(server);
  try {
    const unauthorized = await call(url, { operation: 'none', payload: null }, 'wrong');
    assert.equal(unauthorized.status, 401);
    const missing = await call(url, { operation: 'none', payload: null });
    assert.equal(missing.status, 404);
  } finally {
    await closeProvider(server);
  }
});

test('validates manifest operations before the provider starts', () => {
  const manifest = {
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [
      { operation: 'normalize', status: 'provider' },
      { operation: 'legacy_ui', status: 'manual', reason: 'desktop-ui' },
    ],
  };
  const capabilities = validateProviderManifest(manifest, {
    normalize: () => '',
    diagnostic: () => '',
  });
  assert.deepEqual(capabilities.operations, ['normalize']);
  assert.deepEqual(capabilities.extraHandlers, ['diagnostic']);
  assert.deepEqual(capabilities.manualOperations, [
    { operation: 'legacy_ui', reason: 'desktop-ui' },
  ]);
  assert.equal(capabilities.complete, false);

  assert.throws(
    () => validateProviderManifest(manifest, {}),
    error => error instanceof ProviderManifestError &&
      error.details.missingHandlers?.[0] === 'normalize',
  );
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [...manifest.mappings, { operation: 'normalize', status: 'provider' }],
    }, { normalize() {} }),
    /Duplicate provider operations: normalize/,
  );
});

test('does not accept inherited object properties as provider handlers', () => {
  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [{ operation: 'toString', status: 'provider' }],
  }, {}), /Missing provider handlers: toString/);
});

test('generated TODO handlers cannot advertise ready capabilities', () => {
  const pending = async () => {};
  pending.dataExpressImplemented = false;
  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [{ operation: 'normalize', status: 'provider' }],
  }, { normalize: pending }), /Unimplemented provider handlers: normalize/);
});

test('protects provider health and capabilities with the bearer token', async () => {
  const manifest = {
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [
      { operation: 'normalize', status: 'provider' },
      { operation: 'legacy_ui', status: 'manual', reason: 'desktop-ui' },
    ],
  };
  const server = createProviderServer({
    token: 'secret',
    manifest,
    logger: null,
    handlers: { normalize: value => value },
  });
  const url = await listenProvider(server);
  try {
    const unauthorized = await fetch(new URL('/health', url));
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: 'Bearer secret' };
    const health = await fetch(new URL('/health', url), { headers });
    assert.deepEqual(await health.json(), {
      ok: true,
      status: 'ready',
      provider: 'OfficeTools',
      complete: false,
    });

    const response = await fetch(new URL('/capabilities', url), { headers });
    const capabilities = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(capabilities.operations, ['normalize']);
    assert.deepEqual(capabilities.manualOperations, [
      { operation: 'legacy_ui', reason: 'desktop-ui' },
    ]);

    const mismatch = await call(url, { operation: 'normalize', payload: 'x' });
    assert.equal(mismatch.status, 409);
    assert.match((await mismatch.json()).error, /expected OfficeTools, got TestProvider/);
  } finally {
    await closeProvider(server);
  }
});
