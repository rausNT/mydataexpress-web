import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditSource, buildRuntimeCompatibility } from './extension-audit.mjs';

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
  `, 'desktopWeb.epas');

  const compatibility = buildRuntimeCompatibility([desktop, web]);
  assert.equal(compatibility.summary.complete, true);
  assert.equal(compatibility.summary.providerBacked, 2);
  assert.equal(compatibility.functions[0].webModule, 'desktopWeb.epas');
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
  const webOne = auditSource(webSource, 'web-one.epas');
  const webTwo = auditSource(webSource, 'web-two.epas');

  const compatibility = buildRuntimeCompatibility([desktop, webOne, webTwo]);
  assert.equal(compatibility.summary.complete, false);
  assert.equal(compatibility.functions[0].status, 'missing');
  assert.equal(compatibility.summary.duplicateWebMappings, 1);
  assert.equal(compatibility.summary.orphanWebMappings, 2);
});
