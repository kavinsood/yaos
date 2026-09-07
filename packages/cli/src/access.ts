import WebSocket from "ws";

import type { WebSocketImplementation } from "../../../src/sync/vaultSync";
import type { AccessServiceCredentials } from "./config";

function serviceHeaders(credentials: AccessServiceCredentials): Record<string, string> {
	return {
		"CF-Access-Client-Id": credentials.clientId,
		"CF-Access-Client-Secret": credentials.clientSecret,
	};
}

/** Add Cloudflare Access service-token identity without persisting its secret. */
export function createAccessFetch(
	fetchImpl: typeof fetch,
	credentials: AccessServiceCredentials | null,
): typeof fetch {
	if (!credentials) return fetchImpl;
	return (input, init) => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
		for (const [name, value] of Object.entries(serviceHeaders(credentials))) headers.set(name, value);
		return fetchImpl(input, { ...init, headers });
	};
}

/** The `ws` constructor accepts handshake headers; the browser constructor does not. */
export function createAccessWebSocketImplementation(
	credentials: AccessServiceCredentials | null,
): WebSocketImplementation {
	if (!credentials) return WebSocket as unknown as WebSocketImplementation;
	const serviceCredentials = credentials;
	return class AccessWebSocket extends WebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols ?? [], { headers: serviceHeaders(serviceCredentials) });
		}
	} as unknown as WebSocketImplementation;
}
