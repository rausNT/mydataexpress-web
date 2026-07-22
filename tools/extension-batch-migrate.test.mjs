import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./extension-batch-migrate.mjs', import.meta.url));

function desktop(operation, secondOperation = '') {
  const declaration = name => `
{@function
OrigName=${name}Impl
Name=${name}
Args=s
Result=s
@}
function ${name}Impl(Value: String): String;
begin
  Result := Value;
end;
`;
  return `{@module
Author=Batch test
Version=1.0
Description=Batch fixture
@}
${declaration(operation)}${secondOperation ? declaration(secondOperation) : ''}`;
}

function web(operation) {
  return `{@module
Author=Batch test
Version=1.0-web
Description=Existing web module
@}
{@function
Name=${operation}
@}
function ${operation}Impl(Value: String): String;
begin
  Result := Value;
end;
`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-batch-'));
  const input = join(root, 'extensions');
  const output = join(root, 'bundle');
  mkdirSync(input);
  return { root, input, output };
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

test('batch migration preserves existing web modules and creates a portable provider bundle', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'nested', 'Alpha.epas'), desktop('ALPHA'));
    write(join(input, 'Beta.epas'), desktop('BETA'));
    write(join(input, 'BetaWeb.wepas'), web('BETA'));

    const result = spawnSync(process.execPath, [
      cli, input, '--output-dir', output, '--start-port', '12000', '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);

    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.deepEqual(index.summary, {
      desktopModules: 2,
      webModules: 1,
      generated: 1,
      preserved: 1,
      blocked: 0,
      existingNeedsReview: 0,
      manualMappings: 0,
      providerImplementationsRequired: 1,
      orphanWebMappings: 0,
      invalidMappings: 0,
      complete: false,
    });
    assert.ok(existsSync(join(output, 'Beta.epas')));
    assert.ok(existsSync(join(output, 'BetaWeb.wepas')));
    assert.ok(existsSync(join(output, 'nested', 'Alpha.epas')));
    assert.ok(existsSync(join(output, 'nested', 'Alpha.wepas')));
    assert.ok(existsSync(join(output, 'dataexpress-provider-sdk.mjs')));

    const provider = join(output, 'nested', 'Alpha.provider.mjs');
    assert.match(readFileSync(provider, 'utf8'), /\.\.\/dataexpress-provider-sdk\.mjs/);
    assert.match(readFileSync(join(output, 'dxwebsrv.providers.cfg.example'), 'utf8'), /127\.0\.0\.1:12000/);
    const syntax = spawnSync(process.execPath, ['--check', provider], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict batch migration blocks partial web coverage without adding duplicates', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'Partial.epas'), desktop('ONE', 'TWO'));
    write(join(input, 'Existing.wepas'), web('ONE'));
    const result = spawnSync(process.execPath, [cli, input, '--output-dir', output, '--strict'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.complete, false);
    assert.equal(index.modules[0].state, 'blocked');
    assert.equal(index.modules[0].reason, 'partial-web-coverage');
    assert.equal(existsSync(join(output, 'Partial.wepas')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict batch migration reports provider-name collisions and manual mappings', () => {
  const collision = fixture();
  try {
    write(join(collision.input, 'one', 'Shared.epas'), desktop('FIRST'));
    write(join(collision.input, 'two', 'Shared.epas'), desktop('SECOND'));
    const result = spawnSync(process.execPath, [
      cli, collision.input, '--output-dir', collision.output, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(collision.output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.blocked, 2);
    assert.ok(index.modules.every(item => item.reason === 'duplicate-provider-name'));
  } finally {
    rmSync(collision.root, { recursive: true, force: true });
  }

  const manual = fixture();
  try {
    write(join(manual.input, 'Unsafe.epas'), `
{@function
OrigName=Mutate
Name=MUTATE
Args=n
Result=b
@}
function Mutate(var Value: Integer): Boolean;
begin
  Result := True;
end;
`);
    const result = spawnSync(process.execPath, [
      cli, manual.input, '--output-dir', manual.output, '--strict',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const index = JSON.parse(readFileSync(join(manual.output, 'migration-index.json'), 'utf8'));
    assert.equal(index.summary.manualMappings, 1);
    assert.equal(index.modules[0].reason, 'manual-adaptation-required');
  } finally {
    rmSync(manual.root, { recursive: true, force: true });
  }
});

test('batch migration refuses a non-empty output directory', () => {
  const { root, input, output } = fixture();
  try {
    write(join(input, 'Safe.epas'), desktop('SAFE'));
    write(join(output, 'keep.txt'), 'user data');
    const result = spawnSync(process.execPath, [cli, input, '--output-dir', output], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Output directory must be empty/);
    assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'user data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
