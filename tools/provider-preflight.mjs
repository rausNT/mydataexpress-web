import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProvider, parseProviderConfig, validateProviderEndpoint } from './provider-config.mjs';
import { validateProviderManifest } from './provider-sdk.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;

function diagnostic(code, details = {}) {
  return { code, ...details };
}

function endpoint(baseUrl, path) {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(path, base);
}

async function fetchJson(fetchImpl, url, provider, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(provider.token ? { authorization: `Bearer ${provider.token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(provider.timeoutMs, timeoutMs)),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.code = response.status === 401 ? 'provider-auth-failed' : 'provider-http-error';
    error.status = response.status;
    throw error;
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    const error = new Error('Response is too large');
    error.code = 'provider-response-too-large';
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Response is not valid JSON');
    error.code = 'provider-json-invalid';
    throw error;
  }
}

export async function preflightProvider({
  manifest,
  configText,
  fetchImpl = globalThis.fetch,
  allowManual = false,
  timeoutMs = 10000,
}) {
  const errors = [];
  const warnings = [];
  let contract;
  try {
    const handlers = Object.create(null);
    for (const mapping of manifest?.mappings || []) {
      if (mapping?.status === 'provider' && typeof mapping.operation === 'string') {
        handlers[mapping.operation] = () => {};
      }
    }
    contract = validateProviderManifest(manifest, handlers);
  } catch (error) {
    return {
      ok: false,
      provider: manifest?.provider || '',
      errors: [diagnostic('manifest-invalid', { message: error.message })],
      warnings,
    };
  }

  if (!contract.complete) {
    const entry = diagnostic('manifest-manual-adaptation', {
      operations: contract.manualOperations.map(item => item.operation),
    });
    (allowManual ? warnings : errors).push(entry);
  }

  const configuration = parseProviderConfig(configText);
  errors.push(...configuration.errors.map(item => diagnostic('config-invalid', { detail: item.code })));
  warnings.push(...configuration.warnings.map(item => diagnostic('config-warning', { detail: item.code })));

  const provider = findProvider(configuration, contract.provider);
  const validation = validateProviderEndpoint(provider);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  const report = {
    ok: false,
    provider: contract.provider,
    url: validation.url?.href || provider?.url || '',
    manifestComplete: contract.complete,
    requiredOperations: contract.operations,
    missingOperations: [],
    extraOperations: [],
    errors,
    warnings,
  };
  if (errors.length) return report;
  if (typeof fetchImpl !== 'function') {
    errors.push(diagnostic('fetch-unavailable'));
    return report;
  }

  try {
    const [health, capabilities] = await Promise.all([
      fetchJson(fetchImpl, endpoint(validation.url, 'health'), provider, timeoutMs),
      fetchJson(fetchImpl, endpoint(validation.url, 'capabilities'), provider, timeoutMs),
    ]);
    report.health = {
      ok: health?.ok === true,
      status: health?.status || '',
      provider: health?.provider || '',
      complete: health?.complete === true,
    };
    report.capabilities = {
      ok: capabilities?.ok === true,
      schemaVersion: capabilities?.schemaVersion,
      provider: capabilities?.provider || '',
      complete: capabilities?.complete === true,
    };

    if (!report.health.ok || report.health.status !== 'ready') {
      errors.push(diagnostic('provider-not-ready'));
    }
    if (String(report.health.provider).toLowerCase() !== contract.provider.toLowerCase()) {
      errors.push(diagnostic('provider-health-name-mismatch'));
    }
    if (!report.capabilities.ok || report.capabilities.schemaVersion !== 1) {
      errors.push(diagnostic('provider-capabilities-invalid'));
    }
    if (String(report.capabilities.provider).toLowerCase() !== contract.provider.toLowerCase()) {
      errors.push(diagnostic('provider-capabilities-name-mismatch'));
    }

    const available = Array.isArray(capabilities?.operations) ? capabilities.operations : [];
    report.missingOperations = contract.operations.filter(operation => !available.includes(operation));
    report.extraOperations = available.filter(operation => !contract.operations.includes(operation));
    if (report.missingOperations.length) {
      errors.push(diagnostic('provider-operations-missing', { operations: report.missingOperations }));
    }
    if (report.extraOperations.length) {
      warnings.push(diagnostic('provider-operations-extra', { operations: report.extraOperations }));
    }
  } catch (error) {
    errors.push(diagnostic(error.code || (error.name === 'TimeoutError' ? 'provider-timeout' : 'provider-unreachable'), {
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    }));
  }
  report.ok = errors.length === 0;
  return report;
}

function usage() {
  return 'Usage: node tools/provider-preflight.mjs <manifest.json> --config <dxwebsrv.cfg> [--allow-manual] [--timeout <ms>]';
}

async function main(argv) {
  const manifestFile = argv[0];
  const configIndex = argv.indexOf('--config');
  if (!manifestFile || configIndex < 0 || !argv[configIndex + 1]) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const timeoutIndex = argv.indexOf('--timeout');
  const timeoutMs = timeoutIndex < 0 ? 10000 : Number(argv[timeoutIndex + 1]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    console.error('--timeout must be an integer between 1 and 300000');
    process.exitCode = 2;
    return;
  }
  try {
    const [manifestSource, configText] = await Promise.all([
      readFile(resolve(manifestFile), 'utf8'),
      readFile(resolve(argv[configIndex + 1]), 'utf8'),
    ]);
    const report = await preflightProvider({
      manifest: JSON.parse(manifestSource),
      configText,
      allowManual: argv.includes('--allow-manual'),
      timeoutMs,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, errors: [{ code: 'preflight-input-error', message: error.message }] }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
