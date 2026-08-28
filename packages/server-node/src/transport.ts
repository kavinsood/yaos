import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface NodeServerSocketEvent {
	readonly data?: string | ArrayBuffer;
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;
}

export type NodeServerSocketListener = (event: NodeServerSocketEvent) => void;

export interface NodeServerSocket {
	readonly readyState: number;
	accept(): void;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message" | "close" | "error", listener: NodeServerSocketListener): void;
	removeEventListener(type: "message" | "close" | "error", listener: NodeServerSocketListener): void;
}

export interface AcceptedWebSocketUpgrade {
	readonly accepted: true;
	connected(socket: NodeServerSocket): Promise<void> | void;
}

export type WebSocketUpgradeResult = AcceptedWebSocketUpgrade | Response;

export interface NodeTransportApplication {
	fetch(request: Request): Promise<Response>;
	upgrade(request: Request): Promise<WebSocketUpgradeResult>;
}
export type NodeReadinessFailure = "lock" | "migration" | "storage";


export interface NodeTransportOptions {
	readonly host: string;
	readonly port: number;
	readonly drainTimeoutMs?: number;
	readonly readiness: () => NodeReadinessFailure | null | Promise<NodeReadinessFailure | null>;
	readonly onError?: (error: unknown) => void;
}

function rawData(raw: RawData, binary: boolean): string | ArrayBuffer {
	const source = raw instanceof ArrayBuffer
		? Buffer.from(raw)
		: Array.isArray(raw) ? Buffer.concat(raw) : raw;
	if (!binary) return source.toString("utf8");
	const owned = new Uint8Array(source.byteLength);
	owned.set(source);
	return owned.buffer;
}

class WsServerSocket implements NodeServerSocket {
	private readonly listeners: Record<"message" | "close" | "error", Set<NodeServerSocketListener>> = {
		message: new Set(),
		close: new Set(),
		error: new Set(),
	};

	constructor(private readonly socket: WebSocket) {
		socket.on("message", (data, binary) => {
			this.emit("message", { data: rawData(data, binary) });
		});
		socket.on("close", (code, reason) => {
			this.emit("close", { code, reason: reason.toString("utf8"), wasClean: true });
		});
		socket.on("error", () => {
			this.emit("error", {});
		});
	}

	get readyState(): number {
		return this.socket.readyState;
	}

	accept(): void {
		// ws sockets are accepted by handleUpgrade before the domain receives this adapter.
	}

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (typeof data === "string") this.socket.send(data);
		else if (data instanceof ArrayBuffer) this.socket.send(new Uint8Array(data));
		else this.socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}

	close(code?: number, reason?: string): void {
		this.socket.close(code, reason);
	}

	addEventListener(type: "message" | "close" | "error", listener: NodeServerSocketListener): void {
		this.listeners[type].add(listener);
	}

	removeEventListener(type: "message" | "close" | "error", listener: NodeServerSocketListener): void {
		this.listeners[type].delete(listener);
	}

	private emit(type: "message" | "close" | "error", event: NodeServerSocketEvent): void {
		for (const listener of this.listeners[type]) listener(event);
	}
}

function requestUrl(request: IncomingMessage, host: string, port: number): URL {
	const authority = request.headers.host ?? `${host}:${port}`;
	return new URL(request.url ?? "/", `http://${authority}`);
}

function toWebRequest(request: IncomingMessage, host: string, port: number): Request {
	const method = request.method ?? "GET";
	const controller = new AbortController();
	request.once("aborted", () => controller.abort());
	const headers = new Headers();
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
	}
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		signal: controller.signal,
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(requestUrl(request, host, port), init);
}

async function sendResponse(response: Response, outgoing: ServerResponse, method: string): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	if (getSetCookie) {
		const cookies = getSetCookie.call(response.headers);
		if (cookies.length > 0) headers["set-cookie"] = cookies;
	}
	outgoing.writeHead(response.status, headers);
	if (method === "HEAD" || !response.body) {
		outgoing.end();
		return;
	}
	const reader = response.body.getReader();
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			if (!outgoing.write(result.value)) {
				await new Promise<void>((resolve, reject) => {
					outgoing.once("drain", resolve);
					outgoing.once("error", reject);
				});
			}
		}
		const finished = new Promise<void>((resolve, reject) => {
			outgoing.once("finish", resolve);
			outgoing.once("error", reject);
		});
		outgoing.end();
		await finished;
	} finally {
		reader.releaseLock();
	}
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
	const body = Buffer.from(await response.arrayBuffer());
	const reason = response.statusText || "Rejected";
	const lines = [`HTTP/1.1 ${response.status} ${reason}`];
	response.headers.forEach((value, key) => lines.push(`${key}: ${value}`));
	lines.push(`Content-Length: ${body.byteLength}`, "Connection: close", "", "");
	socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

export class NodeTransport {
	private readonly server: Server;
	private readonly webSockets = new WebSocketServer({ noServer: true, clientTracking: true });
	private readonly connections = new Set<Socket>();
	private ready = false;
	private draining = false;

	constructor(
		private readonly application: NodeTransportApplication,
		private readonly options: NodeTransportOptions,
	) {
		this.server = createServer((request, response) => void this.handleHttp(request, response));
		this.server.on("connection", (socket) => {
			this.connections.add(socket);
			socket.once("close", () => this.connections.delete(socket));
		});
		this.server.on("upgrade", (request, socket, head) => void this.handleUpgrade(request, socket, head));
	}

	async listen(): Promise<void> {
		if (this.ready) return;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.server.off("error", onError);
				resolve();
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.options.port, this.options.host);
		});
		this.ready = true;
	}

	async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		this.ready = false;
		for (const client of this.webSockets.clients) client.close(1001, "server shutdown");
		this.server.closeIdleConnections();
		const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
		const timeoutMs = this.options.drainTimeoutMs ?? 10_000;
		let timeout: NodeJS.Timeout | undefined;
		await Promise.race([
			closed,
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]);
		clearTimeout(timeout);
		for (const client of this.webSockets.clients) client.terminate();
		for (const connection of this.connections) connection.destroy();
		this.webSockets.close();
	}

	private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const url = requestUrl(request, this.options.host, this.options.port);
			if (request.method === "GET" && url.pathname === "/health") {
				await sendResponse(Response.json({ status: "ok" }), response, "GET");
				return;
			}
			if (request.method === "GET" && url.pathname === "/health/ready") {
				await sendResponse(await this.readinessResponse(), response, "GET");
				return;
			}
			if (this.draining) {
				await sendResponse(Response.json({ error: "server_draining" }, { status: 503 }), response, request.method ?? "GET");
				return;
			}
			const webRequest = toWebRequest(request, this.options.host, this.options.port);
			await sendResponse(await this.application.fetch(webRequest), response, webRequest.method);
		} catch (error) {
			this.options.onError?.(error);
			if (!response.headersSent) {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "internal_error" }));
			} else response.destroy(error instanceof Error ? error : undefined);
		}
	}

	private async readinessResponse(): Promise<Response> {
		if (this.draining || !this.ready) {
			return Response.json({ status: "not_ready", reason: "draining" }, { status: 503 });
		}
		let failure: unknown;
		try {
			failure = await this.options.readiness();
		} catch (error) {
			this.options.onError?.(error);
			failure = "storage";
		}
		if (this.draining || !this.ready) {
			return Response.json({ status: "not_ready", reason: "draining" }, { status: 503 });
		}
		if (failure === null) return Response.json({ status: "ready" });
		const reason: NodeReadinessFailure = failure === "lock" || failure === "migration" || failure === "storage"
			? failure
			: "storage";
		return Response.json({ status: "not_ready", reason }, { status: 503 });
	}

	private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		try {
			if (this.draining) {
				await rejectUpgrade(socket, Response.json({ error: "server_draining" }, { status: 503 }));
				return;
			}
			const webRequest = toWebRequest(request, this.options.host, this.options.port);
			const result = await this.application.upgrade(webRequest);
			if (result instanceof Response) {
				await rejectUpgrade(socket, result);
				return;
			}
			this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
				this.webSockets.emit("connection", webSocket, request);
				Promise.resolve(result.connected(new WsServerSocket(webSocket))).catch((error) => {
					this.options.onError?.(error);
					webSocket.close(1011, "socket initialization failed");
				});
			});
		} catch (error) {
			this.options.onError?.(error);
			if (!socket.destroyed) await rejectUpgrade(socket, Response.json({ error: "internal_error" }, { status: 500 }));
		}
	}
}
