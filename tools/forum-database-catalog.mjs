import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 20_000;
const DATABASE_ARCHIVES = new Set(['zip', 'rar', '7z']);
const AUXILIARY_NAME = /(?:templates?|шаблон|html|javascript|\bjs\b|формы|статус|дополн|образец|тест формы)/i;
const CREDENTIAL_TEXT = /(?:логин|парол|пользовател|уч[её]тн\w*\s+запис|для входа)/i;

function decodeHtml(value) {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlToText(value) {
  return decodeHtml(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|blockquote|div)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function posts(html) {
  return [...html.matchAll(/<div\s+class=(["'])content\1[^>]*>([\s\S]*?)<\/div>/gi)]
    .map(match => htmlToText(match[2]))
    .filter(Boolean);
}

function description(text) {
  const firstParagraph = text.split(/\n{2,}/)[0] || text;
  return firstParagraph.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function credentialHints(text) {
  const hints = [];
  for (const fragment of text.split(/\n+|(?<=[.!?])\s+/)) {
    const normalized = fragment.replace(/\s+/g, ' ').trim();
    if (!CREDENTIAL_TEXT.test(normalized) || normalized.length < 4) continue;
    const bounded = normalized.slice(0, 300);
    if (!hints.includes(bounded)) hints.push(bounded);
    if (hints.length === 12) break;
  }
  return hints;
}

function topicTitle(topic) {
  return topic.titles.find(value => value && !/^\d+$/.test(value)) ||
    topic.titles[0] || `Тема ${topic.id}`;
}

function topicPageUrl(catalogUrl, topicId, start) {
  const url = new URL('/viewtopic.php', catalogUrl);
  url.protocol = 'https:';
  url.searchParams.set('t', String(topicId));
  if (start) url.searchParams.set('start', String(start));
  return url.href;
}

async function fetchText(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'DataExpress-Web-Demo-Catalog/1.0' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, concurrency, operation) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      result[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}

export async function buildForumDatabaseCatalog(inventory, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = 6,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!inventory || !Array.isArray(inventory.topics) || !Array.isArray(inventory.attachments)) {
    throw new Error('forum inventory is invalid');
  }
  const attachmentsById = new Map(inventory.attachments.map(item => [item.id, item]));
  const topics = await mapLimit(inventory.topics, concurrency, async topic => {
    const pageTexts = await mapLimit(topic.pages, Math.min(4, concurrency), async start => {
      const url = topicPageUrl(inventory.catalogUrl, topic.id, start);
      return posts(await fetchText(url, fetchImpl, timeoutMs));
    });
    const allPosts = pageTexts.flat();
    const attachments = topic.attachmentIds
      .map(id => attachmentsById.get(id))
      .filter(Boolean)
      .map(item => ({
        id: item.id,
        name: item.originalName,
        extension: item.extension,
        url: item.url,
        auxiliary: AUXILIARY_NAME.test(item.originalName || ''),
      }));
    const candidates = attachments.filter(item =>
      DATABASE_ARCHIVES.has(item.extension) && !item.auxiliary);
    return {
      id: topic.id,
      title: topicTitle(topic),
      sourceUrl: topicPageUrl(inventory.catalogUrl, topic.id, 0),
      description: allPosts.length ? description(allPosts[0]) : '',
      credentialHints: credentialHints(allPosts.join('\n')),
      recommendedAttachmentId: candidates.at(-1)?.id || null,
      attachments,
      errors: topic.errors || [],
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    sourceUrl: inventory.catalogUrl,
    topics,
    summary: {
      topics: topics.length,
      withDatabaseCandidate: topics.filter(topic => topic.recommendedAttachmentId !== null).length,
      withCredentialHints: topics.filter(topic => topic.credentialHints.length > 0).length,
      errors: topics.reduce((total, topic) => total + topic.errors.length, 0),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inventoryPath = args[0];
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : '';
  if (!inventoryPath) throw new Error('Usage: node tools/forum-database-catalog.mjs <inventory.json> [--output catalog.json]');
  const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
  const catalog = await buildForumDatabaseCatalog(inventory);
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (output) await writeFile(resolve(output), json);
  else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
