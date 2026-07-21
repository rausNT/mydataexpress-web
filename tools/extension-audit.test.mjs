import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSource } from './extension-audit.mjs';

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
