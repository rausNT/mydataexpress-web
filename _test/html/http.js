(function (root, factory) {
	const api = factory();
	root.DataExpressHttp = api;

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const DEFAULT_TIMEOUT_MS = 30000;

	function send(options) {
		const createRequest = options.createRequest;
		const request = createRequest();
		if (!request) return null;

		const method = String(options.method || 'GET').toUpperCase();
		const args = options.args == null ? '' : String(options.args);
		const async = options.sync !== true;
		const timeoutMs = options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
		let path = String(options.path || '');
		let completed = false;

		function finish(errorKind, exception) {
			if (completed) return;
			completed = true;

			request.dxTransportError = errorKind || null;
			if (exception) request.dxTransportException = exception;

			if (options.hideCurtain) options.hideCurtain();
			if (options.onComplete) options.onComplete(request);
		}

		request.onreadystatechange = function () {
			if (request.readyState === 4) {
				finish(request.status === 0 ? 'network' : null);
			}
		};
		request.onerror = function () { finish('network'); };
		request.ontimeout = function () { finish('timeout'); };
		request.onabort = function () { finish('abort'); };

		if (options.showCurtain) options.showCurtain();
		if (method === 'GET' && args.length > 0) path += args;

		try {
			request.open(method, path, async);
			if (async && timeoutMs > 0) request.timeout = timeoutMs;

			if (method === 'POST') {
				request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8');
				request.send(args);
			} else if (method === 'PUT') {
				request.send(args);
			} else {
				request.send(null);
			}
		} catch (exception) {
			finish('exception', exception);
		}

		return request;
	}

	return {
		DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
		send: send
	};
});
