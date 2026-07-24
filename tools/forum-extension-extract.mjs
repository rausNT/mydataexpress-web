import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.dxp']);
const SOURCE_EXTENSIONS = new Set(['.epas', '.wepas']);
const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_DEPTH = 4;
let cachedTarCharsetArguments;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function safeRelativePath(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) ||
      normalized.includes('\0')) return '';
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return normalized;
}

function tarEntryForSafety(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => {
    const byte = Number.parseInt(octal, 8);
    return byte === 47 || byte === 92 ? '/' : '_';
  });
}

function safeFilename(value) {
  return basename(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160);
}

function tarResult(args, {
  input,
  maxBuffer,
} = {}) {
  const result = spawnSync('tar', args, {
    input,
    encoding: null,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr || []).toString('utf8').trim();
    throw new Error(`tar ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return Buffer.from(result.stdout || []);
}

function tarCharsetArguments() {
  if (cachedTarCharsetArguments) return [...cachedTarCharsetArguments];
  const probe = spawnSync('tar', [
    '--options', 'hdrcharset=CP1251', '--version',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  cachedTarCharsetArguments =
    !probe.error && probe.status === 0
      ? ['--options', 'hdrcharset=CP1251']
      : [];
  return [...cachedTarCharsetArguments];
}

function archiveEntries(source, maximum) {
  const args = [...tarCharsetArguments(), '-tf', source.path || '-'];
  const output = tarResult(args, {
    input: source.bytes,
    maxBuffer: Math.max(1024 * 1024, maximum * 512),
  }).toString('utf8');
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (entries.length > maximum) {
    throw new Error(`archive contains ${entries.length} entries; maximum is ${maximum}`);
  }
  return entries;
}

function archiveEntryBytes(source, entry, maximum) {
  const args = [...tarCharsetArguments(), '-xOf', source.path || '-', entry];
  const bytes = tarResult(args, {
    input: source.bytes,
    maxBuffer: maximum + 1024 * 1024,
  });
  if (bytes.byteLength > maximum) {
    throw new Error(`${entry} is ${bytes.byteLength} bytes; maximum is ${maximum}`);
  }
  return bytes;
}

async function candidateFiles(root, maximum) {
  const rootPath = await realpath(root);
  const result = [];
  const pending = [rootPath];
  while (pending.length) {
    const current = pending.pop();
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!item.isFile()) continue;
      const actual = await realpath(path);
      if (actual !== rootPath && !actual.startsWith(`${rootPath}\\`) && !actual.startsWith(`${rootPath}/`)) {
        throw new Error(`extracted path escapes temporary root: ${actual}`);
      }
      const itemExtension = extname(item.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(itemExtension) || ARCHIVE_EXTENSIONS.has(itemExtension)) {
        result.push(actual);
        if (result.length > maximum) {
          throw new Error(`archive contains more than ${maximum} candidate files`);
        }
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

async function extractArchiveCandidates(archivePath, context, limits, handlers) {
  const directory = await mkdtemp(join(tmpdir(), 'dataexpress-forum-fallback-'));
  try {
    const patterns = [...SOURCE_EXTENSIONS, ...ARCHIVE_EXTENSIONS].map(item => `*${item}`);
    const result = spawnSync('tar', [
      ...tarCharsetArguments(),
      '-xf', archivePath,
      '-C', directory,
      ...patterns,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    const files = await candidateFiles(directory, limits.maxEntries);
    if (!files.length) {
      const detail = String(result.stderr || '').trim();
      throw new Error(`fallback extraction found no candidate files${detail ? `: ${detail}` : ''}`);
    }
    for (const path of files) {
      const itemExtension = extname(path).toLowerCase();
      const bytes = await readFile(path);
      const archivePathName = portablePath(relative(directory, path));
      if (SOURCE_EXTENSIONS.has(itemExtension)) {
        await handlers.source(bytes, basename(path), {
          ...context,
          archivePath: archivePathName,
        });
      } else {
        await handlers.archive({ path, bytes }, {
          ...context,
          archivePath: [context.archivePath, archivePathName].filter(Boolean).join('!'),
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function emptyOutputDirectory(path) {
  await mkdir(path, { recursive: true });
  const existing = await readdir(path);
  if (existing.length) throw new Error(`output directory is not empty: ${path}`);
}

function portablePath(path) {
  return path.replaceAll('\\', '/');
}

export async function extractForumExtensionSources(inventoryPath, attachmentsDirectory, outputDirectory, {
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxDepth = DEFAULT_MAX_DEPTH,
  generatedAt = new Date().toISOString(),
} = {}) {
  const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
  if (!Array.isArray(inventory.attachments)) throw new Error('inventory attachments are missing');
  const attachmentsRoot = resolve(attachmentsDirectory);
  const outputRoot = resolve(outputDirectory);
  const sourcesRoot = resolve(outputRoot, 'sources');
  await emptyOutputDirectory(outputRoot);
  await mkdir(sourcesRoot);

  const sourceMap = new Map();
  const errors = [];
  let processedAttachments = 0;
  let archives = 0;
  let nestedArchives = 0;
  let sourceOccurrences = 0;

  async function recordSource(bytes, name, occurrence) {
    if (bytes.byteLength > maxSourceBytes) {
      throw new Error(`${name} is ${bytes.byteLength} bytes; maximum source size is ${maxSourceBytes}`);
    }
    const hash = sha256(bytes);
    const sourceExtension = extname(name).toLowerCase();
    let source = sourceMap.get(hash);
    if (!source) {
      const outputName = `${hash.slice(0, 16)}-${safeFilename(name) || `module${sourceExtension}`}`;
      const outputPath = resolve(sourcesRoot, outputName);
      await writeFile(outputPath, bytes, { flag: 'wx' });
      source = {
        sha256: hash,
        bytes: bytes.byteLength,
        extension: sourceExtension.slice(1),
        output: portablePath(relative(outputRoot, outputPath)),
        names: [],
        occurrences: [],
      };
      sourceMap.set(hash, source);
    }
    if (!source.names.includes(name)) source.names.push(name);
    source.occurrences.push(occurrence);
    sourceOccurrences += 1;
  }

  async function inspectArchive(source, context, depth) {
    if (depth > maxDepth) throw new Error(`nested archive depth exceeds ${maxDepth}`);
    const sourceBytes = source.bytes || await readFile(source.path);
    if (sourceBytes.byteLength > maxArchiveBytes) {
      throw new Error(`archive is ${sourceBytes.byteLength} bytes; maximum is ${maxArchiveBytes}`);
    }
    let temporaryDirectory = '';
    let archivePath = source.path;
    if (!archivePath) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'dataexpress-forum-archive-'));
      archivePath = resolve(
        temporaryDirectory,
        `nested${extname(context.archivePath || '') || '.bin'}`,
      );
      await writeFile(archivePath, sourceBytes);
    }
    try {
      const archiveSource = { path: archivePath };
      const entries = archiveEntries(archiveSource, maxEntries);
      const extracted = [];
      let fallback = false;
      for (const entry of entries) {
        const safetyEntry = tarEntryForSafety(entry);
        const directoryEntry = /[\\/]$/.test(safetyEntry);
        const safeEntry = safeRelativePath(safetyEntry.replace(/[\\/]+$/, ''));
        if (!safeEntry) {
          errors.push({ ...context, entry, error: 'unsafe archive entry path' });
          continue;
        }
        if (directoryEntry || safeEntry.startsWith('__MACOSX/') ||
            basename(safeEntry).startsWith('._')) continue;
        const entryExtension = extname(safeEntry).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(entryExtension) && !ARCHIVE_EXTENSIONS.has(entryExtension)) continue;
        try {
          const maximum = SOURCE_EXTENSIONS.has(entryExtension) ? maxSourceBytes : maxArchiveBytes;
          const bytes = archiveEntryBytes(archiveSource, entry, maximum);
          extracted.push({ safeEntry, entryExtension, bytes });
        } catch {
          fallback = true;
          break;
        }
      }
      if (fallback) {
        await extractArchiveCandidates(archivePath, context, { maxEntries }, {
          source: recordSource,
          archive: async (nestedSource, nestedContext) => {
            nestedArchives += 1;
            await inspectArchive(nestedSource, nestedContext, depth + 1);
          },
        });
      } else {
        for (const item of extracted) {
          if (SOURCE_EXTENSIONS.has(item.entryExtension)) {
            await recordSource(item.bytes, basename(item.safeEntry), {
              ...context,
              archivePath: item.safeEntry,
            });
          } else {
            nestedArchives += 1;
            await inspectArchive({ bytes: item.bytes }, {
              ...context,
              archivePath: [context.archivePath, item.safeEntry].filter(Boolean).join('!'),
            }, depth + 1);
          }
        }
      }
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  for (const attachment of inventory.attachments) {
    if (attachment.error || !attachment.fileName || !attachment.sha256) continue;
    const path = resolve(attachmentsRoot, attachment.fileName);
    const context = {
      attachmentId: attachment.id,
      attachmentName: attachment.originalName,
      topicIds: attachment.topicIds || [],
    };
    try {
      const bytes = await readFile(path);
      const actualHash = sha256(bytes);
      if (actualHash !== attachment.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${attachment.sha256}, got ${actualHash}`);
      }
      const attachmentExtension = extname(attachment.originalName || attachment.fileName).toLowerCase();
      if (SOURCE_EXTENSIONS.has(attachmentExtension)) {
        await recordSource(bytes, attachment.originalName, context);
      } else if (ARCHIVE_EXTENSIONS.has(attachmentExtension)) {
        archives += 1;
        await inspectArchive({ path, bytes }, context, 0);
      }
      processedAttachments += 1;
    } catch (error) {
      errors.push({
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sources = [...sourceMap.values()]
    .map(source => ({
      ...source,
      names: source.names.sort((left, right) => left.localeCompare(right, 'ru')),
      occurrences: source.occurrences.sort((left, right) =>
        left.attachmentId - right.attachmentId ||
        String(left.archivePath || '').localeCompare(String(right.archivePath || ''), 'en')),
    }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256, 'en'));
  const summary = {
    inventoryAttachments: inventory.attachments.length,
    availableAttachments: inventory.attachments.filter(item => !item.error).length,
    processedAttachments,
    archives,
    nestedArchives,
    sourceOccurrences,
    uniqueSources: sources.length,
    epas: sources.filter(item => item.extension === 'epas').length,
    wepas: sources.filter(item => item.extension === 'wepas').length,
    errors: errors.length,
    complete: errors.length === 0 &&
      processedAttachments === inventory.attachments.filter(item => !item.error).length,
  };
  const report = {
    schemaVersion: 1,
    generatedAt,
    inventory: portablePath(relative(outputRoot, resolve(inventoryPath))),
    summary,
    sources,
    errors,
  };
  await writeFile(resolve(outputRoot, 'extraction-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return '';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value, fallback, label) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const inventory = args[0];
  const attachments = args[1];
  const output = optionValue(args, '--output-dir');
  if (!inventory || !attachments || !output) {
    console.error('Usage: node tools/forum-extension-extract.mjs <inventory.json> <attachments-dir> --output-dir <directory> [--strict]');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await extractForumExtensionSources(inventory, attachments, output, {
      maxSourceBytes: positiveInteger(optionValue(args, '--max-source-bytes'), DEFAULT_MAX_SOURCE_BYTES, '--max-source-bytes'),
      maxArchiveBytes: positiveInteger(optionValue(args, '--max-archive-bytes'), DEFAULT_MAX_ARCHIVE_BYTES, '--max-archive-bytes'),
      maxEntries: positiveInteger(optionValue(args, '--max-entries'), DEFAULT_MAX_ENTRIES, '--max-entries'),
      maxDepth: positiveInteger(optionValue(args, '--max-depth'), DEFAULT_MAX_DEPTH, '--max-depth'),
    });
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    if (args.includes('--strict') && !report.summary.complete) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
