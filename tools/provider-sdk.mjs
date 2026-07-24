import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT = 15_000;
const DEFAULT_HTTP_MAX_REQUEST = 2 * 1024 * 1024;
const DEFAULT_HTTP_MAX_RESPONSE = 2 * 1024 * 1024;
const DEFAULT_HTTP_MAX_REDIRECTS = 3;
const DEFAULT_DADATA_BASE_URL =
  'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/';
const DEFAULT_OFFICE_TIMEOUT = 120_000;
const DEFAULT_OFFICE_MAX_INPUT = 64 * 1024 * 1024;
const DEFAULT_OFFICE_MAX_OUTPUT = 128 * 1024 * 1024;

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
    maxRequestBytes: positiveInteger(
      options.maxRequestBytes ?? environment.DX_HTTP_MAX_REQUEST_BYTES,
      DEFAULT_HTTP_MAX_REQUEST,
      { maximum: 32 * 1024 * 1024 },
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

function requestBodyBytes(value, maximum) {
  if (value === null || value === undefined) return undefined;
  const body = String(value);
  if (Buffer.byteLength(body) > maximum) {
    throw new ProviderHttpError('HTTP provider request is too large');
  }
  return body;
}

function redirectedRequest(status, method, headers, body, crossOrigin) {
  const redirectedHeaders = new Headers(headers);
  if (crossOrigin) {
    redirectedHeaders.delete('authorization');
    redirectedHeaders.delete('cookie');
  }
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    redirectedHeaders.delete('content-length');
    redirectedHeaders.delete('content-type');
    return { method: 'GET', headers: redirectedHeaders, body: undefined };
  }
  return { method, headers: redirectedHeaders, body };
}

async function httpRequest(urlValue, requestOptions, policy) {
  if (typeof policy.fetch !== 'function') {
    throw new ProviderHttpError('HTTP fetch is unavailable in this Node.js runtime', 500);
  }
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let url = await validateHttpUrl(urlValue, policy);
  let method = requestOptions.method || 'GET';
  let headers = requestOptions.headers || new Headers();
  let body = requestBodyBytes(requestOptions.body, policy.maxRequestBytes);
  for (let redirect = 0; redirect <= policy.maxRedirects; redirect++) {
    let response;
    try {
      response = await policy.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
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
      const redirectUrl = await validateHttpUrl(
        new URL(response.headers.get('location'), url),
        policy,
      );
      ({ method, headers, body } = redirectedRequest(
        response.status,
        method,
        headers,
        body,
        redirectUrl.origin !== url.origin,
      ));
      url = redirectUrl;
      continue;
    }
    const bytes = await responseBytes(response, policy.maxResponseBytes);
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      contentType,
      text: decodeResponse(bytes, contentType),
    };
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
    const response = await httpRequest(value, {
      method: 'GET',
      headers: new Headers({
        accept: '*/*',
        'user-agent': 'DataExpress-Web-Provider/1.0',
      }),
    }, policy);
    return response.text;
  };
  handler.dataExpressImplemented = true;
  return handler;
}

const forbiddenRequestHeaders = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function commaTextItems(value) {
  const source = String(value || '');
  const items = [];
  let item = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        item += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      items.push(item.trim());
      item = '';
    } else {
      item += character;
    }
  }
  if (item.trim() || source.endsWith(',')) items.push(item.trim());
  return items.filter(Boolean);
}

function splitNameValue(value) {
  const separator = value.indexOf('=');
  return separator < 0
    ? { name: value.trim(), value: '' }
    : { name: value.slice(0, separator).trim(), value: value.slice(separator + 1) };
}

function requestPairs(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (Array.isArray(item)) {
        return { name: String(item[0] ?? ''), value: String(item[1] ?? '') };
      }
      if (item && typeof item === 'object') {
        return { name: String(item.name ?? ''), value: String(item.value ?? '') };
      }
      return splitNameValue(String(item ?? ''));
    });
  }
  return commaTextItems(value).map(splitNameValue);
}

function requestHeaders(pairs) {
  if (pairs.length > 100) {
    throw new ProviderHttpError('HTTP provider received too many request headers');
  }
  const headers = new Headers();
  for (const pair of pairs) {
    const name = pair.name.trim();
    const lower = name.toLowerCase();
    if (!name) continue;
    if (forbiddenRequestHeaders.has(lower) || lower.startsWith('proxy-') ||
        lower.startsWith('sec-')) {
      throw new ProviderHttpError(`HTTP provider does not allow the ${name} request header`);
    }
    if (/[\r\n]/.test(pair.value)) {
      throw new ProviderHttpError('HTTP provider request header contains a line break');
    }
    try {
      headers.append(name, pair.value);
    } catch {
      throw new ProviderHttpError('HTTP provider received an invalid request header');
    }
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'DataExpress');
  return headers;
}

function appendQuery(urlValue, pairs) {
  if (!pairs.length) return String(urlValue);
  let url;
  try {
    url = new URL(String(urlValue));
  } catch {
    throw new ProviderHttpError('HTTP provider received an invalid URL');
  }
  for (const pair of pairs) {
    if (pair.name) url.searchParams.append(pair.name, pair.value);
  }
  return url.href;
}

function legacyText(value) {
  return String(value).replace(/["\\/\b\t\n\f\r]/g, '');
}

function flattenLegacyJson(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flattenLegacyJson(item, prefix ? `${prefix}_${index}` : String(index)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, item]) =>
      flattenLegacyJson(item, prefix ? `${prefix}.${name}` : name));
  }
  if (typeof value === 'string') {
    const text = legacyText(value);
    return text ? [`${prefix}=${text}`] : [];
  }
  if (typeof value === 'boolean') return [`${prefix}=${value ? 'True' : 'False'}`];
  if (value === null) return [`${prefix}=null`];
  if (typeof value === 'number') return [`${prefix}=${String(value)}`];
  return [];
}

function legacyResponse(text, contentType) {
  if (!/(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType)) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return 'Ошибка парсинга JSON';
    return flattenLegacyJson(parsed).join(';');
  } catch {
    return text;
  }
}

function httpRequestContract(payload, recipe) {
  const contract = recipe.contract;
  const method = String(payload?.[recipe.methodParameter || 'Method'] || '').toUpperCase();
  const url = payload?.[recipe.urlParameter || 'URL'];
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return { unsupported: true };
  }

  if (contract === 'send-http-request-function-v1') {
    const headers = requestPairs(payload?.[recipe.headersParameter || 'Headers']);
    const apiKey = String(payload?.[recipe.apiKeyParameter || 'ApiKey'] || '');
    if (apiKey) headers.push({ name: 'Authorization', value: `Token ${apiKey}` });
    const params = String(payload?.[recipe.paramsParameter || 'Params'] || '');
    const query = ['GET'].includes(method) ? requestPairs(params) : [];
    return {
      method,
      url: appendQuery(url, query),
      headers: requestHeaders(headers),
      body: ['POST', 'PUT'].includes(method) ? params : undefined,
    };
  }

  if (contract === 'send-http-request-action-v1') {
    const headers = requestPairs(payload?.Headers);
    const params = requestPairs(payload?.Params);
    const body = ['POST', 'PUT'].includes(method)
      ? JSON.stringify(Object.fromEntries(params
        .filter(pair => pair.name)
        .map(pair => [pair.name, legacyText(pair.value)])))
      : undefined;
    return {
      method,
      url: method === 'GET' ? appendQuery(url, params) : String(url),
      headers: requestHeaders(headers),
      body,
    };
  }

  throw new ProviderHttpError('HTTP provider received an unsupported request contract', 500);
}

export function createHttpRequestHandler(recipe = {}, policyOptions = {}) {
  const policy = normalizeHttpPolicy(policyOptions);
  const handler = async payload => {
    const request = httpRequestContract(payload, recipe);
    if (request.unsupported) return 'Не поддерживаемый метод HTTP-запроса';
    if (request.url === null || request.url === undefined || String(request.url) === '') return '';
    const response = await httpRequest(request.url, request, policy);
    return legacyResponse(response.text, response.contentType);
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

const writerFormats = Object.freeze({
  wdformatdocument: { extension: 'doc', filter: 'MS Word 97' },
  wdformatdocument97: { extension: 'doc', filter: 'MS Word 97' },
  wdformatdocumentdefault: { extension: 'docx', filter: 'Office Open XML Text' },
  wdformatstrictopenxmldocument: { extension: 'docx', filter: 'Office Open XML Text' },
  wdformatxmldocument: { extension: 'docx', filter: 'Office Open XML Text' },
  wdformatxmldocumentmacroenabled: { extension: 'docm', filter: 'Office Open XML Text' },
  wdformattemplate: { extension: 'dot', filter: 'MS Word 97 Vorlage' },
  wdformattemplate97: { extension: 'dot', filter: 'MS Word 97 Vorlage' },
  wdformatxmltemplate: { extension: 'dotx', filter: 'Office Open XML Text Template' },
  wdformatxmltemplatemacroenabled: {
    extension: 'dotm',
    filter: 'Office Open XML Text Template',
  },
  wdformatopendocumenttext: { extension: 'odt', filter: 'writer8' },
  wdformatpdf: { extension: 'pdf', filter: 'writer_pdf_Export' },
  wdformatrtf: { extension: 'rtf', filter: 'Rich Text Format' },
  wdformathtml: { extension: 'html', filter: 'HTML (StarWriter)' },
  wdformatfilteredhtml: { extension: 'html', filter: 'HTML (StarWriter)' },
  wdformattext: { extension: 'txt', filter: 'Text' },
  wdformattextlinebreaks: { extension: 'txt', filter: 'Text' },
  wdformatdostext: { extension: 'txt', filter: 'Text' },
  wdformatdostextlinebreaks: { extension: 'txt', filter: 'Text' },
  wdformatencodedtext: { extension: 'txt', filter: 'Text (encoded):UTF8' },
  wdformatunicodetext: { extension: 'txt', filter: 'Text (encoded):UTF8' },
});

const calcFormats = Object.freeze({
  xltypepdf: { extension: 'pdf', filter: 'calc_pdf_Export' },
  xlworkbookdefault: { extension: 'xlsx', filter: 'Calc MS Excel 2007 XML' },
  xlopenxmlworkbook: { extension: 'xlsx', filter: 'Calc MS Excel 2007 XML' },
  xlopenxmlstrictworkbook: { extension: 'xlsx', filter: 'Calc MS Excel 2007 XML' },
  xlopenxmlworkbookmacroenabled: {
    extension: 'xlsm',
    filter: 'Calc MS Excel 2007 VBA XML',
  },
  xlworkbooknormal: { extension: 'xls', filter: 'MS Excel 97' },
  xlexcel8: { extension: 'xls', filter: 'MS Excel 97' },
  xlexcel9795: { extension: 'xls', filter: 'MS Excel 97' },
  xlopendocumentspreadsheet: { extension: 'ods', filter: 'calc8' },
  xlcsv: { extension: 'csv', filter: 'Text - txt - csv (StarCalc)' },
  xlcsvutf8: { extension: 'csv', filter: 'Text - txt - csv (StarCalc)' },
  xlcsvwindows: { extension: 'csv', filter: 'Text - txt - csv (StarCalc)' },
  xlcsvmsdos: { extension: 'csv', filter: 'Text - txt - csv (StarCalc)' },
  xlcsvmac: { extension: 'csv', filter: 'Text - txt - csv (StarCalc)' },
  xlunicodetext: { extension: 'txt', filter: 'Text - txt - csv (StarCalc)' },
  xlcurrentplatformtext: { extension: 'txt', filter: 'Text - txt - csv (StarCalc)' },
  xltextwindows: { extension: 'txt', filter: 'Text - txt - csv (StarCalc)' },
  xltextmsdos: { extension: 'txt', filter: 'Text - txt - csv (StarCalc)' },
  xltextmac: { extension: 'txt', filter: 'Text - txt - csv (StarCalc)' },
  xlhtml: { extension: 'html', filter: 'HTML (StarCalc)' },
  xlxmlspreadsheet: { extension: 'xml', filter: 'MS Excel 2003 XML' },
  xlopenxmltemplate: { extension: 'xltx', filter: 'Calc MS Excel 2007 XML Template' },
  xlopenxmltemplatemacroenabled: {
    extension: 'xltm',
    filter: 'Calc MS Excel 2007 XML Template',
  },
});

const writerExtensions = new Set([
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'rtf', 'txt', 'html', 'htm',
]);
const calcExtensions = new Set([
  'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'ods', 'csv', 'tsv', 'txt',
  'html', 'htm', 'xml',
]);

function officeRoots(value, environmentValue, label, cwd) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? environmentValue ?? '').split(delimiter);
  const roots = [...new Set(values
    .map(item => String(item).trim())
    .filter(Boolean)
    .map(item => resolve(cwd, item)))];
  if (!roots.length) {
    throw new ProviderHttpError(`${label} is required for the Office provider`);
  }
  return roots;
}

function validateOfficeRoots(roots, label) {
  for (const root of roots) {
    try {
      if (!statSync(realpathSync(root)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new ProviderHttpError(`${label} does not exist or is not a directory: ${root}`, 503);
    }
  }
}

function officeInteger(value, fallback, label, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ProviderHttpError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function officeBinaryArguments(value) {
  if (value === undefined || value === null || value === '') return [];
  let items = value;
  if (!Array.isArray(items)) {
    try {
      items = JSON.parse(String(items));
    } catch {
      throw new ProviderHttpError('DX_OFFICE_BINARY_ARGS must be a JSON array');
    }
  }
  if (!Array.isArray(items) ||
      items.some(item => typeof item !== 'string' || item.includes('\0'))) {
    throw new ProviderHttpError('DX_OFFICE_BINARY_ARGS must be a JSON array of strings');
  }
  return [...items];
}

function pathInside(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

async function canonicalRoots(roots, label) {
  const result = [];
  for (const root of roots) {
    try {
      const canonical = await realpath(root);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error('not a directory');
      result.push(canonical);
    } catch {
      throw new ProviderHttpError(`${label} does not exist or is not a directory: ${root}`, 503);
    }
  }
  return result;
}

function payloadPath(payload, parameter, label) {
  const value = String(payload?.[parameter] ?? '').trim();
  if (!value) throw new ProviderHttpError(`${label} is required`);
  if (value.length > 4096 || value.includes('\0')) {
    throw new ProviderHttpError(`${label} is invalid`);
  }
  return value;
}

async function safeInputPath(value, roots, cwd) {
  const requested = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new ProviderHttpError('Office input file does not exist');
  }
  const allowed = await canonicalRoots(roots, 'DX_OFFICE_INPUT_ROOTS');
  if (!allowed.some(root => pathInside(root, canonical))) {
    throw new ProviderHttpError('Office input file is outside the allowed roots', 403);
  }
  const info = await stat(canonical);
  if (!info.isFile()) throw new ProviderHttpError('Office input path is not a file');
  return { path: canonical, size: info.size };
}

async function existingAncestor(path) {
  let current = path;
  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new ProviderHttpError('Office output path has no existing parent');
      current = parent;
    }
  }
}

async function safeOutputPath(value, roots, cwd) {
  const requested = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const allowed = await canonicalRoots(roots, 'DX_OFFICE_OUTPUT_ROOTS');
  const lexicalRoot = roots.find(root => pathInside(root, requested));
  if (!lexicalRoot) {
    throw new ProviderHttpError('Office output file is outside the allowed roots', 403);
  }
  const rootIndex = roots.indexOf(lexicalRoot);
  const ancestor = await realpath(await existingAncestor(dirname(requested)));
  if (!pathInside(allowed[rootIndex], ancestor)) {
    throw new ProviderHttpError('Office output path escapes the allowed root', 403);
  }
  await mkdir(dirname(requested), { recursive: true });
  const parent = await realpath(dirname(requested));
  if (!pathInside(allowed[rootIndex], parent)) {
    throw new ProviderHttpError('Office output path escapes the allowed root', 403);
  }
  try {
    const existing = await realpath(requested);
    if (!pathInside(allowed[rootIndex], existing)) {
      throw new ProviderHttpError('Office output file escapes the allowed root', 403);
    }
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
  }
  return requested;
}

function officeFormat(documentType, value) {
  const parts = String(value ?? '').split(/\s+-\s+/).map(item => item.trim());
  const formatName = String(parts[1] || '').toLowerCase();
  const selectedExtension = String(parts[0] || '').replace(/^\./, '').toLowerCase();
  const formats = documentType === 'writer' ? writerFormats : calcFormats;
  const extensions = documentType === 'writer' ? writerExtensions : calcExtensions;
  let format = formats[formatName];
  if (!format && selectedExtension && extensions.has(selectedExtension)) {
    format = Object.values(formats).find(item => item.extension === selectedExtension);
  }
  if (!format) {
    throw new ProviderHttpError(
      `LibreOffice does not support the selected ${documentType} conversion format`,
    );
  }
  return format;
}

async function outputName(value, input, extension) {
  let output = value;
  let isDirectory = /[\\/]$/.test(output);
  if (!isDirectory) {
    try {
      isDirectory = (await stat(output)).isDirectory();
    } catch {
      // A new file is expected.
    }
  }
  if (isDirectory) output = join(output, parse(input).name);
  if (!extname(output)) output += `.${extension}`;
  return output;
}

async function executeOfficeProcess({ binary, args, timeoutMs }) {
  await new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    let stderr = '';
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 32_768) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      if (error?.code === 'ENOENT') {
        rejectPromise(new ProviderHttpError(
          'LibreOffice executable was not found; set DX_OFFICE_BINARY',
          503,
        ));
      } else {
        rejectPromise(new ProviderHttpError('LibreOffice could not be started', 502));
      }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new ProviderHttpError('LibreOffice conversion timed out', 504));
      } else if (code !== 0) {
        const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
        rejectPromise(new ProviderHttpError(
          `LibreOffice conversion failed${detail ? `: ${detail}` : ''}`,
          502,
        ));
      } else {
        resolvePromise();
      }
    });
  });
}

async function convertedOfficeFile(workDirectory, input, extension) {
  const expectedName = `${parse(input).name}.${extension}`;
  const entries = await readdir(workDirectory);
  const entry = entries.find(name => name.toLowerCase() === expectedName.toLowerCase());
  if (!entry) {
    throw new ProviderHttpError('LibreOffice did not create the converted document', 502);
  }
  return join(workDirectory, entry);
}

function officePolicy(options = {}) {
  const environment = options.environment || process.env;
  const cwd = resolve(options.cwd || process.cwd());
  const inputRoots = officeRoots(
    options.inputRoots,
    environment.DX_OFFICE_INPUT_ROOTS,
    'DX_OFFICE_INPUT_ROOTS',
    cwd,
  );
  const outputRoots = officeRoots(
    options.outputRoots,
    environment.DX_OFFICE_OUTPUT_ROOTS,
    'DX_OFFICE_OUTPUT_ROOTS',
    cwd,
  );
  validateOfficeRoots(inputRoots, 'DX_OFFICE_INPUT_ROOTS');
  validateOfficeRoots(outputRoots, 'DX_OFFICE_OUTPUT_ROOTS');
  const binary = String(options.binary || environment.DX_OFFICE_BINARY || 'soffice').trim();
  const binaryArguments = officeBinaryArguments(
    options.binaryArguments ?? environment.DX_OFFICE_BINARY_ARGS,
  );
  if (options.validateBinary ?? !options.execute) {
    const check = spawnSync(binary, [...binaryArguments, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (check.error?.code === 'ENOENT') {
      throw new ProviderHttpError(
        'LibreOffice executable was not found; set DX_OFFICE_BINARY',
        503,
      );
    }
    if (check.error || check.status !== 0) {
      throw new ProviderHttpError(
        'LibreOffice executable did not pass the startup check',
        503,
      );
    }
  }
  return {
    inputRoots,
    outputRoots,
    binary,
    binaryArguments,
    timeoutMs: officeInteger(
      options.timeoutMs ?? environment.DX_OFFICE_TIMEOUT_MS,
      DEFAULT_OFFICE_TIMEOUT,
      'DX_OFFICE_TIMEOUT_MS',
      1_000,
      900_000,
    ),
    maxInputBytes: officeInteger(
      options.maxInputBytes ?? environment.DX_OFFICE_MAX_INPUT_BYTES,
      DEFAULT_OFFICE_MAX_INPUT,
      'DX_OFFICE_MAX_INPUT_BYTES',
      1,
      1024 * 1024 * 1024,
    ),
    maxOutputBytes: officeInteger(
      options.maxOutputBytes ?? environment.DX_OFFICE_MAX_OUTPUT_BYTES,
      DEFAULT_OFFICE_MAX_OUTPUT,
      'DX_OFFICE_MAX_OUTPUT_BYTES',
      1,
      2 * 1024 * 1024 * 1024,
    ),
    maxConcurrency: officeInteger(
      options.maxConcurrency ?? environment.DX_OFFICE_MAX_CONCURRENCY,
      2,
      'DX_OFFICE_MAX_CONCURRENCY',
      1,
      16,
    ),
    cwd,
    execute: options.execute || executeOfficeProcess,
  };
}

function officeLimiter(maximum) {
  let active = 0;
  const waiting = [];
  return async task => {
    if (active >= maximum) {
      await new Promise(resolvePromise => waiting.push(resolvePromise));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createOfficeDocumentHandler({
  documentType,
  inputParameter = 'aInputFile',
  outputParameter = 'aOutputFile',
  formatParameter = 'itemListExt',
  ...policyOptions
} = {}) {
  if (!['writer', 'calc'].includes(documentType)) {
    throw new ProviderHttpError('Office provider has an unsupported document type');
  }
  for (const [label, value] of Object.entries({
    inputParameter,
    outputParameter,
    formatParameter,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ProviderHttpError(`Office provider ${label} is invalid`);
    }
  }
  const policy = officePolicy(policyOptions);
  const withSlot = officeLimiter(policy.maxConcurrency);
  const handler = payload => withSlot(async () => {
    const rawInput = payloadPath(payload, inputParameter, 'Office input file');
    const rawOutput = payloadPath(payload, outputParameter, 'Office output file');
    const format = officeFormat(documentType, payload?.[formatParameter]);
    const input = await safeInputPath(rawInput, policy.inputRoots, policy.cwd);
    if (input.size > policy.maxInputBytes) {
      throw new ProviderHttpError('Office input file is too large', 413);
    }
    const requestedOutput = await outputName(rawOutput, input.path, format.extension);
    const output = await safeOutputPath(
      requestedOutput,
      policy.outputRoots,
      policy.cwd,
    );
    const workDirectory = await mkdtemp(join(tmpdir(), 'dataexpress-office-'));
    try {
      const profile = join(workDirectory, 'profile');
      const convertedDirectory = join(workDirectory, 'converted');
      await mkdir(profile);
      await mkdir(convertedDirectory);
      const argumentsList = [
        ...policy.binaryArguments,
        '--headless',
        '--invisible',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--convert-to',
        `${format.extension}:${format.filter}`,
        '--outdir',
        convertedDirectory,
        input.path,
      ];
      await policy.execute({
        binary: policy.binary,
        args: argumentsList,
        timeoutMs: policy.timeoutMs,
        workDirectory,
        convertedDirectory,
        inputPath: input.path,
        outputPath: output,
        format,
      });
      const converted = await convertedOfficeFile(
        convertedDirectory,
        input.path,
        format.extension,
      );
      const resultInfo = await stat(converted);
      if (!resultInfo.isFile()) {
        throw new ProviderHttpError('LibreOffice conversion result is not a file', 502);
      }
      if (resultInfo.size > policy.maxOutputBytes) {
        throw new ProviderHttpError('Office output file is too large', 502);
      }
      await copyFile(converted, output);
      return true;
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });
  handler.dataExpressImplemented = true;
  return handler;
}

function validProviderRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return false;
  if (recipe.kind === 'http-get') {
    return recipe.urlParameter === undefined ||
      (typeof recipe.urlParameter === 'string' && Boolean(recipe.urlParameter.trim()));
  }
  if (recipe.kind === 'http-request') {
    if (!['send-http-request-function-v1', 'send-http-request-action-v1']
      .includes(recipe.contract)) return false;
    const names = [
      'methodParameter',
      'urlParameter',
      'headersParameter',
      'apiKeyParameter',
      'paramsParameter',
    ];
    return names.every(name => recipe[name] === undefined ||
      (typeof recipe[name] === 'string' && Boolean(recipe[name].trim())));
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
  if (recipe.kind === 'office-document-convert') {
    return ['writer', 'calc'].includes(recipe.documentType) &&
      ['inputParameter', 'outputParameter', 'formatParameter']
        .every(name => typeof recipe[name] === 'string' && Boolean(recipe[name].trim()));
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
