import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  generateProviderConfig,
  generateProviderEnvironment,
  generateProviderScaffold,
} from './extension-provider-scaffold.mjs';

const manifest = {
  schemaVersion: 1,
  provider: 'OfficeTools',
  mappings: [
    {
      kind: 'function',
      operation: 'NORMALIZE_PHONE',
      status: 'provider',
      parameters: [{ name: 'Value', type: 'String', qualifier: '' }],
    },
    { kind: 'action', operation: 'legacy-ui', status: 'manual', reason: 'desktop-ui' },
  ],
};

test('generates a manifest-bound provider and config template', () => {
  const source = generateProviderScaffold(manifest, {
    manifestImport: './OfficeToolsWeb.manifest.json',
    sdkImport: '../tools/provider-sdk.mjs',
  });
  assert.match(source, /createProviderServer\(\{ manifest, handlers, token \}\)/);
  assert.match(source, /handlers\["NORMALIZE_PHONE"\] = async \(payload, context\)/);
  assert.match(source, /handlers\["NORMALIZE_PHONE"\]\.dataExpressImplemented = false/);
  assert.doesNotMatch(source, /handlers\["legacy-ui"\]/);
  assert.match(source, /Value: String/);

  const config = generateProviderConfig(manifest);
  assert.match(config, /^\[Provider:OfficeTools\]/);
  assert.match(config, /AllowInsecure=False/);

  const environment = generateProviderEnvironment(manifest);
  assert.match(environment, /DX_PROVIDER_TOKEN=/);
  assert.doesNotMatch(environment, /DX_HTTP_ALLOW_HOSTS/);
});

test('special operation names cannot escape the generated handler table', () => {
  const source = generateProviderScaffold({
    schemaVersion: 1,
    provider: 'HostileNames',
    mappings: [{ operation: '__proto__', status: 'provider' }],
  });
  assert.match(source, /const handlers = Object\.create\(null\)/);
  assert.match(source, /handlers\["__proto__"\] = async/);
});

test('generates a ready handler for a recognized HTTP_GET recipe', () => {
  const source = generateProviderScaffold({
    schemaVersion: 1,
    provider: 'LegacyHttp',
    mappings: [{
      kind: 'function',
      operation: 'HTTP_GET',
      status: 'provider',
      parameters: [{ name: 'URL', type: 'Variant', qualifier: '' }],
      providerRecipe: { kind: 'http-get', urlParameter: 'URL' },
    }],
  });
  assert.match(source, /createHttpGetHandler/);
  assert.match(source, /urlParameter: "URL"/);
  assert.match(source, /handlers\["HTTP_GET"\]\.dataExpressImplemented = true/);
  assert.doesNotMatch(source, /TODO: implement provider operation HTTP_GET/);
  const environment = generateProviderEnvironment({
    schemaVersion: 1,
    provider: 'LegacyHttp',
    mappings: [{
      operation: 'HTTP_GET',
      status: 'provider',
      providerRecipe: { kind: 'http-get', urlParameter: 'URL' },
    }],
  }, { port: 19081 });
  assert.match(environment, /DX_PROVIDER_PORT=19081/);
  assert.match(environment, /DX_HTTP_ALLOW_HOSTS=example\.com/);
});

test('generates ready stateful handlers and environment for DaData recipes', () => {
  const dadataManifest = {
    schemaVersion: 1,
    provider: 'DaData',
    mappings: [{
      kind: 'function',
      operation: 'DA_FIRM_GET',
      status: 'provider',
      providerRecipe: {
        kind: 'dadata-suggest',
        suggestType: 'party',
        apiKeyParameter: 'ApiKey',
        queryParameter: 'SearhStr',
        stateVariables: ['value', 'data.inn'],
        resultVariable: 'DA_FIRM_FIELD',
      },
    }],
  };
  const source = generateProviderScaffold(dadataManifest);
  assert.match(source, /createDadataSuggestHandler/);
  assert.match(source, /suggestType: "party"/);
  assert.match(source, /stateVariables: \["value","data\.inn"\]/);
  assert.match(source, /resultVariable: "DA_FIRM_FIELD"/);
  assert.doesNotMatch(source, /TODO: implement provider operation DA_FIRM_GET/);

  const environment = generateProviderEnvironment(dadataManifest);
  assert.match(environment, /DX_DADATA_API_KEY=/);
  assert.match(environment, /DX_DADATA_BASE_URL=https:\/\/suggestions\.dadata\.ru/);
  assert.match(environment, /DX_DADATA_ALLOW_INSECURE=false/);
});

test('generates ready LibreOffice handlers and sandbox environment', () => {
  const officeManifest = {
    schemaVersion: 1,
    provider: 'OfficeConvert',
    mappings: [{
      kind: 'action',
      operation: 'convert-word-id',
      status: 'provider',
      providerRecipe: {
        kind: 'office-document-convert',
        documentType: 'writer',
        inputParameter: 'aInputFile',
        outputParameter: 'aOutputFile',
        formatParameter: 'itemListExt',
      },
    }],
  };
  const source = generateProviderScaffold(officeManifest);
  assert.match(source, /createOfficeDocumentHandler/);
  assert.match(source, /documentType: "writer"/);
  assert.match(source, /inputParameter: "aInputFile"/);
  assert.match(source, /handlers\["convert-word-id"\]\.dataExpressImplemented = true/);
  assert.doesNotMatch(source, /TODO: implement provider operation convert-word-id/);

  const environment = generateProviderEnvironment(officeManifest);
  assert.match(environment, /DX_OFFICE_BINARY=/);
  assert.match(environment, /DX_OFFICE_INPUT_ROOTS=C:\\DataExpress\\files/);
  assert.match(environment, /DX_OFFICE_OUTPUT_ROOTS=C:\\DataExpress\\files/);
  assert.match(environment, /DX_OFFICE_TIMEOUT_MS=120000/);
});

test('CLI writes syntax-valid scaffold files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-provider-'));
  try {
    const manifestFile = join(directory, 'OfficeToolsWeb.manifest.json');
    const providerFile = join(directory, 'OfficeToolsWeb.provider.mjs');
    const configFile = join(directory, 'OfficeToolsWeb.provider.cfg.example');
    const sdkFile = join(directory, 'dataexpress-provider-sdk.mjs');
    const environmentFile = join(directory, 'OfficeToolsWeb.provider.env.example');
    writeFileSync(manifestFile, JSON.stringify(manifest));

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-provider-scaffold.mjs', import.meta.url)),
      manifestFile,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(providerFile, 'utf8'), /NORMALIZE_PHONE/);
    assert.match(readFileSync(providerFile, 'utf8'), /\.\/dataexpress-provider-sdk\.mjs/);
    assert.match(readFileSync(sdkFile, 'utf8'), /createProviderServer/);
    assert.match(readFileSync(configFile, 'utf8'), /Provider:OfficeTools/);
    assert.match(readFileSync(environmentFile, 'utf8'), /DX_PROVIDER_TOKEN/);

    const syntax = spawnSync(process.execPath, ['--check', providerFile], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const pending = spawnSync(process.execPath, [providerFile], {
      encoding: 'utf8',
      env: { ...process.env, DX_PROVIDER_TOKEN: 'test-token' },
    });
    assert.notEqual(pending.status, 0);
    assert.match(pending.stderr, /Unimplemented provider handlers: NORMALIZE_PHONE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
