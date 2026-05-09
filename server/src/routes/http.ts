const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, OPTIONS";
const CORS_EXPOSE_HEADERS = "X-YAOS-Snapshot-Day";

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
	headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);

	const responseWithSocket = response as { webSocket?: WebSocket };
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		webSocket: responseWithSocket.webSocket,
	});
}

export function corsPreflight(): Response {
	return withCors(new Response(null, { status: 204 }));
}

export function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
