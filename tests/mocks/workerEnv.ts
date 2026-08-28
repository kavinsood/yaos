/**
 * Typed fakes for the portable worker environment and its narrow actor,
 * object-store, socket-upgrade, and Durable Object wrapper seams.
 *
 * Defaults are hostile: an unexpected actor call throws and records the
 * access so route-classification tests prove rejected requests stayed blind.
 */

import type {
	ActorCallPort,
	ObjectBody,
	ObjectListPage,
	ObjectMetadata,
	ObjectStorePort,
	ObjectWriteOptions,
	SocketUpgradePort,
} from "../../server/src/platformPorts.ts";
import type { Env } from "../../server/src/routes/types.ts";


// ---------------------------------------------------------------------------
// Durable Object namespaces
// ---------------------------------------------------------------------------

/** A `DurableObjectId` whose identity is its name, so `equals` is meaningful. */
export function makeDurableObjectId(name: string): DurableObjectId {
	return {
		name,
		toString: () => name,
		equals: (other: DurableObjectId) => other.toString() === name,
	};
}

/** Named actor trap used to prove rejected routes do not reach storage-backed actors. */
export interface FakeTrapNamespace extends ActorCallPort {
	readonly touched: string[];
}

export function makeTrapNamespace(message: string): FakeTrapNamespace {
	const touched: string[] = [];
	return {
		touched,
		call(actorName: string): Promise<Response> {
			touched.push(`call:${actorName}`);
			throw new Error(`${message} (via call)`);
		},
	};
}

export interface FakeConfigNamespace extends ActorCallPort {
	readonly calls: number;
}

export function makeConfigNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeConfigNamespace {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		async call(_actorName: string, request: Request): Promise<Response> {
			calls++;
			return await fetchImpl(request);
		},
	};
}

export function makeStoredConfigNamespace(config: unknown): FakeConfigNamespace {
	return makeConfigNamespace(async () =>
		new Response(JSON.stringify(config), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
}

export interface FakeVaultSyncNamespace extends ActorCallPort {
	readonly calls: number;
	readonly actorSelections: number;
}

export function makeVaultSyncNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeVaultSyncNamespace {
	let actorSelections = 0;
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		get actorSelections() {
			return actorSelections;
		},
		async call(_actorName: string, request: Request): Promise<Response> {
			actorSelections++;
			calls++;
			return await fetchImpl(request);
		},
	};
}

export type FakeRecoveryJobNamespace = ActorCallPort;
export function makeRecoveryJobNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeRecoveryJobNamespace {
	return {
		call: async (_actorName: string, request: Request) => await fetchImpl(request),
	};
}


export interface FakeDurableObjectStateOptions {
	onDeleteAll?: () => void | Promise<void>;
	onDeleteAlarm?: () => void | Promise<void>;
	getWebSockets?: (tag?: string) => WebSocket[];
}

class FakeDurableObjectStorage implements DurableObjectStorage {
	constructor(private readonly options: FakeDurableObjectStateOptions) {}

	get sql(): never {
		throw new Error("FakeDurableObjectStorage: sql is not implemented");
	}

	get kv(): never {
		throw new Error("FakeDurableObjectStorage: kv is not implemented");
	}

	get(): never {
		throw new Error("FakeDurableObjectStorage: get() is not implemented");
	}

	list(): never {
		throw new Error("FakeDurableObjectStorage: list() is not implemented");
	}

	put(): never {
		throw new Error("FakeDurableObjectStorage: put() is not implemented");
	}

	delete(): never {
		throw new Error("FakeDurableObjectStorage: delete() is not implemented");
	}

	async deleteAll(): Promise<void> {
		await this.options.onDeleteAll?.();
	}

	transaction(): never {
		throw new Error("FakeDurableObjectStorage: transaction() is not implemented");
	}

	getAlarm(): never {
		throw new Error("FakeDurableObjectStorage: getAlarm() is not implemented");
	}

	setAlarm(): never {
		throw new Error("FakeDurableObjectStorage: setAlarm() is not implemented");
	}

	async deleteAlarm(): Promise<void> {
		await this.options.onDeleteAlarm?.();
	}

	sync(): never {
		throw new Error("FakeDurableObjectStorage: sync() is not implemented");
	}

	transactionSync<T>(closure: () => T): T {
		return closure();
	}

	getCurrentBookmark(): never {
		throw new Error("FakeDurableObjectStorage: getCurrentBookmark() is not implemented");
	}

	getBookmarkForTime(): never {
		throw new Error("FakeDurableObjectStorage: getBookmarkForTime() is not implemented");
	}

	onNextSessionRestoreBookmark(): never {
		throw new Error("FakeDurableObjectStorage: onNextSessionRestoreBookmark() is not implemented");
	}
}

/** A complete Durable Object state with explicit hooks for the operations a suite uses. */
export function makeDurableObjectState(options: FakeDurableObjectStateOptions = {}): DurableObjectState {
	return {
		props: {},
		id: makeDurableObjectId("fake-durable-object"),
		storage: new FakeDurableObjectStorage(options),
		waitUntil: () => {},
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => await callback(),
		acceptWebSocket: () => {},
		getWebSockets: (tag?: string) => options.getWebSockets?.(tag) ?? [],
		setWebSocketAutoResponse: () => {},
		getWebSocketAutoResponse: () => null,
		getWebSocketAutoResponseTimestamp: () => null,
		setHibernatableWebSocketEventTimeout: () => {},
		getHibernatableWebSocketEventTimeout: () => null,
		getTags: () => [],
		abort: (reason?: string): never => {
			throw new Error(reason ?? "FakeDurableObjectState: abort()");
		},
	};
}


// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

function makeObjectMetadata(key: string, bytes: Uint8Array): ObjectMetadata {
	return {
		key,
		size: bytes.byteLength,
		uploadedAt: 0,
		contentType: null,
		customMetadata: {},
	};
}

function makeObjectBody(key: string, bytes: Uint8Array): ObjectBody {
	return { ...makeObjectMetadata(key, bytes), bytes: bytes.slice() };
}

export interface FakeObjectStoreInit {
	objects?: Map<string, Uint8Array>;
	onPut?: (key: string, bytes: Uint8Array) => void;
}

/** In-memory implementation of the portable object-store contract. */
export class FakeObjectStore implements ObjectStorePort {
	readonly objects: Map<string, Uint8Array>;
	readonly puts: Array<{ key: string; bytes: Uint8Array }> = [];
	readonly gets: string[] = [];
	readonly heads: string[] = [];
	readonly deletes: string[] = [];
	listCalls = 0;

	private readonly onPut: ((key: string, bytes: Uint8Array) => void) | undefined;

	constructor(init: FakeObjectStoreInit = {}) {
		this.objects = init.objects ?? new Map();
		this.onPut = init.onPut;
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		this.heads.push(key);
		const bytes = this.objects.get(key);
		return bytes === undefined ? null : makeObjectMetadata(key, bytes);
	}

	async get(key: string): Promise<ObjectBody | null> {
		this.gets.push(key);
		const bytes = this.objects.get(key);
		return bytes === undefined ? null : makeObjectBody(key, bytes);
	}

	async put(key: string, value: Uint8Array, _options?: ObjectWriteOptions): Promise<void> {
		const bytes = value.slice();
		this.onPut?.(key, bytes);
		this.objects.set(key, bytes);
		this.puts.push({ key, bytes });
	}

	async createOnly(key: string, value: Uint8Array, options?: ObjectWriteOptions): Promise<"created" | "exists"> {
		if (this.objects.has(key)) return "exists";
		await this.put(key, value, options);
		return "created";
	}

	async delete(key: string): Promise<void> {
		this.deletes.push(key);
		this.objects.delete(key);
	}

	async list(input: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListPage> {
		this.listCalls++;
		const keys = [...this.objects.keys()].filter((key) => key.startsWith(input.prefix)).sort();
		const start = input.cursor ? Math.max(0, Number(input.cursor)) : 0;
		const limit = input.limit ?? keys.length;
		const selected = keys.slice(start, start + limit);
		const next = start + selected.length;
		return {
			objects: selected.map((key) => makeObjectMetadata(key, this.objects.get(key)!)),
			cursor: next < keys.length ? String(next) : null,
			truncated: next < keys.length,
		};
	}
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Message for a namespace the test never wired up.
 *
 * Named per binding, not shared: suites assert on WHICH namespace was reached,
 * and one message for both would let a handler touching the wrong namespace
 * produce an indistinguishable failure.
 */
function unexpectedNamespace(binding: "YAOS_SYNC" | "YAOS_CONFIG"): string {
	return `workerEnv: env.${binding} accessed by a test that did not provide it`;
}

/**
 * A complete `Env`, with the parts a test does not care about trapped.
 *
 * The defaults are deliberately hostile rather than inert: a handler that
 * reaches for a binding the test did not set up throws, instead of silently
 * seeing `undefined` the way an `as any` env would let it.
 */
const rejectedSocketUpgrade: SocketUpgradePort = {
	reject: () => new Response(null, { status: 400 }),
};

export function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		YAOS_SYNC: makeTrapNamespace(unexpectedNamespace("YAOS_SYNC")),
		YAOS_CONFIG: makeTrapNamespace(unexpectedNamespace("YAOS_CONFIG")),
		socketUpgrades: rejectedSocketUpgrade,
		...overrides,
	};
}
