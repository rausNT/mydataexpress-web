import { createServer } from 'node:http';

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

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

export function createProviderServer({ handlers, token = '', maxBody = DEFAULT_MAX_BODY, logger = console }) {
  if (!handlers || typeof handlers !== 'object') throw new TypeError('handlers must be an object');

  return createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return json(response, 405, { ok: false, error: 'Method not allowed' });
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, { ok: false, error: 'Unauthorized' });
      }

      const message = await readJson(request, maxBody);
      if (!message || typeof message.operation !== 'string') {
        return json(response, 400, { ok: false, error: 'operation must be a string' });
      }
      const handler = handlers[message.operation];
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
