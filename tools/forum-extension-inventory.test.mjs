import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForumExtensionInventory } from './forum-extension-inventory.mjs';

function response(body, {
  status = 200,
  headers = {},
} = {}) {
  return new Response(body, { status, headers });
}

test('crawls catalog topics, pagination and attachments without copying source into the report', async () => {
  const pages = new Map([
    ['https://forum.example/exts.php', response(`
      <a href="viewtopic.php?f=16&amp;t=2">Second extension</a>
      <a href="/viewtopic.php?t=1">First extension</a>
      <a href="/download/file.php?id=9">Direct attachment</a>
    `)],
    ['https://forum.example/viewtopic.php?t=1', response(`
      <a href="viewtopic.php?t=1&amp;start=20">2</a>
      <a href="download/file.php?id=10">source</a>
    `)],
    ['https://forum.example/viewtopic.php?t=1&start=20', response(`
      <a href="/download/file.php?id=11">archive</a>
    `)],
    ['https://forum.example/viewtopic.php?t=2', response('<p>No attachments</p>')],
    ['https://forum.example/download/file.php?id=9', response('direct', {
      headers: { 'content-disposition': 'attachment; filename="direct.epas"' },
    })],
    ['https://forum.example/download/file.php?id=10', response('private source text', {
      headers: { 'content-disposition': "attachment; filename*=UTF-8''module.epas" },
    })],
    ['https://forum.example/download/file.php?id=11', response('PK archive bytes', {
      headers: { 'content-disposition': 'attachment; filename="bundle.zip"' },
    })],
  ]);
  const inventory = await buildForumExtensionInventory({
    catalogUrl: 'https://forum.example/exts.php',
    fetchImpl: async url => {
      const item = pages.get(String(url));
      if (!item) return response('not found', { status: 404 });
      return item.clone();
    },
    concurrency: 2,
    generatedAt: '2026-07-24T00:00:00.000Z',
  });

  assert.deepEqual(inventory.summary, {
    topics: 2,
    topicPages: 3,
    topicErrors: 0,
    attachments: 3,
    attachmentErrors: 0,
    downloaded: 0,
    totalBytes: 41,
    types: { epas: 2, zip: 1 },
    complete: true,
  });
  assert.deepEqual(inventory.topics.map(item => item.id), [1, 2]);
  assert.deepEqual(inventory.topics[0].attachmentIds, [10, 11]);
  assert.deepEqual(inventory.attachments.map(item => item.id), [9, 10, 11]);
  assert.deepEqual(inventory.attachments[1].topicIds, [1]);
  assert.equal(JSON.stringify(inventory).includes('private source text'), false);
});

test('strict completeness records topic and attachment failures', async () => {
  const inventory = await buildForumExtensionInventory({
    catalogUrl: 'https://forum.example/exts.php',
    fetchImpl: async url => {
      if (String(url).endsWith('/exts.php')) {
        return response(`
          <a href="/viewtopic.php?t=1">Broken topic</a>
          <a href="/download/file.php?id=5">Broken file</a>
        `);
      }
      return response('unavailable', { status: 503 });
    },
    timeoutMs: 100,
  });

  assert.equal(inventory.summary.topicErrors, 1);
  assert.equal(inventory.summary.attachmentErrors, 1);
  assert.equal(inventory.summary.complete, false);
});
