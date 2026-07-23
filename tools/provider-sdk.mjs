import { createServer } from 'node:http';

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

export class ProviderManifestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderManifestError';
    this.details = details;
  }
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
