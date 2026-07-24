#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficeDocumentHandler } from './provider-sdk.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const templateRoot = resolve(process.argv[2] || join(projectRoot, '_test', 'templates'));
const entries = readdirSync(templateRoot);
const writerSource = entries.find(name => extname(name).toLowerCase() === '.docx');
const calcSource = entries.find(name => extname(name).toLowerCase() === '.ods');
if (!writerSource || !calcSource) {
  throw new Error('Office smoke requires at least one DOCX and one ODS template');
}

const root = mkdtempSync(join(tmpdir(), 'dataexpress-office-smoke-'));
const outputRoot = join(root, 'output');
mkdirSync(outputRoot);

function assertPdf(path) {
  const info = statSync(path);
  assert.ok(info.size > 100, `Converted PDF is unexpectedly small: ${info.size}`);
  assert.equal(readFileSync(path).subarray(0, 5).toString('ascii'), '%PDF-');
}

try {
  const common = {
    inputRoots: [templateRoot],
    outputRoots: [outputRoot],
    environment: {
      DX_OFFICE_BINARY: process.env.DX_OFFICE_BINARY || '',
      DX_OFFICE_BINARY_ARGS: process.env.DX_OFFICE_BINARY_ARGS || '[]',
    },
  };
  const writer = createOfficeDocumentHandler({
    ...common,
    documentType: 'writer',
  });
  const calc = createOfficeDocumentHandler({
    ...common,
    documentType: 'calc',
  });
  const writerOutput = join(outputRoot, 'writer-result');
  const calcOutput = join(outputRoot, 'calc-result');
  assert.equal(await writer({
    aInputFile: join(templateRoot, writerSource),
    aOutputFile: writerOutput,
    itemListExt: '.PDF - wdFormatPDF - PDF',
  }), true);
  assert.equal(await calc({
    aInputFile: join(templateRoot, calcSource),
    aOutputFile: calcOutput,
    itemListExt: '.PDF - xlTypePDF - PDF',
  }), true);
  assertPdf(`${writerOutput}.pdf`);
  assertPdf(`${calcOutput}.pdf`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    writerSource,
    calcSource,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
