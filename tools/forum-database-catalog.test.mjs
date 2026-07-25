import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForumDatabaseCatalog } from './forum-database-catalog.mjs';

function response(body, status = 200) {
  return new Response(body, { status });
}

test('builds demo descriptions, credential hints and ignores auxiliary archives', async () => {
  const inventory = {
    catalogUrl: 'https://forum.example/viewforum.php?f=40',
    topics: [{
      id: 10,
      titles: ['Demo clinic'],
      pages: [0, 10],
      attachmentIds: [1, 2, 3],
      errors: [],
    }],
    attachments: [
      { id: 1, originalName: 'clinic-old.zip', extension: 'zip', url: 'https://forum.example/download/file.php?id=1' },
      { id: 2, originalName: 'templates.zip', extension: 'zip', url: 'https://forum.example/download/file.php?id=2' },
      { id: 3, originalName: 'clinic-new.7z', extension: '7z', url: 'https://forum.example/download/file.php?id=3' },
    ],
  };
  const pages = new Map([
    ['https://forum.example/viewtopic.php?t=10', response('<div class="content">Демо для небольшой клиники.<br>Логин: Врач, пароль: 123.</div>')],
    ['https://forum.example/viewtopic.php?t=10&start=10', response('<div class="content">Обновлена печать.</div>')],
  ]);
  const catalog = await buildForumDatabaseCatalog(inventory, {
    fetchImpl: async url => pages.get(String(url)) || response('missing', 404),
    generatedAt: '2026-07-25T00:00:00.000Z',
  });

  assert.equal(catalog.summary.topics, 1);
  assert.equal(catalog.summary.withDatabaseCandidate, 1);
  assert.equal(catalog.summary.withCredentialHints, 1);
  assert.equal(catalog.topics[0].description, 'Демо для небольшой клиники. Логин: Врач, пароль: 123.');
  assert.deepEqual(catalog.topics[0].credentialHints, ['Логин: Врач, пароль: 123.']);
  assert.equal(catalog.topics[0].recommendedAttachmentId, 3);
  assert.equal(catalog.topics[0].attachments[1].auxiliary, true);
});
