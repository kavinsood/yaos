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
