import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  auditSource,
  buildRuntimeCompatibility,
  extractProviderCalls,
} from './extension-audit.mjs';

test('portable web action keeps its stable id', () => {
  const report = auditSource(`
    {@module
    Author=Test
    Version=1.0
    Description=Portable action
    @}
    {@action
    Id=345345DF-DFG-345-DFGDFA
    @}
    procedure Run;
    begin
    end;
  `);
  assert.equal(report.compatibility, 'portable');
  assert.equal(report.moduleType, 'web-or-compatible');
  assert.equal(report.specifications[0].id, '345345DF-DFG-345-DFGDFA');
});

test('detects Windows-only OLE and shell dependencies', () => {
  const report = auditSource(`
    procedure Export;
    var App: OleVariant;
    begin
      App := CreateOleObject('Word.Application');
      ShellExecute('open', 'result.docx', '', '', 1);
    end;
  `);
  assert.equal(report.compatibility, 'requires-provider');
  assert.deepEqual(report.findings.map(item => item.rule), ['ole', 'shell', 'office-files']);
});

test('marks desktop UI for manual web adaptation', () => {
  const report = auditSource(`begin ShowMessage('Done'); end.`);
  assert.equal(report.compatibility, 'review');
  assert.equal(report.findings[0].rule, 'desktop-ui');
});

test('classifies repository extension fixtures', () => {
  const fixture = name => readFileSync(new URL(`../test/fixtures/extensions/${name}`, import.meta.url), 'utf8');
  const portable = auditSource(fixture('portable.epas'));
  assert.equal(portable.compatibility, 'portable');
  assert.equal(portable.moduleType, 'desktop-or-unknown');
  assert.equal(auditSource(fixture('office.epas')).compatibility, 'requires-provider');
  assert.equal(auditSource(fixture('native.epas')).compatibility, 'requires-provider');
});

test('matches desktop functions by Name and actions by stable Id', () => {
  const desktop = auditSource(`
    {@function
    OrigName=RenderDocument
    Name=RenderDocument
    Args=s
    Result=s
    Group=Documents
    Description=Render
    @}
    {@action
    Id=ACTION-42
    OrigName=SendDocument
    Name=Send document
    Group=Documents
    UI=
    Description=Send
    @}
  `, 'desktop.epas');
  const web = auditSource(`
    {@function
    Name=renderdocument
    @}
    {@action
    Id=ACTION-42
    @}
    function RenderDocument(Value: String): String;
    begin
      Result := ExtensionProviderCall('documents', 'RenderDocument', '{}');
    end;
  `, 'desktop.wepas');

  const compatibility = buildRuntimeCompatibility([desktop, web]);
  assert.equal(compatibility.summary.complete, true);
  assert.equal(compatibility.summary.providerBacked, 2);
  assert.equal(compatibility.functions[0].webModule, 'desktop.wepas');
  assert.equal(compatibility.functions[0].status, 'provider');
  assert.equal(compatibility.actions[0].status, 'provider');
});

test('reports missing, duplicate and orphan web mappings before runtime', () => {
  const desktop = auditSource(`
    {@function
    OrigName=DesktopOnly
    Name=DesktopOnly
    Args=
    Result=s
    Group=Test
    Description=Missing web implementation
    @}
  `, 'desktop.epas');
  const webSource = `
    {@function
    Name=Orphan
    @}
  `;
  const webOne = auditSource(webSource, 'web-one.wepas');
  const webTwo = auditSource(webSource, 'web-two.wepas');

  const compatibility = buildRuntimeCompatibility([desktop, webOne, webTwo]);
  assert.equal(compatibility.summary.complete, false);
  assert.equal(compatibility.functions[0].status, 'missing');
  assert.equal(compatibility.summary.duplicateWebMappings, 1);
  assert.equal(compatibility.summary.orphanWebMappings, 2);
});

test('uses the official .epas and .wepas roles and reports invalid metadata', () => {
  const desktop = auditSource(`
    {@function
    OrigName=DesktopName
    Name=PUBLIC_NAME
    @}
  `, 'module.epas');
  const web = auditSource(`
    {@function
    Name=PUBLIC_NAME
    @}
  `, 'module.wepas');
  const invalidWeb = auditSource(`
    {@function
    OrigName=DesktopName
    Name=PUBLIC_NAME
    @}
  `, 'broken.wepas');

  assert.equal(desktop.sourceKind, 'desktop');
  assert.equal(web.sourceKind, 'web');
  assert.equal(web.formatIssues.length, 0);
  assert.equal(invalidWeb.specifications[0].formatValid, false);
  assert.equal(invalidWeb.formatIssues[0].code, 'web-origname-not-allowed');
  assert.equal(buildRuntimeCompatibility([desktop, invalidWeb]).summary.invalidMappings, 1);
});

test('recognizes every typed provider adapter used by the Pascal runtime', () => {
  for (const adapter of [
    'ExtensionProviderCall',
    'ExtensionProviderCallBoolean',
    'ExtensionProviderCallInt64',
    'ExtensionProviderCallFloat',
    'ExtensionProviderCallDateTime',
    'ExtensionProviderCallVariant',
  ]) {
    const report = auditSource(`
      {@function
      Name=TYPED_VALUE
      @}
      function TypedValue: Variant;
      begin
        Result := ${adapter}('Typed', 'value', '{}');
      end;
    `, 'typed.wepas');
    assert.equal(report.providerBacked, true, adapter);
  }
});

test('extracts literal providers without treating comments or strings as calls', () => {
  const source = `
    { ExtensionProviderCall('Commented', 'ignored', 'payload') }
    // ExtensionProviderCallBoolean('LineComment', 'ignored', 'payload')
    procedure Probe;
    var Text, ProviderName: String;
    begin
      Text := 'ExtensionProviderCall(''InString'', ''ignored'', ''{}'')';
      ExtensionProviderCallFloat('Finance', 'rate', '{}');
      ExtensionProviderCall(ProviderName, 'dynamic', '{}');
    end;
  `;
  const calls = extractProviderCalls(source);
  assert.deepEqual(calls.map(call => call.provider), ['Finance', '']);
  assert.deepEqual(calls.map(call => call.literal), [true, false]);

  const report = auditSource(source, 'probe.wepas');
  assert.deepEqual(report.providers, ['Finance']);
  assert.equal(report.providerCalls, 2);
  assert.equal(report.dynamicProviderCalls, 1);
});

test('strict compatibility rejects dynamically selected providers', () => {
  const desktop = auditSource(`
    {@function
    OrigName=Rate
    Name=RATE
    @}
  `, 'rates.epas');
  const web = auditSource(`
    {@function
    Name=RATE
    @}
    function Rate(ProviderName: String): Double;
    begin
      Result := ExtensionProviderCallFloat(ProviderName, 'rate', '{}');
    end;
  `, 'rates.wepas');
  const compatibility = buildRuntimeCompatibility([desktop, web]);
  assert.equal(compatibility.functions[0].status, 'provider-unresolved');
  assert.equal(compatibility.functions[0].dynamicProviderCalls, 1);
  assert.equal(compatibility.summary.providerUnresolved, 1);
  assert.equal(compatibility.summary.complete, false);
});

test('strict CLI audits .epas/.wepas pairs and fails malformed web modules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-audit-'));
  const cli = fileURLToPath(new URL('./extension-audit.mjs', import.meta.url));
  const desktop = `
    {@function
    OrigName=DesktopName
    Name=PUBLIC_NAME
    @}
  `;
  const web = `
    {@function
    Name=PUBLIC_NAME
    @}
  `;
  try {
    writeFileSync(join(directory, 'module.epas'), desktop);
    writeFileSync(join(directory, 'module.wepas'), web);
    writeFileSync(join(directory, 'ignored.js'), web);

    const valid = spawnSync(process.execPath, [cli, directory, '--strict'], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(valid.stdout);
    assert.equal(report.summary.files, 2);
    assert.equal(report.summary.desktopModules, 1);
    assert.equal(report.summary.webModules, 1);
    assert.equal(report.runtimeCompatibility.summary.complete, true);

    writeFileSync(join(directory, 'module.wepas'), web.replace(
      'Name=PUBLIC_NAME',
      'OrigName=DesktopName\n    Name=PUBLIC_NAME',
    ));
    const invalid = spawnSync(process.execPath, [cli, directory, '--strict'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).runtimeCompatibility.summary.invalidMappings, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict CLI does not treat an empty directory as a successful migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-empty-audit-'));
  try {
    const cli = fileURLToPath(new URL('./extension-audit.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, directory, '--strict'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).strictValidation, {
      filesFound: false,
      mappingsFound: false,
      runtimeComplete: true,
      passed: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict CLI checks literal providers against dxwebsrv.cfg', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-config-audit-'));
  try {
    const cli = fileURLToPath(new URL('./extension-audit.mjs', import.meta.url));
    const config = join(directory, 'dxwebsrv.cfg');
    writeFileSync(join(directory, 'rates.epas'), `
      {@function
      OrigName=Rate
      Name=RATE
      @}
    `);
    writeFileSync(join(directory, 'rates.wepas'), `
      {@function
      Name=RATE
      @}
      function Rate: Double;
      begin
        Result := ExtensionProviderCallFloat('Finance', 'rate', '{}');
      end;
    `);
    writeFileSync(config, '[Provider:Other]\nUrl=http://127.0.0.1:9999/\n');

    const missing = spawnSync(process.execPath, [
      cli, directory, '--config', config, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(missing.status, 1, missing.stderr);
    const missingReport = JSON.parse(missing.stdout);
    assert.equal(missingReport.runtimeCompatibility.functions[0].status, 'provider-unconfigured');
    assert.deepEqual(missingReport.runtimeCompatibility.functions[0].missingProviders, ['Finance']);

    writeFileSync(config, '[Provider:Finance]\nUrl=http://127.0.0.1:9081/\n');
    const ready = spawnSync(process.execPath, [
      cli, directory, '--config', config, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(JSON.parse(ready.stdout).runtimeCompatibility.functions[0].status, 'provider');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
