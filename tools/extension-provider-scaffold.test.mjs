import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  generateProviderConfig,
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
  assert.doesNotMatch(source, /handlers\["legacy-ui"\]/);
  assert.match(source, /Value: String/);

  const config = generateProviderConfig(manifest);
  assert.match(config, /^\[Provider:OfficeTools\]/);
  assert.match(config, /AllowInsecure=False/);
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

test('CLI writes syntax-valid scaffold files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-provider-'));
  try {
    const manifestFile = join(directory, 'OfficeToolsWeb.manifest.json');
    const providerFile = join(directory, 'OfficeToolsWeb.provider.mjs');
    const configFile = join(directory, 'OfficeToolsWeb.provider.cfg.example');
    writeFileSync(manifestFile, JSON.stringify(manifest));

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-provider-scaffold.mjs', import.meta.url)),
      manifestFile,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(providerFile, 'utf8'), /NORMALIZE_PHONE/);
    assert.match(readFileSync(configFile, 'utf8'), /Provider:OfficeTools/);

    const syntax = spawnSync(process.execPath, ['--check', providerFile], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
