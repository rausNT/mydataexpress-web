import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeProvider,
  createDadataSuggestHandler,
  createHttpGetHandler,
  createHttpRequestHandler,
  createOfficeDocumentHandler,
  createProviderServer,
  listenProvider,
  ProviderManifestError,
  validateProviderManifest,
} from './provider-sdk.mjs';

async function call(url, body, token = 'secret') {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-dataexpress-provider': 'TestProvider',
    },
    body: JSON.stringify(body),
  });
}

test('dispatches a provider operation and returns the stable envelope', async () => {
  const server = createProviderServer({
    token: 'secret',
    logger: null,
    handlers: { sum: payload => payload.a + payload.b },
  });
  const url = await listenProvider(server);
  try {
    const response = await call(url, { operation: 'sum', payload: { a: 2, b: 3 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: 5 });
  } finally {
    await closeProvider(server);
  }
});

test('HTTP_GET recipe enforces host, redirect, timeout and response-size policy', async () => {
  let targetUrl = '';
  const target = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: new URL('/ok', targetUrl).href.replace('127.0.0.1', 'localhost') });
      return response.end();
    }
    if (request.url === '/large') {
      const body = 'x'.repeat(2048);
      response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      return response.end(body);
    }
    if (request.url === '/slow') {
      return setTimeout(() => response.end('late'), 80);
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Привет из provider');
  });
  targetUrl = await listenProvider(target);

  const handler = createHttpGetHandler({
    allowHosts: ['127.0.0.1'],
    allowPrivate: true,
    allowInsecure: true,
    timeoutMs: 25,
    maxResponseBytes: 1024,
  });
  const manifest = {
    schemaVersion: 1,
    provider: 'TestProvider',
    mappings: [{ operation: 'HTTP_GET', status: 'provider', providerRecipe: { kind: 'http-get' } }],
  };
  const provider = createProviderServer({
    token: 'secret',
    manifest,
    logger: null,
    handlers: { HTTP_GET: handler },
  });
  const providerUrl = await listenProvider(provider);
  try {
    const success = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/ok', targetUrl).href },
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true, result: 'Привет из provider' });

    const redirect = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/redirect', targetUrl).href },
    });
    assert.equal(redirect.status, 400);
    assert.match((await redirect.json()).error, /allow-list/);

    const oversized = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/large', targetUrl).href },
    });
    assert.equal(oversized.status, 502);
    assert.match((await oversized.json()).error, /too large/);

    const timeout = await call(providerUrl, {
      operation: 'HTTP_GET',
      payload: { URL: new URL('/slow', targetUrl).href },
    });
    assert.equal(timeout.status, 504);
    assert.match((await timeout.json()).error, /timed out/);
  } finally {
    await closeProvider(provider);
    await closeProvider(target);
  }
});

test('HTTP_GET recipe requires an explicit target allow-list', () => {
  assert.throws(
    () => createHttpGetHandler({ environment: {} }),
    /DX_HTTP_ALLOW_HOSTS/,
  );
});

test('HTTP_GET recipe blocks private targets, plaintext and URL credentials by default', async () => {
  const privateTarget = createHttpGetHandler({
    allowHosts: ['127.0.0.1'],
    allowInsecure: true,
    fetch: async () => {
      throw new Error('fetch must not run for a blocked target');
    },
  });
  await assert.rejects(
    () => privateTarget({ URL: 'http://127.0.0.1/private' }),
    /non-public address/,
  );

  const secureOnly = createHttpGetHandler({
    allowHosts: ['example.com'],
    allowPrivate: true,
    fetch: async () => {
      throw new Error('fetch must not run for a blocked target');
    },
  });
  await assert.rejects(
    () => secureOnly({ URL: 'http://example.com/plain' }),
    /Plain HTTP is disabled/,
  );
  await assert.rejects(
    () => secureOnly({ URL: 'https://user:password@example.com/secret' }),
    /Credentials .* not allowed/,
  );
});

test('HTTP_GET recipe allows a DNS hostname that resolves only to public IPv4', async () => {
  const handler = createHttpGetHandler({
    allowHosts: ['api.example'],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => new Response('public-ok', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
  });
  assert.equal(await handler({ URL: 'https://api.example/resource' }), 'public-ok');
});

test('HTTP request recipes preserve action/function contracts behind the URL policy', async () => {
  const requests = [];
  const target = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        ok: true,
        nested: { text: 'a/b"c' },
        items: [3, null],
        empty: '',
      }));
    });
  });
  const targetUrl = await listenProvider(target);
  const policy = {
    allowHosts: ['127.0.0.1'],
    allowPrivate: true,
    allowInsecure: true,
  };
  const action = createHttpRequestHandler({
    kind: 'http-request',
    contract: 'send-http-request-action-v1',
  }, policy);
  const fn = createHttpRequestHandler({
    kind: 'http-request',
    contract: 'send-http-request-function-v1',
  }, policy);
  try {
    const actionResult = await action({
      Method: 'GET',
      URL: new URL('/lookup', targetUrl).href,
      Headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer action-secret' },
      ],
      Params: [
        { name: 'q', value: 'Иван Иванов' },
        { name: 'active', value: '1' },
      ],
    });
    assert.equal(
      actionResult,
      'ok=True;nested.text=abc;items_0=3;items_1=null',
    );
    assert.equal(requests[0].method, 'GET');
    assert.equal(
      requests[0].url,
      '/lookup?q=%D0%98%D0%B2%D0%B0%D0%BD+%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2&active=1',
    );
    assert.equal(requests[0].headers.authorization, 'Bearer action-secret');
    assert.equal(requests[0].headers['user-agent'], 'DataExpress');

    const functionResult = await fn({
      Method: 'POST',
      URL: new URL('/submit', targetUrl).href,
      Headers: 'Content-Type=application/json,Accept=application/json',
      ApiKey: 'function-secret',
      Params: '{"query":"test"}',
    });
    assert.equal(
      functionResult,
      'ok=True;nested.text=abc;items_0=3;items_1=null',
    );
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].body, '{"query":"test"}');
    assert.equal(requests[1].headers.authorization, 'Token function-secret');
  } finally {
    await closeProvider(target);
  }
});

test('HTTP request recipe rejects unsafe headers and oversized request bodies', async () => {
  const handler = createHttpRequestHandler({
    kind: 'http-request',
    contract: 'send-http-request-function-v1',
  }, {
    allowHosts: ['example.com'],
    allowPrivate: true,
    maxRequestBytes: 8,
    fetch: async () => {
      throw new Error('fetch must not run');
    },
  });
  await assert.rejects(
    () => handler({
      Method: 'GET',
      URL: 'https://example.com/',
      Headers: 'Host=internal.example',
      Params: '',
    }),
    /does not allow the Host request header/,
  );
  await assert.rejects(
    () => handler({
      Method: 'POST',
      URL: 'https://example.com/',
      Headers: 'Content-Type=text/plain',
      Params: '123456789',
    }),
    /request is too large/,
  );
  assert.equal(
    await handler({ Method: 'PATCH', URL: 'https://example.com/' }),
    'Не поддерживаемый метод HTTP-запроса',
  );
});

test('HTTP request recipe strips credentials on an allowed cross-origin redirect', async () => {
  const seen = [];
  const handler = createHttpRequestHandler({
    kind: 'http-request',
    contract: 'send-http-request-function-v1',
  }, {
    allowHosts: ['api.example', 'cdn.example'],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (url, options) => {
      seen.push({ url: String(url), headers: new Headers(options.headers) });
      if (seen.length === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://cdn.example/result' },
        });
      }
      return new Response('redirect-ok', {
        headers: { 'content-type': 'text/plain' },
      });
    },
  });
  const result = await handler({
    Method: 'GET',
    URL: 'https://api.example/start',
    Headers: 'Authorization=Bearer secret,Cookie=session=secret',
    Params: '',
  });
  assert.equal(result, 'redirect-ok');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer secret');
  assert.equal(seen[0].headers.get('cookie'), 'session=secret');
  assert.equal(seen[1].headers.has('authorization'), false);
  assert.equal(seen[1].headers.has('cookie'), false);
});

test('DaData recipe preserves legacy XML and session field semantics', async () => {
  let request;
  const handler = createDadataSuggestHandler({
    suggestType: 'party',
    apiKeyParameter: 'ApiKey',
    queryParameter: 'SearhStr',
    stateVariables: [
      'value',
      'data.inn',
      'data.state.status',
      'data.state.actuality_date',
      'data.kpp',
    ],
    resultVariable: 'DA_FIRM_FIELD',
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        suggestions: [{
          value: 'ПАО ТЕСТ',
          data: {
            inn: '7700000000',
            state: {
              status: 'ACTIVE',
              actuality_date: 1_700_000_000_000,
            },
          },
        }],
      }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    },
  });

  const result = await handler({ ApiKey: 'api-secret', SearhStr: 'тест' });
  assert.equal(
    request.url,
    'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party',
  );
  assert.equal(request.options.headers.authorization, 'Token api-secret');
  assert.deepEqual(JSON.parse(request.options.body), { query: 'тест', count: 1 });
  assert.match(result.value, /^<SuggestResponse><suggestions>/);
  assert.match(result.value, /<inn>7700000000<\/inn>/);
  const variables = Object.fromEntries(result.variables.map(item => [item.name, item.value]));
  assert.equal(variables.value, 'ПАО ТЕСТ');
  assert.equal(variables['data.inn'], '7700000000');
  assert.equal(variables['data.state.status'], 'Действующая');
  assert.equal(variables['data.state.actuality_date'], '14.11.2023');
  assert.equal(variables['data.kpp'], null);
  assert.equal(variables.DA_FIRM_FIELD, result.value);
  assert.equal(handler.dataExpressImplemented, true);
});

test('DaData recipe clears legacy state without making a request for null search text', async () => {
  const handler = createDadataSuggestHandler({
    suggestType: 'address',
    stateVariables: ['value', 'data.region'],
    fetch: async () => {
      throw new Error('fetch must not run');
    },
  });
  assert.deepEqual(await handler({ ApiKey: '', SearhStr: null }), {
    value: '',
    variables: [
      { name: 'value', value: null },
      { name: 'data.region', value: null },
    ],
  });
});

test('Office recipe converts through an isolated headless LibreOffice profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-office-sdk-'));
  const inputRoot = join(root, 'input');
  const outputRoot = join(root, 'output');
  mkdirSync(inputRoot);
  mkdirSync(outputRoot);
  const input = join(inputRoot, 'source document.docx');
  const output = join(outputRoot, 'converted document');
  writeFileSync(input, 'synthetic-docx');
  let execution;
  try {
    const handler = createOfficeDocumentHandler({
      documentType: 'writer',
      inputRoots: [inputRoot],
      outputRoots: [outputRoot],
      environment: {},
      binary: 'soffice-test',
      execute: async options => {
        execution = options;
        writeFileSync(
          join(options.convertedDirectory, 'source document.pdf'),
          'synthetic-pdf',
        );
      },
    });
    assert.equal(await handler({
      aInputFile: input,
      aOutputFile: output,
      itemListExt: '.PDF   -   wdFormatPDF   -   PDF',
    }), true);
    assert.equal(readFileSync(`${output}.pdf`, 'utf8'), 'synthetic-pdf');
    assert.equal(execution.binary, 'soffice-test');
    assert.ok(execution.args.includes('--headless'));
    assert.ok(execution.args.some(argument =>
      argument.startsWith('-env:UserInstallation=file:')));
    assert.deepEqual(
      execution.args.slice(execution.args.indexOf('--convert-to'), -1),
      [
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        execution.convertedDirectory,
      ],
    );
    assert.equal(handler.dataExpressImplemented, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Office recipe confines input and output files to configured roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-office-sandbox-'));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  const allowedInput = join(allowed, 'source.xlsx');
  const outsideInput = join(outside, 'secret.xlsx');
  writeFileSync(allowedInput, 'allowed');
  writeFileSync(outsideInput, 'outside');
  try {
    const handler = createOfficeDocumentHandler({
      documentType: 'calc',
      inputRoots: [allowed],
      outputRoots: [allowed],
      environment: {},
      execute: async () => {
        throw new Error('conversion must not run for blocked paths');
      },
    });
    await assert.rejects(() => handler({
      aInputFile: outsideInput,
      aOutputFile: join(allowed, 'output.pdf'),
      itemListExt: '.PDF - xlTypePDF - PDF',
    }), /outside the allowed roots/);
    await assert.rejects(() => handler({
      aInputFile: allowedInput,
      aOutputFile: join(outside, 'output.pdf'),
      itemListExt: '.PDF - xlTypePDF - PDF',
    }), /outside the allowed roots/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Office recipe requires explicit filesystem roots', () => {
  assert.throws(() => createOfficeDocumentHandler({
    documentType: 'writer',
    environment: {},
  }), /DX_OFFICE_INPUT_ROOTS/);
});

test('Office recipe fails startup when LibreOffice is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataexpress-office-binary-'));
  try {
    assert.throws(() => createOfficeDocumentHandler({
      documentType: 'writer',
      inputRoots: [root],
      outputRoots: [root],
      environment: {},
      binary: join(root, 'missing-soffice'),
    }), /LibreOffice executable was not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid tokens and unknown operations', async () => {
  const server = createProviderServer({ token: 'secret', logger: null, handlers: {} });
  const url = await listenProvider(server);
  try {
    const unauthorized = await call(url, { operation: 'none', payload: null }, 'wrong');
    assert.equal(unauthorized.status, 401);
    const missing = await call(url, { operation: 'none', payload: null });
    assert.equal(missing.status, 404);
  } finally {
    await closeProvider(server);
  }
});

test('validates manifest operations before the provider starts', () => {
  const manifest = {
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [
      { operation: 'normalize', status: 'provider' },
      { operation: 'legacy_ui', status: 'manual', reason: 'desktop-ui' },
    ],
  };
  const capabilities = validateProviderManifest(manifest, {
    normalize: () => '',
    diagnostic: () => '',
  });
  assert.deepEqual(capabilities.operations, ['normalize']);
  assert.deepEqual(capabilities.extraHandlers, ['diagnostic']);
  assert.deepEqual(capabilities.manualOperations, [
    { operation: 'legacy_ui', reason: 'desktop-ui' },
  ]);
  assert.equal(capabilities.complete, false);

  assert.throws(
    () => validateProviderManifest(manifest, {}),
    error => error instanceof ProviderManifestError &&
      error.details.missingHandlers?.[0] === 'normalize',
  );
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [...manifest.mappings, { operation: 'normalize', status: 'provider' }],
    }, { normalize() {} }),
    /Duplicate provider operations: normalize/,
  );
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [{ operation: 'normalize', status: 'provider', providerRecipe: { kind: 'shell' } }],
    }, { normalize() {} }),
    /invalid provider recipe/,
  );
  assert.throws(
    () => validateProviderManifest({
      ...manifest,
      mappings: [{ operation: 'legacy_ui', status: 'manual', providerRecipe: { kind: 'http-get' } }],
    }, {}),
    /only allowed on provider mappings/,
  );
});

test('treats inline web-script mappings as complete without provider handlers', () => {
  const capabilities = validateProviderManifest({
    schemaVersion: 1,
    provider: 'Portable',
    mappings: [
      { operation: 'INLINE', status: 'web-script' },
      { operation: 'REMOTE', status: 'provider' },
    ],
  }, { REMOTE: async () => null });
  assert.deepEqual(capabilities.operations, ['REMOTE']);
  assert.deepEqual(capabilities.manualOperations, []);
  assert.equal(capabilities.complete, true);

  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'Portable',
    mappings: [{ operation: 'UNKNOWN', status: 'ready' }],
  }, {}), /Invalid provider mapping statuses: ready/);
});

test('does not accept inherited object properties as provider handlers', () => {
  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [{ operation: 'toString', status: 'provider' }],
  }, {}), /Missing provider handlers: toString/);
});

test('generated TODO handlers cannot advertise ready capabilities', () => {
  const pending = async () => {};
  pending.dataExpressImplemented = false;
  assert.throws(() => validateProviderManifest({
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [{ operation: 'normalize', status: 'provider' }],
  }, { normalize: pending }), /Unimplemented provider handlers: normalize/);
});

test('protects provider health and capabilities with the bearer token', async () => {
  const manifest = {
    schemaVersion: 1,
    provider: 'OfficeTools',
    mappings: [
      { operation: 'normalize', status: 'provider' },
      { operation: 'legacy_ui', status: 'manual', reason: 'desktop-ui' },
    ],
  };
  const server = createProviderServer({
    token: 'secret',
    manifest,
    logger: null,
    handlers: { normalize: value => value },
  });
  const url = await listenProvider(server);
  try {
    const unauthorized = await fetch(new URL('/health', url));
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: 'Bearer secret' };
    const health = await fetch(new URL('/health', url), { headers });
    assert.deepEqual(await health.json(), {
      ok: true,
      status: 'ready',
      provider: 'OfficeTools',
      complete: false,
    });

    const response = await fetch(new URL('/capabilities', url), { headers });
    const capabilities = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(capabilities.operations, ['normalize']);
    assert.deepEqual(capabilities.manualOperations, [
      { operation: 'legacy_ui', reason: 'desktop-ui' },
    ]);

    const mismatch = await call(url, { operation: 'normalize', payload: 'x' });
    assert.equal(mismatch.status, 409);
    assert.match((await mismatch.json()).error, /expected OfficeTools, got TestProvider/);
  } finally {
    await closeProvider(server);
  }
});
