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

test('legacy modal dialogs compile with a conservative web fallback', () => {
  const compilerDecls = source('compilerdecls.pas');
  const runtimeDecls = source('rundecls.pas');
  assert.match(compilerDecls,
    /function MessageDlg\(const Title, Msg: String; MsgType: TMsgDlgType;/);
  assert.match(compilerDecls, /'mrYes', 'Integer'\)\.SetInt\(6\)/);
  assert.match(runtimeDecls,
    /function LegacyMessageDlg[\s\S]+if mbNo in Buttons then Exit\(7\)/);
  assert.match(runtimeDecls,
    /RegisterDelphiFunction\(@LegacyMessageDlg, 'MessageDlg'/);
});

test('legacy EvalExpr delegates through the form session', () => {
  const compilerDecls = source('compilerdecls.pas');
  const runtimeDecls = source('rundecls.pas');
  assert.match(compilerDecls,
    /function EvalExpr\(const Expr: String; Fm: TdxForm\): Variant/);
  assert.match(runtimeDecls,
    /function LegacyEvalExpr[\s\S]+RS\.Session\.EvalExpr\(Expr, Fm\)/);
  assert.match(runtimeDecls,
    /RegisterDelphiFunction\(@LegacyEvalExpr, 'EvalExpr'/);
});

test('legacy focus APIs retain browser-visible focus semantics', () => {
  const controls = source('dxctrls.pas');
  const compilerDecls = source('compilerdecls.pas');
  const runtimeDecls = source('rundecls.pas');
  const renderer = source('htmlshow.pas');
  assert.match(compilerDecls, /RegisterProperty\('CanFocus', 'Boolean', iptR\)/);
  assert.match(compilerDecls, /RegisterMethod\('procedure SetFocus'\)/);
  assert.match(runtimeDecls,
    /RegisterPropertyHelper\(@TControlCanFocus_R, nil, 'CanFocus'\)/);
  assert.match(runtimeDecls,
    /RegisterMethod\(@TdxControl\.SetFocus, 'SetFocus'\)/);
  assert.match(controls,
    /procedure TdxControl\.SetFocus;[\s\S]+RequestControlFocus\(Self, False\)/);
  assert.match(renderer,
    /if C = FTopCtrl then[\s\S]+onfocus="this\.select\(\)"/);
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
  assert.match(scripts, /Summary\.Add\('desktopModules'/);
  assert.match(scripts, /Summary\.Add\('webModules'/);
  assert.match(scripts, /Summary\.Add\('automaticModules'/);
  assert.match(scripts, /Summary\.Add\('extensionModules'/);
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

  const mainServer = source('mainserver.pas');
  assert.match(mainServer, /LPm = 'extensioncompat'/);
  assert.match(mainServer,
    /SS\.DBItem\.CompatibilitySummary :=\s+MD\.ScriptMan\.ExtensionCompatibilityAsJson/);
  assert.match(source('expressions.pas'), /if not F\.WebExists then Exit\(Null\)/);
  assert.match(source('dxactions.pas'), /not EAction\.WebExists then Exit/);
});

test('legacy DX_PLUS web modules normalize every historical GotoForm signature', () => {
  const scripts = source('scriptmanager.pas');
  const smoke = source('tools/wepas-compile-smoke.pas');

  assert.match(scripts, /function NormalizeLegacyGotoFormCalls/);
  assert.match(scripts, /CommaCount = 1/);
  assert.match(scripts, /gtoDefault/);
  assert.match(scripts, /gtoNewTab/);
  assert.match(scripts,
    /FCompiler\.Compile\(NormalizeLegacyTdxFormConstructors\(\s*NormalizeLegacyGotoFormCalls\(SD\.Source\)\)\)/);
  assert.match(smoke, /Self\.GotoForm\(''Compatibility'', 1\)/);
  assert.match(smoke, /Self\.GotoForm\(''Compatibility'', 1, False\)/);
  assert.match(smoke, /NormalizeLegacyGotoFormCalls\(WebSource\.Text\)/);
});

test('legacy desktop form constructors use the existing web session factory', () => {
  const scripts = source('scriptmanager.pas');
  const smoke = source('tools/wepas-compile-smoke.pas');

  assert.match(scripts, /function NormalizeLegacyTdxFormConstructors/);
  assert.match(scripts, /LegacyCall = 'TdxForm\.Create'/);
  assert.match(scripts, /WebCall = 'Session\.CreateForm'/);
  assert.match(smoke, /Fm := TdxForm\.Create\(''Compatibility''\)/);
  assert.match(smoke, /Session\.CreateForm\(''Compatibility''\)/);
  assert.match(smoke, /comment must remain unchanged/);
  assert.match(smoke, /text must remain unchanged/);
});

test('desktop dataset control aliases compile against the deferred web form runtime', () => {
  const compiler = source('compilerdecls.pas');
  const runtime = source('rundecls.pas');
  const smoke = source('tools/wepas-compile-smoke.pas');

  assert.match(compiler, /RegisterMethod\('procedure DisableControls'\)/);
  assert.match(compiler, /RegisterMethod\('procedure EnableControls'\)/);
  assert.match(runtime,
    /RegisterMethod\(@TdxForm\.DisableScrollEvents, 'DisableControls'\)/);
  assert.match(runtime,
    /RegisterMethod\(@TdxForm\.EnableScrollEvents, 'EnableControls'\)/);
  assert.match(smoke, /Self\.DisableControls/);
  assert.match(smoke, /Self\.EnableControls/);
});
