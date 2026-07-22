import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateWebModule } from './extension-migrate.mjs';
import { auditSource, buildRuntimeCompatibility } from './extension-audit.mjs';

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
  const generated = generateWebModule(desktopModule, 'OfficeTools.epas');
  assert.match(generated.module, /Name=NORMALIZE_PHONE/);
  assert.match(generated.module, /Id=action-123/);
  assert.match(generated.module, /function NormalizePhone\(Value: String\): String;/);
  assert.match(generated.module, /procedure ExportDocument\(FileName: String\);/);
  assert.match(generated.module, /"Value":/);
  assert.match(generated.module, /ExtensionProviderEncodeValue\(Value\)/);
  assert.match(generated.module, /Result := ExtensionProviderCall\('OfficeTools', 'NORMALIZE_PHONE', ProviderPayload\)/);
  assert.match(generated.module, /ExtensionProviderCall\('OfficeTools', 'action-123', ProviderPayload\)/);
  assert.equal(generated.manifest.provider, 'OfficeTools');
  assert.equal(generated.manifest.webModule, 'OfficeTools.wepas');
  assert.equal(generated.manifest.summary.complete, true);
  assert.deepEqual(generated.manifest.mappings.map(item => item.operation), ['NORMALIZE_PHONE', 'action-123']);
  assert.deepEqual(generated.manifest.mappings.map(item => item.status), ['provider', 'provider']);

  const compatibility = buildRuntimeCompatibility([
    auditSource(desktopModule, 'OfficeTools.epas'),
    auditSource(generated.module, 'OfficeTools.wepas'),
  ]);
  assert.equal(compatibility.summary.complete, true);
  assert.equal(compatibility.summary.providerBacked, 2);
});

test('does not invent declarations when source cannot be matched', () => {
  const source = desktopModule.replace('procedure ExportDocument(FileName: String);', 'procedure OtherName;');
  const generated = generateWebModule(source, 'OfficeTools.epas');
  assert.match(generated.module, /TODO: declaration for ExportDocument was not found/);
  assert.equal(generated.manifest.summary.complete, false);
  assert.equal(generated.manifest.mappings[1].status, 'manual');
  assert.equal(generated.manifest.mappings[1].reason, 'declaration-not-found');
});

test('CLI writes the official .wepas module and matching sidecars by default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-migrate-'));
  try {
    const input = join(directory, 'OfficeTools.epas');
    const workingDirectory = join(directory, 'different-working-directory');
    const output = join(directory, 'OfficeTools.wepas');
    const manifest = join(directory, 'OfficeTools.manifest.json');
    const provider = join(directory, 'OfficeTools.provider.mjs');
    const providerConfig = join(directory, 'OfficeTools.provider.cfg.example');
    const providerSdk = join(directory, 'dataexpress-provider-sdk.mjs');
    mkdirSync(workingDirectory);
    writeFileSync(input, desktopModule);

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-migrate.mjs', import.meta.url)),
      input,
    ], { encoding: 'utf8', cwd: workingDirectory });

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /ExtensionProviderCall/);
    const payload = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(payload.webModule, 'OfficeTools.wepas');
    assert.equal(payload.summary.complete, true);
    assert.match(readFileSync(provider, 'utf8'), /NORMALIZE_PHONE/);
    assert.match(readFileSync(provider, 'utf8'), /\.\/dataexpress-provider-sdk\.mjs/);
    assert.match(readFileSync(providerSdk, 'utf8'), /createProviderServer/);
    assert.match(readFileSync(providerConfig, 'utf8'), /Provider:OfficeTools/);
    const syntax = spawnSync(process.execPath, ['--check', provider], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);

    const invalidOutput = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-migrate.mjs', import.meta.url)),
      input,
      '--output', join(directory, 'OfficeToolsWeb.epas'),
    ], { encoding: 'utf8', cwd: workingDirectory });
    assert.equal(invalidOutput.status, 2);
    assert.match(invalidOutput.stderr, /must use the official \.wepas extension/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generates typed provider adapters and preserves scalar payload types', () => {
  const source = `
    {@function
    OrigName=CalculateTotal
    Name=CALCULATE_TOTAL
    Args=n
    Result=n
    Group=Finance
    Description=Calculate
    @}
    function CalculateTotal(Value: Double; Tax: Double): Double;
    begin
      Result := Value + Tax;
    end;

    {@function
    OrigName=IsApproved
    Name=IS_APPROVED
    Args=n
    Result=b
    @}
    function IsApproved(Id: Integer): Boolean;
    begin
      Result := Id > 0;
    end;
  `;
  const generated = generateWebModule(source, 'Finance.epas');
  assert.equal(generated.manifest.summary.complete, true);
  assert.deepEqual(generated.manifest.mappings.map(item => item.status), ['provider', 'provider']);
  assert.match(generated.module, /function CalculateTotal\(Value: Double; Tax: Double\): Double;/);
  assert.match(generated.module, /ExtensionProviderEncodeValue\(Value\)/);
  assert.match(generated.module, /ExtensionProviderEncodeValue\(Tax\)/);
  assert.match(generated.module, /Result := ExtensionProviderCallFloat\('Finance', 'CALCULATE_TOTAL'/);
  assert.match(generated.module, /Result := ExtensionProviderCallBoolean\('Finance', 'IS_APPROVED'/);
  assert.equal(generated.manifest.mappings[0].resultType, 'double');
  assert.deepEqual(generated.manifest.mappings[0].parameters.map(item => item.type), ['Double', 'Double']);
});

test('keeps by-reference and custom types explicitly manual', () => {
  const source = `
    {@function
    OrigName=MutateValue
    Name=MUTATE_VALUE
    Args=n
    Result=b
    @}
    function MutateValue(var Value: Integer): Boolean;
    begin
      Result := True;
    end;

    {@function
    OrigName=MakeCustom
    Name=MAKE_CUSTOM
    Args=
    Result=s
    @}
    function MakeCustom: TCustomResult;
    begin
    end;
  `;
  const generated = generateWebModule(source, 'Unsafe.epas');
  assert.equal(generated.manifest.summary.complete, false);
  assert.deepEqual(generated.manifest.mappings.map(item => item.status), ['manual', 'manual']);
  assert.equal(generated.manifest.mappings[0].reason, 'by-reference-parameter:Value');
  assert.equal(generated.manifest.mappings[1].reason, 'unsupported-result-type:tcustomresult');
  assert.match(generated.module, /TODO: manual provider adapter required/);
});
