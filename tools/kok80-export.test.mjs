import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(file, 'utf8');

test('kok80 Excel adapter preserves all stable desktop mappings', () => {
  const web = source('deploy/shared-extensions/kok80-ExportToExcel4.0b1.wepas');
  assert.match(web, /07B72A92-28B5-4707-96DA-D3D5AEC0FFE7/);
  assert.match(web, /F477247A-3094-4D6B-8FD6-C8C91972A3B3/);
  assert.match(web, /Name=ExportToExel/);
  assert.match(web, /Session\.ExportToExcel\(Self, ''\)/);
});

test('kok80 export is a session-scoped native browser download', () => {
  const exporter = source('spreadsheetexport.pas');
  const session = source('dxtypes.pas');
  const renderer = source('htmlshow.pas');
  const server = source('mainserver.pas');
  const browser = source('_test/html/main.js');
  const installer = source('deploy/install.sh');

  assert.match(exporter, /urn:schemas-microsoft-com:office:spreadsheet/);
  assert.match(exporter, /GetCachePath\(SS\)/);
  assert.match(exporter, /CheckControlVisible\(SS\.RoleId/);
  assert.match(exporter, /AUDIT spreadsheet_export/);
  assert.match(session, /function ExportToExcel\(Fm: TdxForm;/);
  assert.match(renderer, /function THtmlShow\.ExportSpreadsheet/);
  assert.match(renderer, /onclick="exportExcel\(''query'',/);
  assert.match(server, /LPm = 'exportxls'/);
  assert.match(browser, /function exportExcel\(kind, id\)/);
  assert.match(browser, /a\.download = ''/);
  assert.match(installer, /kok80-ExportToExcel4\.0b1\.wepas/);
});
