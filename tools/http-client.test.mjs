import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../_test/html/http.js', import.meta.url), 'utf8');
const context = {};
vm.runInNewContext(source, context, { filename: 'http.js' });
const { DEFAULT_TIMEOUT_MS, send } = context.DataExpressHttp;

class FakeRequest {
	constructor(autoComplete = false) {
		this.autoComplete = autoComplete;
		this.readyState = 0;
		this.status = 200;
		this.headers = {};
	}

	open(method, path, async) {
		this.openArgs = { method, path, async };
	}

	setRequestHeader(name, value) {
		this.headers[name] = value;
	}

	send(body) {
		this.body = body;
		if (this.autoComplete) {
			this.readyState = 4;
			this.onreadystatechange();
		}
	}
}

test('sends a POST with the legacy content type and a bounded timeout', () => {
	const request = new FakeRequest(true);
	let shown = 0;
	let hidden = 0;
	let completed = 0;

	const result = send({
		createRequest: () => request,
		method: 'post',
		path: '/form?edit',
		args: 'a=1',
		onComplete: () => completed++,
		showCurtain: () => shown++,
		hideCurtain: () => hidden++
	});

	assert.equal(result, request);
	assert.deepEqual(request.openArgs, { method: 'POST', path: '/form?edit', async: true });
	assert.equal(request.timeout, DEFAULT_TIMEOUT_MS);
	assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=utf-8');
	assert.equal(request.body, 'a=1');
	assert.equal(request.dxTransportError, null);
	assert.equal(shown, 1);
	assert.equal(hidden, 1);
	assert.equal(completed, 1);
});

test('appends legacy GET arguments without changing their format', () => {
	const request = new FakeRequest(true);

	send({
		createRequest: () => request,
		method: 'GET',
		path: '/form?id=1',
		args: '&page=2'
	});

	assert.deepEqual(request.openArgs, { method: 'GET', path: '/form?id=1&page=2', async: true });
	assert.equal(request.body, null);
});

test('reports network failure and completes exactly once', () => {
	const request = new FakeRequest();
	let completed = 0;

	send({
		createRequest: () => request,
		method: 'POST',
		path: '/form',
		args: '',
		onComplete: () => completed++
	});

	request.onerror();
	request.readyState = 4;
	request.onreadystatechange();

	assert.equal(request.dxTransportError, 'network');
	assert.equal(completed, 1);
});

test('distinguishes timeout and abort failures', () => {
	for (const kind of ['timeout', 'abort']) {
		const request = new FakeRequest();
		let completed = 0;
		send({
			createRequest: () => request,
			method: 'GET',
			path: '/',
			onComplete: () => completed++
		});

		request[`on${kind}`]();
		assert.equal(request.dxTransportError, kind);
		assert.equal(completed, 1);
	}
});

test('does not apply XMLHttpRequest timeout to synchronous calls', () => {
	const request = new FakeRequest(true);

	send({
		createRequest: () => request,
		method: 'GET',
		path: '/',
		sync: true
	});

	assert.equal(request.openArgs.async, false);
	assert.equal(request.timeout, undefined);
});

test('turns a synchronous transport exception into a callback result', () => {
	const request = new FakeRequest();
	const error = new Error('open failed');
	request.open = () => { throw error; };
	let completed = 0;

	send({
		createRequest: () => request,
		method: 'GET',
		path: '/',
		onComplete: () => completed++
	});

	assert.equal(request.dxTransportError, 'exception');
	assert.equal(request.dxTransportException, error);
	assert.equal(completed, 1);
});
