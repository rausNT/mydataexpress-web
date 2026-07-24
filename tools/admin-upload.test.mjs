import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('database import service passes its security and config tests', (context) => {
  if (process.platform === 'win32') {
    context.skip('The deployment service is Linux-only and is exercised by the Ubuntu CI job');
    return;
  }
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python3', []], ['python', []]]
    : [['python3', []], ['python', []]];
  const available = candidates.find(([command, prefix]) =>
    spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' }).status === 0);
  if (!available) {
    context.skip('Python is not installed in this local environment');
    return;
  }
  const [command, prefix] = available;
  const result = spawnSync(
    command,
    [...prefix, '-m', 'unittest', 'discover', '-s', 'deploy/admin', '-p', 'test_*.py'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('admin page uploads the raw selected file with bearer authentication', () => {
  const page = readFileSync('deploy/admin/index.html', 'utf8');
  assert.match(page, /Authorization.*Bearer/);
  assert.match(page, /X-Database-Alias/);
  assert.match(page, /X-Filename/);
  assert.match(page, /request\.send\(selected\)/);
  assert.match(page, /sessionStorage/);
  assert.doesNotMatch(page, /localStorage/);
});
