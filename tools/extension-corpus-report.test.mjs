import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildExtensionCorpusReport } from './extension-corpus-report.mjs';

const metadata = ({ name, result = '', body }) => `
{@function
OrigName=${name}
Name=${name.toUpperCase()}
Args=
Result=${result}
Group=Corpus
Description=Corpus fixture
@}
${body}
`;

test('reports portable, provider and manual mappings without copying source code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-corpus-'));
  try {
    writeFileSync(join(directory, 'portable.epas'), metadata({
      name: 'PortableValue',
      result: 'n',
      body: `function PortableValue(Value: Integer): Integer;
begin
  Result := Value + 1;
end;`,
    }));
    writeFileSync(join(directory, 'office.epas'), metadata({
      name: 'OfficeValue',
      result: 's',
      body: `function OfficeValue: String;
var
  App: OleVariant;
begin
  App := CreateOleObject('Word.Application');
  Result := App.Name;
end;`,
    }));
    writeFileSync(join(directory, 'manual.epas'), metadata({
      name: 'DesktopOnly',
      body: `procedure DesktopOnly(var Value: TDesktopHandle);
begin
  NativeThing(Value);
end;`,
    }));

    const report = buildExtensionCorpusReport(directory, {
      generatedAt: '2026-07-23T00:00:00.000Z',
    });
    assert.deepEqual(report.summary, {
      modules: 3,
      mappings: 3,
      webScript: 1,
      provider: 1,
      manual: 1,
      reviewRequired: 0,
      complete: false,
    });
    assert.deepEqual(
      report.modules.map(module => module.file),
      ['manual.epas', 'office.epas', 'portable.epas'],
    );
    assert.deepEqual(
      report.modules.flatMap(module => module.mappings.map(mapping => mapping.status)).sort(),
      ['manual', 'provider', 'web-script'],
    );
    assert.equal(JSON.stringify(report).includes('Word.Application'), false);
    assert.equal(JSON.stringify(report).includes('NativeThing(Value)'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict modes distinguish manual mappings from review-required network code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dataexpress-corpus-cli-'));
  const cli = fileURLToPath(new URL('./extension-corpus-report.mjs', import.meta.url));
  try {
    writeFileSync(join(directory, 'network.epas'), metadata({
      name: 'NetworkValue',
      result: 's',
      body: `function NetworkValue(Url: String): String;
var
  Client: THTTPClient;
begin
  Client := THTTPClient.Create;
  try
    Client.Send('GET', Url);
    Result := Client.Content;
  finally
    Client.Free;
  end;
end;`,
    }));

    const normal = spawnSync(process.execPath, [cli, directory, '--strict'], {
      encoding: 'utf8',
    });
    assert.equal(normal.status, 0, normal.stderr);
    const report = JSON.parse(normal.stdout);
    assert.equal(report.summary.complete, true);
    assert.equal(report.summary.reviewRequired, 1);

    const reviewed = spawnSync(process.execPath, [cli, directory, '--strict-review'], {
      encoding: 'utf8',
    });
    assert.equal(reviewed.status, 1, reviewed.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI does not misinterpret an option value as its input directory', () => {
  const cli = fileURLToPath(new URL('./extension-corpus-report.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--output', 'report.json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
