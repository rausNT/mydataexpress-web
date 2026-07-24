import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  closeProvider,
  createHttpGetHandler,
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

test('HTTP_GET recipe enforces host, redirect, timeout and response-size policy', async () => {
  let targetUrl = '';
  const target = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: new URL('/ok', targetUrl).href.replace('127.0.0.1', 'localhost') });
      return response.end();
    }
    if (request.url === '/large') {
      const body = 'x'.repeat(2048);
      response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      return response.end(body);
    }
    if (request.url === '/slow') {
      return setTimeout(() => response.end('late'), 80);
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Привет из provider');
  });
  targetUrl = await listenProvider(target);

  const handler = createHttpGetHandler({
    allowHosts: ['127.0.0.1'],
    allowPrivate: true,
    allowInsecure: true,
    timeoutMs: 25,
    maxResponseBytes: 1024,
  });
  const manifest = {
    schemaVersion: 1,
    provider: 'TestProvider',
    mappings: [{ operation: 'HTTP_GET', status: 'provider', providerRecipe: { kind: 'http-get' } }],
  };
  const provider = createProviderServer({
    token: 'secret',
    manifest,
    logger: null,
    handlers: { HTTP_GET: handler },
  });
  const providerUrl = await listenProvider(provider);
  try {
    const success = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/ok', targetUrl).href },
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true, result: 'Привет из provider' });

    const redirect = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/redirect', targetUrl).href },
    });
    assert.equal(redirect.status, 400);
    assert.match((await redirect.json()).error, /allow-list/);

    const oversized = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/large', targetUrl).href },
    });
    assert.equal(oversized.status, 502);
    assert.match((await oversized.json()).error, /too large/);

    const timeout = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/slow', targetUrl).href },
    });
    assert.equal(timeout.status, 504);
    assert.match((await timeout.json()).error, /timed out/);
  } finally {
    await closeProvider(provider);
    await closeProvider(target);
  }
});

test('HTTP_GET recipe requires an explicit target allow-list', () => {
  assert.throws(
    () => createHttpGetHandler({ environment: {} }),
    /DX_HTTP_ALLOW_HOSTS/,
  );
});

test('HTTP_GET recipe blocks private targets, plaintext and URL credentials by default', async () => {
  const privateTarget = createHttpGetHandler({
    allowHosts: ['127.0.0.1'],
    allowInsecure: true,
    fetch: async () => {
      throw new Error('fetch must not run for a blocked target');
    },
  });
  await assert.rejects(
    () => privateTarget({ URL: 'http://127.0.0.1/private' }),
    /non-public address/,
  );

  const secureOnly = createHttpGetHandler({
    allowHosts: ['example.com'],
    allowPrivate: true,
    fetch: async () => {
      throw new Error('fetch must not run for a blocked target');
    },
  });
  await assert.rejects(
    () => secureOnly({ URL: 'http://example.com/plain' }),
    /Plain HTTP is disabled/,
  );
  await assert.rejects(
    () => secureOnly({ URL: 'https://user:password@example.com/secret' }),
    /Credentials .* not allowed/,
  );
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
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [{ operation: 'normalize', status: 'provider', providerRecipe: { kind: 'shell' } }],
    }, { normalize() {} }),
    /invalid provider recipe/,
  );
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [{ operation: 'legacy_ui', status: 'manual', providerRecipe: { kind: 'http-get' } }],
    }, {}),
    /only allowed on provider mappings/,
  );
});

test('treats inline web-script mappings as complete without provider handlers', () => {
  const capabilities = validateProviderManifest({
    schemaVersion: 1,
    provider: 'Portable',
    mappings: [
      { operation: 'INLINE', status: 'web-script' },
      { operation: 'REMOTE', status: 'provider' },
    ],
  }, { REMOTE: async () => null });
  assert.deepEqual(capabilities.operations, ['REMOTE']);
  assert.deepEqual(capabilities.manualOperations, []);
  assert.equal(capabilities.complete, true);

  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'Portable',
    mappings: [{ operation: 'UNKNOWN', status: 'ready' }],
  }, {}), /Invalid provider mapping statuses: ready/);
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
