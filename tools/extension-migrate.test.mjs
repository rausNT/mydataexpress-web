import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWebModule } from './extension-migrate.mjs';

const desktopModule = `
{@module
Author=Test
Version=2.0
Description=Test module
@}
{@function
OrigName=NormalizePhone
Name=NORMALIZE_PHONE
Args=s
Result=s
Group=Text
Description=Normalize a phone
@}
function NormalizePhone(Value: String): String;
begin
  Result := Value;
end;

{@action
Id=action-123
Target=button
OrigName=ExportDocument
Name=Export
Group=Documents
UI=
Description=Export document
@}
procedure ExportDocument(FileName: String);
begin
end;
`;

test('generates stable web specifications and provider calls', () => {
  const generated = generateWebModule(desktopModule, 'OfficeTools.epas').module;
  assert.match(generated, /Name=NORMALIZE_PHONE/);
  assert.match(generated, /Id=action-123/);
  assert.match(generated, /function NormalizePhone\(Value: String\): String;/);
  assert.match(generated, /procedure ExportDocument\(FileName: String\);/);
  assert.match(generated, /"Value":/);
  assert.match(generated, /ExtensionProviderCall\('OfficeTools', 'NORMALIZE_PHONE', ProviderPayload\)/);
  assert.match(generated, /Result := ProviderResponse/);
});

test('does not invent declarations when source cannot be matched', () => {
  const source = desktopModule.replace('procedure ExportDocument(FileName: String);', 'procedure OtherName;');
  const generated = generateWebModule(source, 'OfficeTools.epas').module;
  assert.match(generated, /TODO: declaration for ExportDocument was not found/);
});
