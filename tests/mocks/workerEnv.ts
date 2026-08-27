/**
 * Typed fakes for the Cloudflare Worker `Env` and the bindings hanging off it.
 *
 * Server suites need an `Env` to call route handlers, but its bindings include
 * platform values such as `DurableObjectNamespace` and `R2Bucket`. Historically
 * suites built partial objects behind casts, which silenced the compiler on the
 * exact surface under test.
 *
 * The fakes below implement the narrow fetch-only ports used by vault and
 * recovery-job routes. Full platform interfaces are implemented only where the
 * product genuinely consumes them, such as config namespaces and R2 buckets.
 * Unused operations return `never` and throw so newly reached behavior fails
 * loudly instead of quietly producing `undefined`.
 */

import type {
	RecoveryJobNamespacePort,
	RecoveryJobStubPort,
} from "../../server/src/recoveryExecutor.ts";
import type {
	Env,
	VaultRuntimeStubPort,
	VaultSyncNamespacePort,
} from "../../server/src/routes/types.ts";

/** Independent ArrayBuffer over exactly `bytes`, never the parent allocation. */
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

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

/**
 * A trap namespace that records every platform or narrow-port member reached.
 *
 * Its `never` returns satisfy both the full config namespace and the fetch-only
 * vault runtime namespace while guaranteeing any access fails loudly.
 */
export interface FakeTrapNamespace {
	/**
	 * Names of every member accessed, in order.
	 *
	 * A suite asserting "this path never woke the Durable Object" needs a
	 * positive observable, not just the absence of a thrown error: the throw
	 * only surfaces if the caller does not swallow it.  Reading `touched` proves
	 * the negative directly.
	 */
	readonly touched: string[];
	newUniqueId(options?: DurableObjectNamespaceNewUniqueIdOptions): never;
	idFromName(name: string): never;
	idFromString(id: string): never;
	get(id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions): never;
	getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions): never;
	jurisdiction(jurisdiction: DurableObjectJurisdiction): never;
}

/**
 * A namespace whose every member records itself in `touched`, then throws
 * `message`. It proves rejected paths do not allocate any Durable Object.
 */
export function makeTrapNamespace(message: string): FakeTrapNamespace {
	const touched: string[] = [];
	const trap = (member: string) => (): never => {
		touched.push(member);
		throw new Error(`${message} (via ${member})`);
	};
	return {
		touched,
		newUniqueId: trap("newUniqueId"),
		idFromName: trap("idFromName"),
		idFromString: trap("idFromString"),
		get: trap("get"),
		getByName: trap("getByName"),
		jurisdiction: trap("jurisdiction"),
	};
}

/** A config namespace whose stub `fetch` is supplied by the test. */
export interface FakeConfigNamespace extends DurableObjectNamespace {
	/** How many times a stub was looked up via `get`/`getByName`. */
	readonly calls: number;
}

/**
 * A `YAOS_CONFIG` namespace that hands every lookup the same stub, whose
 * `fetch` is `fetchImpl`.
 *
 * `DurableObjectStub<undefined>` is `{ fetch, connect, id, name? }` — the RPC
 * provider half collapses away when the namespace is unparameterised — so the
 * whole stub is buildable.  `connect` opens a raw TCP socket and no config
 * lookup does that, so it throws.
 */
export function makeConfigNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeConfigNamespace {
	let calls = 0;
	const stub = (id: DurableObjectId): DurableObjectStub => ({
		id,
		name: id.name,
		fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
			await fetchImpl(input instanceof Request ? input : new Request(String(input), init)),
		connect: (): never => {
			throw new Error("FakeConfigNamespace: stub.connect() is not implemented");
		},
	});
	return {
		get calls() {
			return calls;
		},
		newUniqueId: () => makeDurableObjectId("global-config"),
		idFromName: (name: string) => makeDurableObjectId(name),
		idFromString: (id: string) => makeDurableObjectId(id),
		get: (id: DurableObjectId) => {
			calls++;
			return stub(id);
		},
		getByName: (name: string) => {
			calls++;
			return stub(makeDurableObjectId(name));
		},
		jurisdiction: (): never => {
			throw new Error("FakeConfigNamespace: jurisdiction() is not implemented");
		},
	};
}

/**
 * A config namespace that answers every lookup with `config` as JSON.
 *
 * Convenience over `makeConfigNamespace` for the common case: suites that only
 * need the stored server config to come back.
 */
export function makeStoredConfigNamespace(config: unknown): FakeConfigNamespace {
	return makeConfigNamespace(async () =>
		new Response(JSON.stringify(config), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
}
/** A typed `YAOS_SYNC` namespace whose fetch-only stub is supplied by the test. */
export interface FakeVaultSyncNamespace extends VaultSyncNamespacePort {
	/** How many times the stub was looked up via `get`. */
	readonly calls: number;
	/** How many named Durable Object identities were derived. */
	readonly idFromNameCalls: number;
}

export function makeVaultSyncNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeVaultSyncNamespace {
	let idFromNameCalls = 0;
	let calls = 0;
	const stub = (): VaultRuntimeStubPort => ({
		fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
			await fetchImpl(input instanceof Request ? input : new Request(String(input), init)),
	});
	const namespace: FakeVaultSyncNamespace = {
		get calls() {
			return calls;
		},
		get idFromNameCalls() {
			return idFromNameCalls;
		},
		idFromName: (name: string) => {
			idFromNameCalls++;
			return makeDurableObjectId(name);
		},
		get: () => {
			calls++;
			return stub();
		},
	};
	return namespace;
}
/** The fetch-only recovery-job stub surface exercised by server tests. */
export type FakeRecoveryJobStub = RecoveryJobStubPort;

/** The named-actor recovery namespace surface exercised by server tests. */
export interface FakeRecoveryJobNamespace extends RecoveryJobNamespacePort {
	get(id: DurableObjectId): FakeRecoveryJobStub;
}

export function makeRecoveryJobNamespace(
	fetchImpl: (req: Request) => Promise<Response>,
): FakeRecoveryJobNamespace {
	return {
		idFromName: (name: string) => makeDurableObjectId(name),
		get: () => ({
			fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
				await fetchImpl(input instanceof Request ? input : new Request(String(input), init)),
		}),
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
// R2
// ---------------------------------------------------------------------------

/** Every value `R2Bucket.put` accepts. */
type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

async function putValueToBytes(value: R2PutValue): Promise<Uint8Array> {
	if (value === null) return new Uint8Array(0);
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(
			value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
		);
	}
	// Blob and ReadableStream both reach bytes through Response.
	return new Uint8Array(await new Response(value).arrayBuffer());
}

/**
 * The R2 object metadata fields, as plain properties.
 *
 * Spelled as its own interface rather than reusing `R2Object` because
 * `R2Object` declares `writeHttpMetadata` as a *method*, which lives on the
 * prototype and is therefore dropped by an object spread — building the body
 * variant with `{ ...makeR2Object(...) }` silently loses it.  As a property
 * signature it survives the spread.
 */
interface R2Meta {
	key: string;
	version: string;
	size: number;
	etag: string;
	httpEtag: string;
	checksums: R2Checksums;
	uploaded: Date;
	storageClass: string;
	writeHttpMetadata: (headers: Headers) => void;
}

/**
 * R2 metadata for `bytes` stored at `key`.
 *
 * `version`/`etag` are derived from key and length rather than a real content
 * hash: no assertion in any suite depends on their value, and inventing a hash
 * here would make them look authoritative when they are not.
 */
function makeR2Meta(key: string, bytes: Uint8Array): R2Meta {
	const etag = `${key.length.toString(16)}-${bytes.byteLength.toString(16)}`;
	return {
		key,
		version: etag,
		size: bytes.byteLength,
		etag,
		httpEtag: `"${etag}"`,
		checksums: { toJSON: () => ({}) },
		uploaded: new Date(0),
		storageClass: "Standard",
		writeHttpMetadata: (_headers: Headers) => {},
	};
}

function makeR2Object(key: string, bytes: Uint8Array): R2Object {
	return makeR2Meta(key, bytes);
}

function makeR2ObjectBody(key: string, bytes: Uint8Array): R2ObjectBody {
	let bodyUsed = false;
	return {
		...makeR2Meta(key, bytes),
		get bodyUsed() {
			return bodyUsed;
		},
		get body() {
			bodyUsed = true;
			// Response.body is typed nullable, but a Response constructed over a
			// non-null body always has one.
			return new Response(ownedBuffer(bytes)).body!;
		},
		arrayBuffer: async () => ownedBuffer(bytes),
		bytes: async () => new Uint8Array(ownedBuffer(bytes)),
		text: async () => new TextDecoder().decode(bytes),
		json: async <T>(): Promise<T> => JSON.parse(new TextDecoder().decode(bytes)),
		blob: async () => new Blob([ownedBuffer(bytes)]),
	};
}

export interface FakeR2BucketInit {
	/**
	 * Objects already in the bucket, keyed by R2 key.  `get`/`head` serve from
	 * here and return `null` for anything absent, which is how a test scripts
	 * "this key exists, that one does not".
	 */
	objects?: Map<string, Uint8Array>;
	/**
	 * Called on every `put` before the object is recorded.  Throw from here to
	 * simulate a write failure.
	 */
	onPut?: (key: string, bytes: Uint8Array) => void;
}

/**
 * An in-memory `R2Bucket`.
 *
 * `put`/`get`/`head`/`delete`/`list` are real and operate on `objects`; every
 * call is recorded so tests can assert both the effect and the access pattern.
 * Multipart upload is not implemented because no suite uses it — it throws
 * rather than pretending.
 */
export class FakeR2Bucket implements R2Bucket {
	/** Live contents, keyed by R2 key.  Mutable: tests may seed or clear it. */
	readonly objects: Map<string, Uint8Array>;

	/** Every accepted `put`, in order. */
	readonly puts: Array<{ key: string; bytes: Uint8Array }> = [];
	/** Every key passed to `get`, in order, including misses. */
	readonly gets: string[] = [];
	/** Every key passed to `head`, in order, including misses. */
	readonly heads: string[] = [];
	/** Every key passed to `delete`, in order, flattened. */
	readonly deletes: string[] = [];
	/** How many times `list` was called. */
	listCalls = 0;

	private readonly onPut: ((key: string, bytes: Uint8Array) => void) | undefined;

	constructor(init: FakeR2BucketInit = {}) {
		this.objects = init.objects ?? new Map();
		this.onPut = init.onPut;
	}

	async head(key: string): Promise<R2Object | null> {
		this.heads.push(key);
		const bytes = this.objects.get(key);
		return bytes === undefined ? null : makeR2Object(key, bytes);
	}

	get(
		key: string,
		options: R2GetOptions & { onlyIf: R2Conditional | Headers },
	): Promise<R2ObjectBody | R2Object | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
	async get(key: string): Promise<R2ObjectBody | null> {
		this.gets.push(key);
		const bytes = this.objects.get(key);
		return bytes === undefined ? null : makeR2ObjectBody(key, bytes);
	}

	put(
		key: string,
		value: R2PutValue,
		options?: R2PutOptions & { onlyIf: R2Conditional | Headers },
	): Promise<R2Object | null>;
	put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object>;
	async put(key: string, value: R2PutValue): Promise<R2Object> {
		const bytes = await putValueToBytes(value);
		this.onPut?.(key, bytes);
		this.objects.set(key, bytes);
		this.puts.push({ key, bytes });
		return makeR2Object(key, bytes);
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of typeof keys === "string" ? [keys] : keys) {
			this.deletes.push(key);
			this.objects.delete(key);
		}
	}

	async list(options?: R2ListOptions): Promise<R2Objects> {
		this.listCalls++;
		const prefix = options?.prefix ?? "";
		const objects = [...this.objects]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, bytes]) => makeR2Object(key, bytes));
		return { objects, delimitedPrefixes: [], truncated: false };
	}

	createMultipartUpload(): never {
		throw new Error("FakeR2Bucket: createMultipartUpload() is not implemented");
	}

	resumeMultipartUpload(): never {
		throw new Error("FakeR2Bucket: resumeMultipartUpload() is not implemented");
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
export function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		YAOS_SYNC: makeTrapNamespace(unexpectedNamespace("YAOS_SYNC")),
		YAOS_CONFIG: makeTrapNamespace(unexpectedNamespace("YAOS_CONFIG")),
		...overrides,
	};
}
