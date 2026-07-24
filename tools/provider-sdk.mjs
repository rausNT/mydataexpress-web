import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT = 15_000;
const DEFAULT_HTTP_MAX_RESPONSE = 2 * 1024 * 1024;
const DEFAULT_HTTP_MAX_REDIRECTS = 3;
const DEFAULT_DADATA_BASE_URL =
  'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/';

const nonPublicIPv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  nonPublicIPv4.addSubnet(address, prefix, 'ipv4');
}
const nonPublicIPv6 = new BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) {
  nonPublicIPv6.addSubnet(address, prefix, 'ipv6');
}

export class ProviderManifestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderManifestError';
    this.details = details;
  }
}

export class ProviderHttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ProviderHttpError(`HTTP policy value must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function hostPatterns(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  const patterns = items
    .map(item => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map(pattern => {
      if (pattern.startsWith('[') && pattern.endsWith(']')) return pattern.slice(1, -1);
      return pattern;
    });
  if (!patterns.length) {
    throw new ProviderHttpError(
      'HTTP provider requires DX_HTTP_ALLOW_HOSTS or an explicit allowHosts policy',
    );
  }
  for (const pattern of patterns) {
    if (pattern === '*') continue;
    const hostname = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (!hostname || (!isIP(hostname) && /[/\\:@]/.test(hostname))) {
      throw new ProviderHttpError('HTTP provider contains an invalid host allow-list entry');
    }
  }
  return patterns;
}

function normalizeHttpPolicy(options = {}) {
  const environment = options.environment || process.env;
  return {
    allowHosts: hostPatterns(options.allowHosts ?? environment.DX_HTTP_ALLOW_HOSTS),
    allowPrivate: options.allowPrivate ?? enabled(environment.DX_HTTP_ALLOW_PRIVATE),
    allowInsecure: options.allowInsecure ?? enabled(environment.DX_HTTP_ALLOW_INSECURE),
    timeoutMs: positiveInteger(
      options.timeoutMs ?? environment.DX_HTTP_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUT,
      { maximum: 120_000 },
    ),
    maxResponseBytes: positiveInteger(
      options.maxResponseBytes ?? environment.DX_HTTP_MAX_RESPONSE_BYTES,
      DEFAULT_HTTP_MAX_RESPONSE,
      { maximum: 32 * 1024 * 1024 },
    ),
    maxRedirects: positiveInteger(
      options.maxRedirects ?? environment.DX_HTTP_MAX_REDIRECTS,
      DEFAULT_HTTP_MAX_REDIRECTS,
      { minimum: 0, maximum: 10 },
    ),
    fetch: options.fetch || globalThis.fetch,
    lookup: options.lookup || lookup,
  };
}

function allowedHostname(hostname, patterns) {
  const value = hostname.toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return patterns.some(pattern => {
    if (pattern === '*') return true;
    if (!pattern.startsWith('*.')) return value === pattern;
    const suffix = pattern.slice(2);
    return value === suffix || value.endsWith(`.${suffix}`);
  });
}

function addressKind(address) {
  const normalized = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address;
  return { address: normalized, family: isIP(normalized) };
}

async function validateHttpUrl(value, policy) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ProviderHttpError('HTTP provider received an invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ProviderHttpError('HTTP provider only supports http and https URLs');
  }
  if (url.protocol === 'http:' && !policy.allowInsecure) {
    throw new ProviderHttpError('Plain HTTP is disabled by the provider policy');
  }
  if (url.username || url.password) {
    throw new ProviderHttpError('Credentials in provider URLs are not allowed');
  }
  if (!allowedHostname(url.hostname, policy.allowHosts)) {
    throw new ProviderHttpError('HTTP target host is not in the allow-list');
  }

  if (!policy.allowPrivate) {
    const literal = addressKind(url.hostname);
    let addresses;
    try {
      addresses = literal.family
        ? [literal]
        : (await policy.lookup(url.hostname, { all: true, verbatim: true }))
          .map(item => ({ address: item.address, family: item.family }));
    } catch {
      throw new ProviderHttpError('HTTP target host did not resolve', 502);
    }
    if (!addresses.length) throw new ProviderHttpError('HTTP target host did not resolve', 502);
    if (addresses.some(item => item.family === 6
      ? nonPublicIPv6.check(item.address, 'ipv6')
      : nonPublicIPv4.check(item.address, 'ipv4'))) {
      throw new ProviderHttpError('HTTP target resolves to a non-public address');
    }
  }
  return url;
}

async function responseBytes(response, maximum) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maximum) {
    throw new ProviderHttpError('HTTP provider response is too large', 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) {
      try {
        await response.body.cancel?.();
      } catch {
        // The async iterator may already hold the stream lock.
      }
      throw new ProviderHttpError('HTTP provider response is too large', 502);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function decodeResponse(bytes, contentType) {
  const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function httpGet(urlValue, policy) {
  if (typeof policy.fetch !== 'function') {
    throw new ProviderHttpError('HTTP fetch is unavailable in this Node.js runtime', 500);
  }
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let url = await validateHttpUrl(urlValue, policy);
  for (let redirect = 0; redirect <= policy.maxRedirects; redirect++) {
    let response;
    try {
      response = await policy.fetch(url, {
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'DataExpress-Web-Provider/1.0' },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted || error?.name === 'TimeoutError') {
        throw new ProviderHttpError('HTTP provider request timed out', 504);
      }
      throw new ProviderHttpError('HTTP provider request failed', 502);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      if (redirect >= policy.maxRedirects) {
        throw new ProviderHttpError('HTTP provider redirect limit exceeded', 502);
      }
      try {
        await response.body?.cancel?.();
      } catch {
        // Redirect validation still runs even if the body cannot be cancelled.
      }
      url = await validateHttpUrl(new URL(response.headers.get('location'), url), policy);
      continue;
    }
    const bytes = await responseBytes(response, policy.maxResponseBytes);
    return decodeResponse(bytes, response.headers.get('content-type'));
  }
  throw new ProviderHttpError('HTTP provider redirect limit exceeded', 502);
}

export function createHttpGetHandler({
  urlParameter = 'URL',
  ...policyOptions
} = {}) {
  const policy = normalizeHttpPolicy(policyOptions);
  const handler = async payload => {
    const value = payload?.[urlParameter] ?? payload?.URL ?? payload?.url;
    if (value === null || value === undefined || String(value) === '') return '';
    return httpGet(value, policy);
  };
  handler.dataExpressImplemented = true;
  return handler;
}

function dadataPolicy(options = {}) {
  const environment = options.environment || process.env;
  let baseUrl;
  try {
    baseUrl = new URL(
      options.baseUrl || environment.DX_DADATA_BASE_URL || DEFAULT_DADATA_BASE_URL,
    );
  } catch {
    throw new ProviderHttpError('DaData provider base URL is invalid');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new ProviderHttpError('DaData provider base URL must not contain credentials, query or fragment');
  }
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  return {
    ...normalizeHttpPolicy({
      allowHosts: [baseUrl.hostname],
      allowPrivate: options.allowPrivate ?? enabled(environment.DX_DADATA_ALLOW_PRIVATE),
      allowInsecure: options.allowInsecure ?? enabled(environment.DX_DADATA_ALLOW_INSECURE),
      timeoutMs: options.timeoutMs ?? environment.DX_DADATA_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? environment.DX_DADATA_MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      fetch: options.fetch,
      lookup: options.lookup,
      environment: {},
    }),
    baseUrl,
    apiKey: options.apiKey ?? environment.DX_DADATA_API_KEY ?? '',
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlElement(name, value) {
  if (Array.isArray(value)) return value.map(item => xmlElement(name, item)).join('');
  if (value === null || value === undefined) return `<${name}/>`;
  if (typeof value === 'object') {
    return `<${name}>${Object.entries(value)
      .map(([childName, childValue]) => xmlElement(childName, childValue))
      .join('')}</${name}>`;
  }
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

function legacyDadataXml(response) {
  if (!Array.isArray(response?.suggestions) || response.suggestions.length === 0) {
    return '<SuggestResponse/>';
  }
  return `<SuggestResponse>${response.suggestions
    .map(suggestion => xmlElement('suggestions', suggestion))
    .join('')}</SuggestResponse>`;
}

function flattenObject(value, prefix = '', result = new Map()) {
  if (value === null || value === undefined || typeof value !== 'object') {
    if (prefix) result.set(prefix, value);
    return result;
  }
  if (Array.isArray(value)) {
    if (prefix) result.set(prefix, JSON.stringify(value));
    return result;
  }
  for (const [name, child] of Object.entries(value)) {
    flattenObject(child, prefix ? `${prefix}.${name}` : name, result);
  }
  return result;
}

function dadataDate(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.valueOf())) return value;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function legacyDadataValue(name, value) {
  if (value === null || value === undefined) return null;
  if ([
    'ogrn_date',
    'data.state.actuality_date',
    'data.state.registration_date',
    'data.state.liquidation_date',
  ].includes(name)) return dadataDate(value);
  const translations = {
    'data.state.status': {
      ACTIVE: 'Действующая',
      LIQUIDATING: 'Ликвидируется',
      LIQUIDATED: 'Ликвидирована',
    },
    'data.type': {
      LEGAL: 'Юридическое лицо',
      INDIVIDUAL: 'Индивидуальный предприниматель',
    },
    'data.branch_type': {
      MAIN: 'Головная организация',
      BRANCH: 'Филиал',
    },
    'data.opf.type': {
      BANK: 'Банк',
      BANK_BRANCH: 'Филиал банка',
      NKO: 'Небанковская кредитная организация (НКО)',
      NKO_BRANCH: 'Филиал НКО',
      RKC: 'Расчетно-кассовый центр',
      OTHER: 'Другой',
    },
  };
  return translations[name]?.[String(value)] ?? value;
}

async function dadataSuggest(payload, recipe, policy) {
  const queryValue = payload?.[recipe.queryParameter];
  if (queryValue === null || queryValue === undefined) {
    return {
      value: '',
      variables: recipe.stateVariables.map(name => ({ name, value: null })),
    };
  }
  const query = String(queryValue);
  if (query.length > 300) {
    throw new ProviderHttpError('DaData query must not exceed 300 characters');
  }
  const apiKey = String(policy.apiKey || payload?.[recipe.apiKeyParameter] || '').trim();
  if (!apiKey) throw new ProviderHttpError('DaData API key is required');
  const url = new URL(recipe.suggestType, policy.baseUrl);
  await validateHttpUrl(url, policy);
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let response;
  try {
    response = await policy.fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Token ${apiKey}`,
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'DataExpress-Web-Provider/1.0',
      },
      body: JSON.stringify({ query, count: 1 }),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError') {
      throw new ProviderHttpError('DaData request timed out', 504);
    }
    throw new ProviderHttpError('DaData request failed', 502);
  }
  const bytes = await responseBytes(response, policy.maxResponseBytes);
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      throw new ProviderHttpError('DaData authentication failed', response.status);
    }
    const status = response.status >= 500 ? 502 : 400;
    throw new ProviderHttpError(`DaData request was rejected (HTTP ${response.status})`, status);
  }
  let data;
  try {
    data = JSON.parse(decodeResponse(bytes, response.headers.get('content-type')));
  } catch {
    throw new ProviderHttpError('DaData returned invalid JSON', 502);
  }
  if (!Array.isArray(data?.suggestions)) {
    throw new ProviderHttpError('DaData response does not contain suggestions', 502);
  }
  const xml = legacyDadataXml(data);
  const flattened = flattenObject(data.suggestions[0] || {});
  const names = new Set([...recipe.stateVariables, ...flattened.keys()]);
  const variables = [...names].map(name => ({
    name,
    value: legacyDadataValue(name, flattened.has(name) ? flattened.get(name) : null),
  }));
  if (recipe.resultVariable) variables.push({ name: recipe.resultVariable, value: xml });
  return { value: xml, variables };
}

export function createDadataSuggestHandler({
  suggestType,
  apiKeyParameter = 'ApiKey',
  queryParameter = 'SearhStr',
  stateVariables = [],
  resultVariable = '',
  ...policyOptions
} = {}) {
  if (!['party', 'bank', 'address'].includes(suggestType)) {
    throw new ProviderHttpError('DaData provider has an unsupported suggestion type');
  }
  if (!Array.isArray(stateVariables) ||
      stateVariables.some(name => typeof name !== 'string' || !name.trim())) {
    throw new ProviderHttpError('DaData provider state variables are invalid');
  }
  const policy = dadataPolicy(policyOptions);
  const recipe = {
    suggestType,
    apiKeyParameter,
    queryParameter,
    stateVariables: [...new Set(stateVariables)],
    resultVariable,
  };
  const handler = payload => dadataSuggest(payload, recipe, policy);
  handler.dataExpressImplemented = true;
  return handler;
}

function validProviderRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return false;
  if (recipe.kind === 'http-get') {
    return recipe.urlParameter === undefined ||
      (typeof recipe.urlParameter === 'string' && Boolean(recipe.urlParameter.trim()));
  }
  if (recipe.kind === 'dadata-suggest') {
    return ['party', 'bank', 'address'].includes(recipe.suggestType) &&
      typeof recipe.apiKeyParameter === 'string' && Boolean(recipe.apiKeyParameter.trim()) &&
      typeof recipe.queryParameter === 'string' && Boolean(recipe.queryParameter.trim()) &&
      Array.isArray(recipe.stateVariables) &&
      recipe.stateVariables.every(name => typeof name === 'string' && Boolean(name.trim())) &&
      (recipe.resultVariable === undefined ||
        (typeof recipe.resultVariable === 'string' && Boolean(recipe.resultVariable.trim())));
  }
  return false;
}

export function validateProviderManifest(manifest, handlers) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ProviderManifestError('Provider manifest must be an object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new ProviderManifestError(`Unsupported provider manifest schema: ${manifest.schemaVersion ?? 'missing'}`);
  }
  if (typeof manifest.provider !== 'string' || !manifest.provider.trim()) {
    throw new ProviderManifestError('Provider manifest must contain a provider name');
  }
  if (!Array.isArray(manifest.mappings)) {
    throw new ProviderManifestError('Provider manifest mappings must be an array');
  }
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new TypeError('handlers must be an object');
  }

  const invalidStatuses = manifest.mappings
    .filter(mapping => !['provider', 'web-script', 'manual'].includes(mapping?.status))
    .map(mapping => mapping?.status ?? 'missing');
  if (invalidStatuses.length) {
    throw new ProviderManifestError(`Invalid provider mapping statuses: ${[...new Set(invalidStatuses)].join(', ')}`);
  }
  const recipeMappings = manifest.mappings.filter(mapping => mapping?.providerRecipe !== undefined);
  const invalidRecipeStatuses = recipeMappings.filter(mapping => mapping?.status !== 'provider');
  if (invalidRecipeStatuses.length) {
    throw new ProviderManifestError('Provider recipes are only allowed on provider mappings');
  }
  const invalidRecipes = recipeMappings.filter(mapping => !validProviderRecipe(mapping.providerRecipe));
  if (invalidRecipes.length) {
    throw new ProviderManifestError('Unsupported or invalid provider recipe');
  }
  const providerMappings = manifest.mappings.filter(mapping => mapping?.status === 'provider');
  const manualMappings = manifest.mappings.filter(mapping => mapping?.status === 'manual');
  const operations = providerMappings.map(mapping => mapping?.operation);
  const invalidOperations = operations.filter(operation => typeof operation !== 'string' || !operation.trim());
  if (invalidOperations.length) {
    throw new ProviderManifestError('Provider mappings must contain non-empty operation names');
  }

  const duplicates = [...new Set(operations.filter((operation, index) => operations.indexOf(operation) !== index))];
  if (duplicates.length) {
    throw new ProviderManifestError(`Duplicate provider operations: ${duplicates.join(', ')}`, { duplicates });
  }

  const missingHandlers = operations.filter(operation =>
    !Object.hasOwn(handlers, operation) || typeof handlers[operation] !== 'function'
  );
  if (missingHandlers.length) {
    throw new ProviderManifestError(`Missing provider handlers: ${missingHandlers.join(', ')}`, { missingHandlers });
  }

  const unimplementedHandlers = operations.filter(operation =>
    handlers[operation]?.dataExpressImplemented === false
  );
  if (unimplementedHandlers.length) {
    throw new ProviderManifestError(
      `Unimplemented provider handlers: ${unimplementedHandlers.join(', ')}`,
      { unimplementedHandlers },
    );
  }

  const extraHandlers = Object.keys(handlers).filter(operation => !operations.includes(operation));
  return {
    schemaVersion: 1,
    provider: manifest.provider,
    operations,
    manualOperations: manualMappings.map(mapping => ({
      operation: mapping?.operation || '',
      reason: mapping?.reason || 'manual-adaptation-required',
    })),
    extraHandlers,
    complete: manualMappings.length === 0,
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJson(request, maxBody) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBody) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createProviderServer({
  handlers,
  token = '',
  manifest = null,
  providerName = '',
  maxBody = DEFAULT_MAX_BODY,
  logger = console,
}) {
  if (!handlers || typeof handlers !== 'object') throw new TypeError('handlers must be an object');
  const capabilities = manifest
    ? validateProviderManifest(manifest, handlers)
    : {
        schemaVersion: 1,
        provider: providerName,
        operations: Object.keys(handlers),
        manualOperations: [],
        extraHandlers: [],
        complete: true,
      };

  return createServer(async (request, response) => {
    try {
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, { ok: false, error: 'Unauthorized' });
      }

      const path = new URL(request.url || '/', 'http://provider.local').pathname;
      if (request.method === 'GET' && path === '/health') {
        return json(response, 200, {
          ok: true,
          status: 'ready',
          provider: capabilities.provider,
          complete: capabilities.complete,
        });
      }
      if (request.method === 'GET' && path === '/capabilities') {
        return json(response, 200, { ok: true, ...capabilities });
      }
      if (request.method !== 'POST') {
        return json(response, 405, { ok: false, error: 'Method not allowed' });
      }

      const requestedProvider = String(request.headers['x-dataexpress-provider'] || '');
      if (capabilities.provider && requestedProvider &&
          requestedProvider.toLowerCase() !== capabilities.provider.toLowerCase()) {
        return json(response, 409, {
          ok: false,
          error: `Provider mismatch: expected ${capabilities.provider}, got ${requestedProvider}`,
        });
      }

      const message = await readJson(request, maxBody);
      if (!message || typeof message.operation !== 'string') {
        return json(response, 400, { ok: false, error: 'operation must be a string' });
      }
      const handler = Object.hasOwn(handlers, message.operation)
        ? handlers[message.operation]
        : undefined;
      if (typeof handler !== 'function') {
        return json(response, 404, { ok: false, error: `Unknown operation: ${message.operation}` });
      }

      const result = await handler(message.payload, {
        provider: request.headers['x-dataexpress-provider'] || '',
        remoteAddress: request.socket.remoteAddress,
      });
      return json(response, 200, { ok: true, result: result ?? null });
    } catch (error) {
      logger?.error?.(error);
      return json(response, error.status || 500, { ok: false, error: error.message || 'Provider error' });
    }
  });
}

export async function listenProvider(server, { host = '127.0.0.1', port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return `http://${host}:${address.port}`;
}

export async function closeProvider(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
