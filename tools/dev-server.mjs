import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staticRoot = resolve(projectRoot, '_test');

const contentTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.gif', 'image/gif'],
	['.html', 'text/html; charset=utf-8'],
	['.ico', 'image/x-icon'],
	['.jpeg', 'image/jpeg'],
	['.jpg', 'image/jpeg'],
	['.js', 'application/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml; charset=utf-8'],
	['.woff2', 'font/woff2']
]);

function send(response, status, body, contentType) {
	response.writeHead(status, {
		'Content-Type': contentType,
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(body);
}

async function renderLogin() {
	const template = await readFile(resolve(staticRoot, 'html', 'loginuser.html'), 'utf8');
	const content = '<div id="msg">DataExpress Web · локальный preview</div>' +
		'<div>Пользователь</div><div><input type="text" name="user" value="demo" autofocus></div>' +
		'<div>Пароль</div><div><input type="password" name="pwd"></div><div class="bn">' +
		'<div id="loader" class="hide"><div></div></div><button id="submit" type="submit">' +
		'<img src="/img/login.svg" alt=""><span>Войти</span></button></div>';

	return template
		.replaceAll('[lng]', 'ru')
		.replaceAll('[title]', 'DataExpress Web — локальный preview')
		.replaceAll('[content]', content);
}

async function serveStatic(pathname, response) {
	let decodedPath;
	try {
		decodedPath = decodeURIComponent(pathname);
	} catch {
		send(response, 400, 'Bad request', 'text/plain; charset=utf-8');
		return;
	}

	const filePath = resolve(staticRoot, `.${decodedPath}`);
	if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
		send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
		return;
	}

	try {
		const body = await readFile(filePath);
		const contentType = contentTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
		send(response, 200, body, contentType);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'EISDIR') {
			send(response, 404, 'Not found', 'text/plain; charset=utf-8');
			return;
		}
		throw error;
	}
}

export function createPreviewServer() {
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url || '/', 'http://localhost');

			if (request.method === 'GET' && url.pathname === '/health') {
				send(response, 200, JSON.stringify({ status: 'ok', mode: 'preview' }), 'application/json; charset=utf-8');
				return;
			}

			if (request.method === 'GET' && url.pathname === '/') {
				send(response, 200, await renderLogin(), 'text/html; charset=utf-8');
				return;
			}

			if (request.method === 'POST' && url.pathname === '/' && url.searchParams.has('login')) {
				send(response, 223, JSON.stringify({
					code: 0,
					error: 'Preview работает. Вход станет доступен после сборки Pascal-бэкенда.'
				}), 'application/json; charset=utf-8');
				return;
			}

			if (request.method !== 'GET') {
				send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
				return;
			}

			await serveStatic(url.pathname, response);
		} catch (error) {
			console.error(error);
			if (!response.headersSent) send(response, 500, 'Internal server error', 'text/plain; charset=utf-8');
			else response.end();
		}
	});
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	const host = process.env.DX_HOST || '127.0.0.1';
	const port = Number.parseInt(process.env.DX_PORT || '8080', 10);
	const server = createPreviewServer();
	server.listen(port, host, () => {
		console.log(`DataExpress Web preview: http://${host}:${port}`);
	});
}
