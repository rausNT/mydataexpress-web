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

test('serves the connection landing, modernized login and health endpoint', async () => {
	await withServer(async (baseUrl) => {
		const health = await fetch(`${baseUrl}/health`);
		assert.deepEqual(await health.json(), { status: 'ok', mode: 'preview' });

		const page = await fetch(`${baseUrl}/`);
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.match(html, /Открыть базу данных/);
		assert.match(html, /class="connection-card"/);
		assert.match(html, /href="\/demodb\/"/);
		assert.match(html, /\/html\/modern\.css/);
		assert.match(html, /\/html\/index\.js/);
		assert.doesNotMatch(html, /\[(?:lng|title|landing-[^\]]+|connection-[^\]]+|connections|content)\]/);

		const transport = await fetch(`${baseUrl}/html/http.js`);
		assert.equal(transport.status, 200);
		assert.match(transport.headers.get('content-type'), /application\/javascript/);

		const login = await fetch(`${baseUrl}/demodb/`);
		const loginHtml = await login.text();
		assert.equal(login.status, 200);
		assert.match(loginHtml, /DataExpress Web · локальный preview/);
		assert.match(loginHtml, /\/html\/modern\.css/);
		assert.match(loginHtml, /\/html\/http\.js/);
	});
});

test('keeps the legacy login response code in preview mode', async () => {
	await withServer(async (baseUrl) => {
		const response = await fetch(`${baseUrl}/demodb/?login`, { method: 'POST', body: 'user=demo' });
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
