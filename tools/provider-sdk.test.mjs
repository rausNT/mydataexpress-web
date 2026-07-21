import assert from 'node:assert/strict';
import test from 'node:test';
import { closeProvider, createProviderServer, listenProvider } from './provider-sdk.mjs';

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
