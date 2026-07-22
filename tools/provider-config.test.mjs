import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredProviderNames,
  findProvider,
  parseProviderConfig,
  validateProviderEndpoint,
} from './provider-config.mjs';

test('parses provider sections without exposing database sections as providers', () => {
  const config = parseProviderConfig(`
    [Server]
    Port=8080
    [Demo]
    Database=demo.fdb
    [Provider:OfficeTools]
    Url=http://127.0.0.1:9081/
    Token=secret
    TimeoutMs=500
    AllowInsecure=False
  `);
  assert.deepEqual(config.errors, []);
  assert.equal(config.providers.length, 1);
  const provider = findProvider(config, 'officetools');
  assert.equal(provider.timeoutMs, 1000);
  assert.equal(provider.token, 'secret');
  assert.deepEqual([...configuredProviderNames(config)], ['officetools']);
});

test('rejects ambiguous sections and unsafe remote HTTP', () => {
  const config = parseProviderConfig(`
    [Provider:Remote]
    Url=http://example.com/
    [provider:remote]
    Url=https://example.com/
    [Provider:Unsafe]
    Url=http://example.com/
  `);
  assert.ok(config.errors.some(error => error.code === 'duplicate-section'));
  assert.deepEqual(validateProviderEndpoint(findProvider(config, 'Unsafe')).errors, [
    { code: 'provider-https-required' },
  ]);
});

test('reports blank URLs and empty tokens without returning secrets in diagnostics', () => {
  const config = parseProviderConfig('[Provider:Blank]\nToken=top-secret');
  const diagnostics = validateProviderEndpoint(config.providers[0]);
  assert.deepEqual(diagnostics.errors, [{ code: 'provider-url-required' }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /top-secret/);
});
