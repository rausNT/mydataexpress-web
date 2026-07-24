import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { extractForumExtensionSources } from './forum-extension-extract.mjs';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function zip(directory, output, files) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  const result = spawnSync('tar', ['-acf', output, ...Object.keys(files)], {
    cwd: directory,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('extracts unique epas/wepas sources from direct, archive and nested archive attachments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-forum-extract-'));
  const attachments = join(root, 'attachments');
  const output = join(root, 'output');
  const staging = join(root, 'staging');
  mkdirSync(attachments);
  mkdirSync(staging);
  try {
    const direct = Buffer.from('function DirectValue: Integer; begin Result := 1; end;');
    const directName = '1-direct.epas';
    writeFileSync(join(attachments, directName), direct);

    const nestedPath = join(staging, 'nested.zip');
    zip(staging, nestedPath, {
      'nested/module.wepas': 'function WebValue: Integer; begin Result := 2; end;',
    });
    const outerPath = join(attachments, '2-bundle.zip');
    zip(staging, outerPath, {
      'modules/direct-copy.epas': direct,
      'nested.zip': readFileSync(nestedPath),
      'ignored.txt': 'not a module',
    });
    const outer = readFileSync(outerPath);

    const inventoryPath = join(root, 'inventory.json');
    writeFileSync(inventoryPath, JSON.stringify({
      attachments: [
        {
          id: 1,
          originalName: 'direct.epas',
          fileName: directName,
          sha256: hash(direct),
          topicIds: [10],
        },
        {
          id: 2,
          originalName: 'bundle.zip',
          fileName: '2-bundle.zip',
          sha256: hash(outer),
          topicIds: [20],
        },
      ],
    }));

    const report = await extractForumExtensionSources(inventoryPath, attachments, output, {
      generatedAt: '2026-07-24T00:00:00.000Z',
    });
    assert.deepEqual(report.summary, {
      inventoryAttachments: 2,
      availableAttachments: 2,
      processedAttachments: 2,
      archives: 1,
      nestedArchives: 1,
      sourceOccurrences: 3,
      uniqueSources: 2,
      epas: 1,
      wepas: 1,
      errors: 0,
      complete: true,
    }, JSON.stringify(report.errors));
    assert.equal(report.sources.find(item => item.extension === 'epas').occurrences.length, 2);
    assert.equal(JSON.stringify(report).includes('Result := 1'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-empty extraction directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-forum-extract-nonempty-'));
  const output = join(root, 'output');
  mkdirSync(output);
  writeFileSync(join(output, 'old.txt'), 'stale');
  const inventory = join(root, 'inventory.json');
  writeFileSync(inventory, '{"attachments":[]}');
  await assert.rejects(
    extractForumExtensionSources(inventory, root, output),
    /output directory is not empty/,
  );
  rmSync(root, { recursive: true, force: true });
});
