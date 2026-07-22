import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewServer } from './dev-server.mjs';

async function withServer(run) {
	const server = createPreviewServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const address = server.address();
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test('serves the real modernized login assets and health endpoint', async () => {
	await withServer(async (baseUrl) => {
		const health = await fetch(`${baseUrl}/health`);
		assert.deepEqual(await health.json(), { status: 'ok', mode: 'preview' });

		const page = await fetch(`${baseUrl}/`);
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.match(html, /DataExpress Web · локальный preview/);
		assert.match(html, /\/html\/modern\.css/);
		assert.match(html, /\/html\/http\.js/);
		assert.doesNotMatch(html, /\[(?:lng|title|content)\]/);

		const transport = await fetch(`${baseUrl}/html/http.js`);
		assert.equal(transport.status, 200);
		assert.match(transport.headers.get('content-type'), /application\/javascript/);
	});
});

test('keeps the legacy login response code in preview mode', async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/?login`, { method: 'POST', body: 'user=demo' });
		const payload = await response.json();
		assert.equal(response.status, 223);
		assert.match(payload.error, /Pascal-бэкенда/);
	});
});

test('blocks traversal outside the static root', async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
		assert.equal(response.status, 403);
	});
});
