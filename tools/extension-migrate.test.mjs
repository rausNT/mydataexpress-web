import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('inlines self-contained routines while preserving stable web specifications', () => {
  const generated = generateWebModule(desktopModule, 'OfficeTools.epas');
  assert.match(generated.module, /Name=NORMALIZE_PHONE/);
  assert.match(generated.module, /Id=action-123/);
  assert.match(generated.module, /function NormalizePhone\(Value: String\): String;/);
  assert.match(generated.module, /procedure ExportDocument\(FileName: String\);/);
  assert.match(generated.module, /Result := Value/);
  assert.doesNotMatch(generated.module, /ExtensionProviderCall/);
  assert.equal(generated.manifest.provider, 'OfficeTools');
  assert.equal(generated.manifest.webModule, 'OfficeTools.wepas');
  assert.equal(generated.manifest.summary.complete, true);
  assert.deepEqual(generated.manifest.mappings.map(item => item.operation), ['NORMALIZE_PHONE', 'action-123']);
  assert.deepEqual(generated.manifest.mappings.map(item => item.status), ['web-script', 'web-script']);
  assert.equal(generated.manifest.summary.webScript, 2);
  assert.equal(generated.manifest.summary.provider, 0);

  const compatibility = buildRuntimeCompatibility([
    auditSource(desktopModule, 'OfficeTools.epas'),
    auditSource(generated.module, 'OfficeTools.wepas'),
  ]);
  assert.equal(compatibility.summary.complete, true);
  assert.equal(compatibility.summary.providerBacked, 0);
  assert.ok(compatibility.functions.concat(compatibility.actions)
    .every(item => item.status === 'web-script'));
});

test('does not invent declarations when source cannot be matched', () => {
  const source = desktopModule.replace('procedure ExportDocument(FileName: String);', 'procedure OtherName;');
  const generated = generateWebModule(source, 'OfficeTools.epas');
  assert.match(generated.module, /TODO: declaration for ExportDocument was not found/);
  assert.equal(generated.manifest.summary.complete, false);
  assert.equal(generated.manifest.mappings[1].status, 'manual');
  assert.equal(generated.manifest.mappings[1].reason, 'declaration-not-found');
});

test('CLI omits provider sidecars for inline modules and supports forced providers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-migrate-'));
  try {
    const input = join(directory, 'OfficeTools.epas');
    const workingDirectory = join(directory, 'different-working-directory');
    const output = join(directory, 'OfficeTools.wepas');
    const manifest = join(directory, 'OfficeTools.manifest.json');
    const provider = join(directory, 'OfficeTools.provider.mjs');
    const providerConfig = join(directory, 'OfficeTools.provider.cfg.example');
    const providerEnvironment = join(directory, 'OfficeTools.provider.env.example');
    const providerSdk = join(directory, 'dataexpress-provider-sdk.mjs');
    mkdirSync(workingDirectory);
    writeFileSync(input, desktopModule);

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-migrate.mjs', import.meta.url)),
      input,
    ], { encoding: 'utf8', cwd: workingDirectory });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /ExtensionProviderCall/);
    const payload = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(payload.webModule, 'OfficeTools.wepas');
    assert.equal(payload.summary.complete, true);
    assert.equal(payload.summary.webScript, 2);
    assert.equal(existsSync(provider), false);
    assert.equal(existsSync(providerConfig), false);
    assert.equal(existsSync(providerEnvironment), false);
    assert.equal(existsSync(providerSdk), false);

    const forcedOutput = join(directory, 'OfficeToolsForced.wepas');
    const forced = spawnSync(process.execPath, [
      fileURLToPath(new URL('./extension-migrate.mjs', import.meta.url)),
      input,
      '--output', forcedOutput,
      '--all-providers',
    ], { encoding: 'utf8', cwd: workingDirectory });
    assert.equal(forced.status, 0, forced.stderr);
    const forcedProvider = join(directory, 'OfficeToolsForced.provider.mjs');
    assert.match(readFileSync(forcedOutput, 'utf8'), /ExtensionProviderCall/);
    assert.match(readFileSync(forcedProvider, 'utf8'), /NORMALIZE_PHONE/);
    assert.match(readFileSync(forcedProvider, 'utf8'), /\.\/dataexpress-provider-sdk\.mjs/);
    assert.match(readFileSync(providerSdk, 'utf8'), /createProviderServer/);
    assert.match(readFileSync(join(directory, 'OfficeToolsForced.provider.cfg.example'), 'utf8'), /Provider:OfficeTools/);
    assert.match(readFileSync(join(directory, 'OfficeToolsForced.provider.env.example'), 'utf8'), /DX_PROVIDER_TOKEN/);
    const syntax = spawnSync(process.execPath, ['--check', forcedProvider], { encoding: 'utf8' });
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
  const generated = generateWebModule(source, 'Finance.epas', { forceProvider: true });
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

test('keeps portable by-reference routines inline and unknown custom types manual', () => {
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
  assert.deepEqual(generated.manifest.mappings.map(item => item.status), ['web-script', 'manual']);
  assert.equal(generated.manifest.mappings[0].reason, '');
  assert.equal(generated.manifest.mappings[1].reason, 'unsupported-result-type:tcustomresult');
  assert.match(generated.module, /TODO: manual provider adapter required/);
});

test('inlines safe local helper dependencies exactly once', () => {
  const source = `
    {@function
    OrigName=Normalize
    Name=NORMALIZE
    Args=s
    Result=s
    @}
    function Normalize(Value: String): String;
    begin
      Result := SharedHelper(Value);
    end;

    function SharedHelper(Value: String): String;
    begin
      Result := Trim(Value);
    end;
  `;
  const generated = generateWebModule(source, 'Helpers.epas');
  assert.equal(generated.manifest.mappings[0].status, 'web-script');
  assert.equal((generated.module.match(/function SharedHelper/g) || []).length, 1);
  assert.ok(generated.module.indexOf('function SharedHelper') <
    generated.module.indexOf('function Normalize'));
  assert.doesNotMatch(generated.module, /ExtensionProviderCall/);
});

test('inlines routines with local scalar variables and portable built-ins', () => {
  const source = `
    {@function
    OrigName=Normalize
    Name=NORMALIZE
    Args=s
    Result=s
    @}
    function Normalize(Value: String): String;
    var
      Clean: String;
    begin
      Clean := Trim(Value);
      Result := UpperCase(Clean);
    end;
  `;
  const generated = generateWebModule(source, 'Portable.epas');
  assert.equal(generated.manifest.mappings[0].status, 'web-script');
  assert.match(generated.module, /Clean := Trim\(Value\)/);
  assert.doesNotMatch(generated.module, /ExtensionProviderCall/);
});

test('normalizes a unique Cyrillic/Latin identifier homoglyph and records it', () => {
  const source = `
    {@action
    Id=9F257FA8-D21C-4CA9-B19D-E6863AB9DAE7
    OrigName=UpdateQueryС
    Name=Обновить запрос
    @}
    function UpdateQueryC(Name: String): Boolean;
    begin
      Result := Name <> '';
    end;
  `;
  const generated = generateWebModule(source, 'Homoglyph.epas');
  assert.equal(generated.manifest.mappings[0].status, 'web-script');
  assert.equal(generated.manifest.mappings[0].routineKind, 'function');
  assert.deepEqual(generated.manifest.mappings[0].issues, [
    'identifier-homoglyph-normalized:UpdateQueryС->UpdateQueryC',
  ]);
  assert.match(generated.module, /function UpdateQueryC\(Name: String\): Boolean/);
});

test('rewrites desktop session calls and keeps registered web runtime APIs inline', () => {
  const source = `
    function Validate(Name: String): String;
    begin
      Result := Trim(Name);
    end;

    {@action
    Id=B2C1C477-85A4-4133-9D9C-0FD61CA10F1C
    OrigName=RunQuery
    Name=Выполнить запрос
    @}
    procedure RunQuery(Expr: String; Rows: TVariantArray2d);
    var
      Query: TdxSQLQuery;
      Value: String;
    begin
      Value := VarToStr(EvalExpr(Expr, Self));
      Query := SQLSelect('select ' + Validate(Value) + ' from rdb$database');
      Query.Free;
    end;
  `;
  const generated = generateWebModule(source, 'RuntimeApi.epas');
  assert.equal(generated.manifest.mappings[0].status, 'web-script');
  assert.match(generated.module, /Session\.EvalExpr\(Expr, Self\)/);
  assert.match(generated.module, /Session\.SQLSelect\(/);
  assert.equal((generated.module.match(/function Validate/g) || []).length, 1);
});

test('does not treat registered object methods as free global routines', () => {
  const generated = generateWebModule(`
    {@action
    Id=method-scope
    OrigName=MethodScope
    Name=Method scope
    @}
    procedure MethodScope;
    begin
      AddHeader('X-Test', 'value');
    end;
  `, 'method-scope.epas');
  assert.equal(generated.manifest.mappings[0].status, 'provider');
  assert.ok(generated.manifest.mappings[0].issues
    .some(issue => issue.includes('external-dependency:AddHeader')));
});

test('migrates the compile-smoke runtime fixture without provider fallbacks', () => {
  const source = readFileSync(
    new URL('../test/fixtures/extensions/runtime-api.epas', import.meta.url),
    'utf8',
  );
  const generated = generateWebModule(source, 'runtime-api.epas');
  assert.deepEqual(generated.manifest.summary, {
    total: 2,
    compatible: 2,
    webScript: 2,
    provider: 0,
    automatedProvider: 0,
    reviewRequired: 0,
    manual: 0,
    complete: true,
  });
  assert.equal(
    generated.module.match(/function NormalizeNumber\(/g)?.length,
    1,
  );
  assert.match(generated.module, /Session\.EvalExpr\(Expr, Self\)/);
  assert.match(generated.module, /Session\.SQLSelect\('select 1'\)/);
  assert.doesNotMatch(generated.module, /ExtensionProviderCall/);
});

test('recognizes the legacy one-argument OLE HTTP_GET provider recipe', () => {
  const source = readFileSync(
    new URL('../test/fixtures/extensions/legacy-http-get.epas', import.meta.url),
    'utf8',
  );
  const generated = generateWebModule(source, 'legacy-http-get.epas');
  assert.equal(generated.manifest.summary.provider, 1);
  assert.equal(generated.manifest.summary.automatedProvider, 1);
  assert.deepEqual(generated.manifest.mappings[0].providerRecipe, {
    kind: 'http-get',
    urlParameter: 'URL',
  });
});

test('recognizes stateful DaData OLE recipes and preserves session updates', () => {
  const source = readFileSync(
    new URL('../test/fixtures/extensions/legacy-dadata.epas', import.meta.url),
    'utf8',
  );
  const generated = generateWebModule(source, 'legacy-dadata.epas');
  assert.equal(generated.manifest.summary.provider, 3);
  assert.equal(generated.manifest.summary.automatedProvider, 3);
  assert.equal(generated.manifest.summary.webScript, 1);
  const recipes = generated.manifest.mappings
    .filter(mapping => mapping.providerRecipe)
    .map(mapping => mapping.providerRecipe);
  assert.deepEqual(recipes.map(recipe => recipe.suggestType), ['party', 'bank', 'address']);
  assert.deepEqual(recipes[0].stateVariables, [
    'value',
    'data.inn',
    'data.state.status',
    'data.bic',
    'data.name.payment',
    'data.postal_code',
    'data.region',
  ]);
  assert.equal(recipes[0].resultVariable, 'DA_FIRM_FIELD');
  assert.equal(recipes[1].resultVariable, 'DA_BANK_GET');
  assert.equal(recipes[2].resultVariable, 'DA_ADDR_FIELD');
  assert.match(generated.module, /ProviderState := ReadJSONFromString\(ProviderResponse\)/);
  assert.match(generated.module, /Session\.SetExprVar\(ProviderName\.AsString, ProviderValue\.Value\)/);
  assert.match(generated.module, /Result := ProviderValue\.AsString/);
});

test('recognizes the forum Word and Excel OLE conversion recipes', () => {
  const source = readFileSync(
    new URL('../test/fixtures/extensions/legacy-office.epas', import.meta.url),
    'utf8',
  );
  const generated = generateWebModule(source, 'legacy-office.epas');
  assert.deepEqual(generated.manifest.summary, {
    total: 2,
    compatible: 2,
    webScript: 0,
    provider: 2,
    automatedProvider: 2,
    reviewRequired: 0,
    manual: 0,
    complete: true,
  });
  assert.deepEqual(
    generated.manifest.mappings.map(mapping => mapping.operation),
    [
      '7032FCD8-4797-4FC2-AAFA-04DBC1EDCFCA',
      '814E06E5-E298-4368-8AC7-45F2E25E1578',
    ],
  );
  assert.deepEqual(
    generated.manifest.mappings.map(mapping => mapping.providerRecipe),
    [
      {
        kind: 'office-document-convert',
        documentType: 'writer',
        inputParameter: 'aInputFile',
        outputParameter: 'aOutputFile',
        formatParameter: 'itemListExt',
      },
      {
        kind: 'office-document-convert',
        documentType: 'calc',
        inputParameter: 'aInputFile',
        outputParameter: 'aOutputFile',
        formatParameter: 'itemListExt',
      },
    ],
  );
  assert.match(
    generated.module,
    /ExtensionProviderCallBoolean\('legacy-office', '7032FCD8-4797-4FC2-AAFA-04DBC1EDCFCA'/,
  );
});

test('generates a mixed inline/provider module at routine granularity', () => {
  const source = readFileSync(new URL('../test/fixtures/extensions/mixed.epas', import.meta.url), 'utf8');
  const generated = generateWebModule(source, 'mixed.epas');
  assert.deepEqual(
    generated.manifest.mappings.map(mapping => mapping.status),
    ['web-script', 'provider'],
  );
  assert.equal(generated.manifest.summary.webScript, 1);
  assert.equal(generated.manifest.summary.provider, 1);
  assert.match(generated.module, /Result := Trim\(Value\)/);
  assert.match(generated.module, /ExtensionProviderCall\('mixed', 'OFFICE_TEXT'/);

  const compatibility = buildRuntimeCompatibility([
    auditSource(source, 'mixed.epas'),
    auditSource(generated.module, 'mixed.wepas'),
  ]);
  assert.equal(compatibility.functions[0].status, 'web-script');
  assert.equal(compatibility.functions[1].status, 'provider');
});
