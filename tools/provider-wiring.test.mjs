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
  assert.match(source('extensionproviders.pas'), /UrlHasCredentials\(Provider\.Url\)/);
});

test('provider configuration is separated from database sections', () => {
  const settings = source('appsettings.pas');
  assert.match(settings, /Pos\('provider:', LowerCase\(Sect\)\) = 1/);
  assert.match(settings, /Provider\.TimeoutMs := ReadInteger/);
});

test('Windows-only APIs are enabled only in the explicit isolated worker mode', () => {
  const settings = source('appsettings.pas');
  const scripts = source('scriptmanager.pas');
  const runtimeTypes = source('dxtypes.pas');

  assert.match(settings,
    /FWindowsWorkerMode := ReadBool\('Server', 'WindowsWorkerMode', False\)/);
  assert.match(scripts, /\{\$IFDEF WINDOWS\}, uPSC_ComObj, uPSR_ComObj\{\$ENDIF\}/);
  assert.match(scripts,
    /AppSet\.WindowsWorkerMode then[\s\S]{0,250}SIRegister_ComObj\(Sender\)/);
  assert.match(scripts, /AddTypeS\('OleVariant', 'Variant'\)/);
  assert.match(scripts,
    /AppSet\.WindowsWorkerMode then\s+RIRegister_ComObj\(FExec\)/);
  assert.match(runtimeTypes,
    /AppSet\.WindowsWorkerMode then Exit/);
});

test('runtime exposes extension mapping status without breaking legacy forms', () => {
  const scripts = source('scriptmanager.pas');
  const runtimeTypes = source('dxtypes.pas');
  assert.match(scripts, /DesktopSDi, WebSDi: Integer/);
  assert.match(scripts, /function TScriptManager\.ExtensionCompatibilityAsJson/);
  assert.match(scripts, /function ExtractWebMappingSource/);
  assert.match(scripts, /ExtractWebMappingSource\(\s*Scripts\[WebIndex\]\.Source/);
  assert.match(scripts, /'missing'/);
  assert.match(scripts, /'provider'/);
  assert.match(scripts, /'provider-unconfigured'/);
  assert.match(scripts, /'provider-unresolved'/);
  assert.match(scripts, /'web-script'/);
  assert.match(scripts, /'auto-web-script'/);
  assert.match(scripts, /'windows-worker-required'/);
  assert.match(scripts, /'automatic-compile-failed'/);
  assert.match(scripts, /Summary\.Add\('windowsWorkerRequired'/);
  assert.match(scripts, /Summary\.Add\('automaticCompileFailed'/);
  assert.match(scripts, /AppSet\.ProviderList\.FindItem/);
  assert.match(scripts, /providerConfigured/);
  assert.match(scripts, /Disabled automatic web extension/);

  assert.match(runtimeTypes, /function BuildAutomaticWebExtensionSource/);
  assert.match(runtimeTypes, /Prepared automatic web extension candidate/);
  assert.match(runtimeTypes, /Extension requires isolated worker/);
  for (const blocked of [
    'external',
    'CreateOleObject',
    'ShellExecute',
    'LoadLibrary',
    'GetProcAddress',
    'LoadFromFile',
    'SaveToFile',
    'FindAllFiles',
  ]) {
    assert.match(runtimeTypes, new RegExp(`'${blocked}'`));
  }

  assert.match(source('mainserver.pas'), /LPm = 'extensioncompat'/);
  assert.match(source('expressions.pas'), /if not F\.WebExists then Exit\(Null\)/);
  assert.match(source('dxactions.pas'), /not EAction\.WebExists then Exit/);
});
