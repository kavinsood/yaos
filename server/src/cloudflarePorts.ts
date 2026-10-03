import type {
	ActorCallPort,
	AlarmPort,
	ExecutionPort,
	ObjectBody,
	ObjectListPage,
	ObjectMetadata,
	ObjectStorePort,
	ObjectWriteOptions,
	SocketUpgradePort,
} from "./platformPorts";
import type { VaultSocketPort, VaultSocketRegistryPort } from "./vaultSocketService";

function metadata(object: R2Object): ObjectMetadata {
	return {
		key: object.key,
		size: object.size,
		uploadedAt: object.uploaded.getTime(),
		contentType: object.httpMetadata?.contentType ?? null,
		customMetadata: object.customMetadata ?? {},
	};
}

function r2Options(options?: ObjectWriteOptions): R2PutOptions | undefined {
	if (!options) return undefined;
	return {
		httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
		customMetadata: options.customMetadata ? { ...options.customMetadata } : undefined,
	};
}

/** R2 rejects a put whose bytes do not match the supplied checksum (S3 BadDigest; R2 error 10037). */
export function isR2DigestMismatch(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b10037\b|BadDigest|checksum|digest.*(?:match|mismatch)|did not match/i.test(message);
}

/**
 * R2 needs a stream of known length. A request body with a declared
 * Content-Length already is one; FixedLengthStream (workerd only) restates the
 * length and errors if the body is shorter or longer. Piped natively.
 */
function knownLengthStream(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
	const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> })
		.FixedLengthStream;
	if (!Fixed) return body;
	const fixed = new Fixed(length);
	void body.pipeTo(fixed.writable).catch(() => undefined);
	return fixed.readable;
}

export class CloudflareObjectStore implements ObjectStorePort {
	constructor(private readonly bucket: R2Bucket) {}

	async head(key: string): Promise<ObjectMetadata | null> {
		const object = await this.bucket.head(key);
		return object ? metadata(object) : null;
	}

	async get(key: string): Promise<ObjectBody | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { ...metadata(object), bytes: new Uint8Array(await object.arrayBuffer()) };
	}

	async put(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<void> {
		await this.bucket.put(key, bytes, r2Options(options));
	}

	/**
	 * b3-clientblob: R2 checks the `sha256` put option against the bytes it
	 * received and rejects the put (nothing stored) on mismatch, so the front
	 * Worker passes the declared-length request stream through without reading
	 * or hashing it (measured ~2.2 ms CPU/MiB for the buffered read + digest).
	 */
	async putVerifiedStream(
		key: string,
		body: ReadableStream<Uint8Array>,
		length: number,
		sha256: string,
		options?: ObjectWriteOptions,
	): Promise<"stored" | "digest_mismatch"> {
		try {
			await this.bucket.put(key, knownLengthStream(body, length), { ...(r2Options(options) ?? {}), sha256 });
			return "stored";
		} catch (error) {
			if (isR2DigestMismatch(error)) return "digest_mismatch";
			throw error;
		}
	}

	async createOnly(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<"created" | "exists"> {
		const optionsForR2 = r2Options(options) ?? {};
		const written = await this.bucket.put(key, bytes, {
			...optionsForR2,
			onlyIf: { etagDoesNotMatch: "*" },
		});
		return written === null ? "exists" : "created";
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}

	async list(input: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListPage> {
		const page = await this.bucket.list(input);
		return {
			objects: page.objects.map(metadata),
			cursor: page.truncated ? page.cursor : null,
			truncated: page.truncated,
		};
	}
}

export class CloudflareActorCalls implements ActorCallPort {
	constructor(private readonly namespace: DurableObjectNamespace) {}

	call(actorName: string, request: Request): Promise<Response> {
		return this.namespace.get(this.namespace.idFromName(actorName)).fetch(request);
	}
}

export class CloudflareAlarmPort implements AlarmPort {
	constructor(private readonly storage: DurableObjectStorage) {}

	setAlarm(scheduledTime: number): Promise<void> {
		return this.storage.setAlarm(scheduledTime);
	}

	deleteAlarm(): Promise<void> {
		return this.storage.deleteAlarm();
	}

	getAlarm(): Promise<number | null> {
		return this.storage.getAlarm();
	}
}

export class CloudflareExecutionPort implements ExecutionPort {
	constructor(private readonly state: DurableObjectState) {}

	waitUntil(task: Promise<unknown>): void {
		this.state.waitUntil(task);
	}
}

export class CloudflareSocketRegistry implements VaultSocketRegistryPort {
	constructor(private readonly state: DurableObjectState) {}

	sockets(): readonly VaultSocketPort[] {
		return this.state.getWebSockets();
	}

	createPair(): { client: unknown; server: VaultSocketPort } {
		const pair = new WebSocketPair();
		return { client: pair[0], server: pair[1] };
	}

	accept(socket: VaultSocketPort): void {
		this.state.acceptWebSocket(socket as WebSocket);
	}

	upgradeResponse(client: unknown): Response {
		return new Response(null, { status: 101, webSocket: client as WebSocket });
	}
}

function sendableCloseCode(code: number): boolean {
	return Number.isInteger(code) && code >= 1000 && code < 5000
		&& code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
}

/**
 * Completes a peer-initiated close handshake from a hibernation webSocketClose
 * handler. Before compatibility date 2026-04-07 (web_socket_auto_reply_to_close)
 * the runtime leaves the socket CLOSING until the Durable Object reciprocates;
 * with auto-reply the socket is already CLOSED and the call is ignored.
 */
export function reciprocateSocketClose(socket: Pick<VaultSocketPort, "close">, code: number, reason: string): void {
	if (sendableCloseCode(code)) {
		try {
			socket.close(code, reason);
			return;
		} catch {
			// The echoed code or reason was refused (e.g. a reason over the
			// 123-byte limit, or a code the runtime will not send); a code-less
			// close still completes the handshake.
		}
	}
	try {
		// Reserved codes (1005 "no status", 1006 abnormal) cannot be sent back.
		socket.close();
	} catch {
		// Already closed, or the runtime completed the handshake itself.
	}
}

export class CloudflareSocketUpgrades implements SocketUpgradePort {
	reject(frame: string, closeCode: number, reason: string): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();
		server.send(frame);
		server.close(closeCode, reason);
		return new Response(null, { status: 101, webSocket: client });
	}
}
