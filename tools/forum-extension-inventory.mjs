import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CATALOG = 'https://forum.mydataexpress.ru/exts.php';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textContent(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      href: decodeHtml(match[3].trim()),
      text: textContent(match[5]),
    }));
}

function sameForumHost(url, catalogUrl) {
  return url.hostname.toLowerCase() === new URL(catalogUrl).hostname.toLowerCase();
}

function topicLink(href, baseUrl, catalogUrl) {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (!sameForumHost(url, catalogUrl) || !url.pathname.endsWith('/viewtopic.php')) return null;
  const id = url.searchParams.get('t');
  if (!/^\d+$/.test(id || '')) return null;
  url.protocol = 'https:';
  url.hash = '';
  url.search = `?t=${id}`;
  return { id: Number(id), url: url.href };
}

function topicPageLink(href, baseUrl, catalogUrl, topicId) {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (!sameForumHost(url, catalogUrl) || !url.pathname.endsWith('/viewtopic.php')) return null;
  if (url.searchParams.get('t') !== String(topicId)) return null;
  const start = url.searchParams.get('start') || '0';
  if (!/^\d+$/.test(start)) return null;
  url.protocol = 'https:';
  url.hash = '';
  url.search = `?t=${topicId}${start === '0' ? '' : `&start=${start}`}`;
  return { start: Number(start), url: url.href };
}

function catalogPageLink(href, baseUrl, catalogUrl) {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  const catalog = new URL(catalogUrl);
  if (!sameForumHost(url, catalogUrl) || url.pathname !== catalog.pathname) return null;
  const forumId = catalog.searchParams.get('f');
  if (forumId && url.searchParams.get('f') !== forumId) return null;
  const start = url.searchParams.get('start') || '0';
  if (!/^\d+$/.test(start)) return null;
  url.protocol = 'https:';
  url.hash = '';
  url.search = `${forumId ? `?f=${forumId}&` : '?'}start=${start}`;
  return { start: Number(start), url: url.href };
}

function attachmentLink(href, baseUrl, catalogUrl, label = '') {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (!sameForumHost(url, catalogUrl) || !url.pathname.endsWith('/download/file.php')) return null;
  const id = url.searchParams.get('id');
  if (!/^\d+$/.test(id || '')) return null;
  url.protocol = 'https:';
  url.hash = '';
  url.search = `?id=${id}`;
  return { id: Number(id), url: url.href, label: label.trim() };
}

function parseContentDisposition(value, id) {
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value || '');
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return extended[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(value || '');
  if (quoted) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(value || '');
  return plain ? plain[1].trim() : `attachment-${id}`;
}

function safeFilename(value, id) {
  const name = basename(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  return `${id}-${name || `attachment-${id}`}`;
}

function extension(value) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(value);
  return match ? match[1].toLowerCase() : '';
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
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

async function fetchWithRetry(url, {
  fetchImpl,
  timeoutMs,
  method = 'GET',
  retries = 2,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'DataExpress-Web-Compatibility-Inventory/1.0',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolvePromise => setTimeout(resolvePromise, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function addAttachment(target, item, topicId = null) {
  let attachment = target.get(item.id);
  if (!attachment) {
    attachment = {
      id: item.id,
      url: item.url,
      topicIds: [],
      labels: [],
    };
    target.set(item.id, attachment);
  }
  if (item.label && !attachment.labels.includes(item.label)) {
    attachment.labels.push(item.label);
  }
  if (topicId !== null && !attachment.topicIds.includes(topicId)) {
    attachment.topicIds.push(topicId);
  }
}

async function inspectAttachment(attachment, options, budget) {
  const response = await fetchWithRetry(attachment.url, options);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > options.maxAttachmentBytes) {
    throw new Error(`declared size ${declaredLength} exceeds ${options.maxAttachmentBytes}`);
  }
  if (budget.bytes + declaredLength > options.maxTotalBytes) {
    throw new Error(`total download limit ${options.maxTotalBytes} would be exceeded`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > options.maxAttachmentBytes) {
    throw new Error(`downloaded size ${bytes.byteLength} exceeds ${options.maxAttachmentBytes}`);
  }
  if (budget.bytes + bytes.byteLength > options.maxTotalBytes) {
    throw new Error(`total download limit ${options.maxTotalBytes} was exceeded`);
  }
  budget.bytes += bytes.byteLength;

  const originalName = parseContentDisposition(response.headers.get('content-disposition'), attachment.id);
  const fileName = safeFilename(originalName, attachment.id);
  if (options.downloadDir) {
    await writeFile(resolve(options.downloadDir, fileName), bytes, { flag: 'wx' });
  }
  return {
    ...attachment,
    topicIds: [...attachment.topicIds].sort((left, right) => left - right),
    originalName,
    fileName,
    extension: extension(originalName),
    contentType: response.headers.get('content-type') || '',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    downloaded: Boolean(options.downloadDir),
  };
}

export async function buildForumExtensionInventory({
  catalogUrl = DEFAULT_CATALOG,
  fetchImpl = globalThis.fetch,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  downloadDir = '',
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  inspectAttachments = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const options = {
    fetchImpl,
    timeoutMs,
    downloadDir,
    maxAttachmentBytes,
    maxTotalBytes,
  };
  if (downloadDir) await mkdir(resolve(downloadDir), { recursive: true });

  const topicMap = new Map();
  const attachmentMap = new Map();
  const catalogPages = new Map([[0, catalogUrl]]);
  let catalogPageIndex = 0;
  while (catalogPageIndex < catalogPages.size) {
    const starts = [...catalogPages.keys()].sort((left, right) => left - right);
    const start = starts[catalogPageIndex];
    const pageUrl = catalogPages.get(start);
    catalogPageIndex += 1;
    const catalogResponse = await fetchWithRetry(pageUrl, options);
    const catalogHtml = await catalogResponse.text();
    for (const anchor of anchors(catalogHtml)) {
      const page = catalogPageLink(anchor.href, pageUrl, catalogUrl);
      if (page && !catalogPages.has(page.start)) {
        catalogPages.set(page.start, page.url);
      }
      const topic = topicLink(anchor.href, pageUrl, catalogUrl);
      if (topic) {
        const current = topicMap.get(topic.id) || { ...topic, titles: [] };
        if (anchor.text && !current.titles.includes(anchor.text)) current.titles.push(anchor.text);
        topicMap.set(topic.id, current);
      }
      const attachment = attachmentLink(anchor.href, pageUrl, catalogUrl, anchor.text);
      if (attachment) addAttachment(attachmentMap, attachment);
    }
  }

  const topics = [...topicMap.values()].sort((left, right) => left.id - right.id);
  const topicResults = await mapLimit(topics, concurrency, async topic => {
    const pages = new Map([[0, topic.url]]);
    const attachments = new Map();
    const errors = [];
    let pageIndex = 0;
    while (pageIndex < [...pages.keys()].length) {
      const starts = [...pages.keys()].sort((left, right) => left - right);
      const start = starts[pageIndex];
      const pageUrl = pages.get(start);
      pageIndex += 1;
      try {
        const response = await fetchWithRetry(pageUrl, options);
        const html = await response.text();
        for (const anchor of anchors(html)) {
          const page = topicPageLink(anchor.href, pageUrl, catalogUrl, topic.id);
          if (page && !pages.has(page.start)) pages.set(page.start, page.url);
          const attachment = attachmentLink(anchor.href, pageUrl, catalogUrl, anchor.text);
          if (attachment) attachments.set(attachment.id, attachment);
        }
      } catch (error) {
        errors.push({
          start,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const attachment of attachments.values()) addAttachment(attachmentMap, attachment, topic.id);
    return {
      id: topic.id,
      url: topic.url,
      titles: topic.titles,
      pages: [...pages.keys()].sort((left, right) => left - right),
      attachmentIds: [...attachments.keys()].sort((left, right) => left - right),
      errors,
    };
  });

  const budget = { bytes: 0 };
  const attachmentItems = [...attachmentMap.values()].sort((left, right) => left.id - right.id);
  const attachments = inspectAttachments
    ? await mapLimit(attachmentItems, 1, async attachment => {
      try {
        return await inspectAttachment(attachment, options, budget);
      } catch (error) {
        return {
          ...attachment,
          topicIds: [...attachment.topicIds].sort((left, right) => left - right),
          error: error instanceof Error ? error.message : String(error),
          downloaded: false,
        };
      }
    })
    : attachmentItems.map(attachment => {
      const originalName = attachment.labels.find(label => extension(label)) ||
        attachment.labels[0] || `attachment-${attachment.id}`;
      return {
        ...attachment,
        topicIds: [...attachment.topicIds].sort((left, right) => left - right),
        originalName,
        fileName: safeFilename(originalName, attachment.id),
        extension: extension(originalName),
        contentType: '',
        bytes: 0,
        sha256: '',
        downloaded: false,
        inspected: false,
      };
    });

  const types = {};
  for (const attachment of attachments) {
    const key = attachment.extension || 'unknown';
    types[key] = (types[key] || 0) + 1;
  }
  const topicErrors = topicResults.reduce((total, topic) => total + topic.errors.length, 0);
  const attachmentErrors = attachments.filter(item => item.error).length;
  return {
    schemaVersion: 1,
    generatedAt,
    catalogUrl,
    catalogPages: [...catalogPages.keys()].sort((left, right) => left - right),
    summary: {
      topics: topicResults.length,
      topicPages: topicResults.reduce((total, topic) => total + topic.pages.length, 0),
      topicErrors,
      attachments: attachments.length,
      attachmentErrors,
      downloaded: attachments.filter(item => item.downloaded).length,
      totalBytes: attachments.reduce((total, item) => total + (item.bytes || 0), 0),
      types,
      complete: topicResults.length > 0 && topicErrors === 0 &&
        attachments.length > 0 && attachmentErrors === 0,
    },
    topics: topicResults,
    attachments,
  };
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  try {
    const output = optionValue(args, '--output');
    const downloadDir = optionValue(args, '--download-dir');
    const inventory = await buildForumExtensionInventory({
      catalogUrl: optionValue(args, '--catalog') || DEFAULT_CATALOG,
      concurrency: positiveInteger(optionValue(args, '--concurrency'), DEFAULT_CONCURRENCY, '--concurrency', 16),
      timeoutMs: positiveInteger(optionValue(args, '--timeout'), DEFAULT_TIMEOUT_MS, '--timeout', 120_000),
      downloadDir,
      maxAttachmentBytes: positiveInteger(
        optionValue(args, '--max-attachment-bytes'),
        DEFAULT_MAX_ATTACHMENT_BYTES,
        '--max-attachment-bytes',
      ),
      maxTotalBytes: positiveInteger(
        optionValue(args, '--max-total-bytes'),
        DEFAULT_MAX_TOTAL_BYTES,
        '--max-total-bytes',
      ),
      inspectAttachments: !args.includes('--metadata-only'),
    });
    const json = `${JSON.stringify(inventory, null, 2)}\n`;
    if (output) await writeFile(resolve(output), json);
    else process.stdout.write(json);
    if (args.includes('--strict') && !inventory.summary.complete) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
