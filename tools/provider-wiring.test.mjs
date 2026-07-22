import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('provider bridge is registered for Pascal Script compile and runtime', () => {
  const compiler = source('compilerdecls.pas');
  const runtime = source('rundecls.pas');
  for (const name of [
    'ExtensionProviderCall',
    'ExtensionProviderCallBoolean',
    'ExtensionProviderCallInt64',
    'ExtensionProviderCallFloat',
    'ExtensionProviderCallDateTime',
    'ExtensionProviderCallVariant',
    'ExtensionProviderEncodeValue',
  ]) {
    assert.match(compiler, new RegExp(`function ${name}\\(`));
    assert.match(runtime, new RegExp(`RegisterDelphiFunction\\(@${name}`));
  }
});

test('provider configuration is separated from database sections', () => {
  const settings = source('appsettings.pas');
  assert.match(settings, /Pos\('provider:', LowerCase\(Sect\)\) = 1/);
  assert.match(settings, /Provider\.TimeoutMs := ReadInteger/);
});

test('runtime exposes extension mapping status and rejects silent fallbacks', () => {
  const scripts = source('scriptmanager.pas');
  assert.match(scripts, /DesktopSDi, WebSDi: Integer/);
  assert.match(scripts, /function TScriptManager\.ExtensionCompatibilityAsJson/);
  assert.match(scripts, /'missing'/);
  assert.match(scripts, /'provider'/);
  assert.match(scripts, /'web-script'/);

  assert.match(source('mainserver.pas'), /LPm = 'extensioncompat'/);
  assert.match(source('expressions.pas'), /rsExtWebFunctionMissing/);
  assert.match(source('dxactions.pas'), /rsExtWebActionMissing/);
});
