// Node harness for the Worker router (server/src/router.ts) and the vault DO host (server/src/vault/host.ts):
// VaultHost objects on real SQLite behind a fake vault namespace, a config namespace that records every access,
// fake hibernatable sockets, virtual timers, a recording upgrade-reject port, an in-memory R2 bucket, the config DO's
// D8b restore ports (a fake alarm and a vault port with crash hooks) and, on request, a fake PITR per vault object.
// No Cloudflare global is used.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomBase64Url } from "../../../server/src/base64url";
import { ConfigHost } from "../../../server/src/config/host";
import type { RestoreAlarmPort, RestorePorts, RestoreVaultPort } from "../../../server/src/config/restore";
import { sha256Hex } from "../../../server/src/hex";
import type { SocketPort, SocketRegistryPort, TimerPort, UpgradeRejectPort } from "../../../server/src/ports";
import { encodeAppendFrame } from "../../../server/src/streams/protocol";
import { DEFAULT_STREAM_RELAY_CONFIG } from "../../../server/src/streams/relay";
import type { DeviceRecord } from "../../../server/src/vault/devices";
import { VaultHost } from "../../../server/src/vault/host";
import type { WorkerEnv } from "../../../server/src/router";
import { CfRowModel } from "./cfRowModel";
import { FakePitr } from "./fakePitr";
import { NodeSqliteStorage } from "./nodeSqliteStorage";

export type Control = Record<string, unknown> & { type: string };

export class FakeSocket implements SocketPort {
	readonly binary: Uint8Array[] = [];
	readonly controls: Control[] = [];
	closed: { code?: number; reason?: string } | null = null;
	attachment: unknown = null;
	close(code?: number, reason?: string): void { this.closed ??= { code, reason }; }
	deserializeAttachment(): unknown { return this.attachment; }
	serializeAttachment(value: unknown): void { this.attachment = structuredClone(value); }
	send(message: ArrayBuffer | ArrayBufferView | string): void {
		if (this.closed) throw new Error("socket closed");
		if (typeof message === "string") {
			if (!message.startsWith("__YPS:")) throw new Error("control frames carry the __YPS: prefix");
			this.controls.push(JSON.parse(message.slice(6)) as Control);
		} else {
			const view = message instanceof ArrayBuffer ? new Uint8Array(message)
				: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
			this.binary.push(view.slice());
		}
	}
	last(type: string): Control | undefined { return this.controls.filter((value) => value.type === type).at(-1); }
}

/** The DO's socket set. Node's Response cannot carry status 101, so the "upgrade" answers 200 and keeps the client. */
export class FakeRegistry implements SocketRegistryPort {
	readonly list: FakeSocket[] = [];
	lastClient: FakeSocket | null = null;
	sockets(): readonly SocketPort[] { return this.list.filter((socket) => !socket.closed); }
	createPair() { const server = new FakeSocket(); return { client: server, server }; }
	accept(socket: SocketPort): void { this.list.push(socket as FakeSocket); }
	upgradeResponse(client: unknown): Response {
		this.lastClient = client as FakeSocket;
		return new Response(null, { status: 200, headers: { "X-Test-Upgrade": "accepted" } });
	}
}

/** Records each refused upgrade; answers 200 with a marker header (no 101 on Node). */
export class RecordingUpgrades implements UpgradeRejectPort {
	readonly rejected: Array<{ frame: Control; code: number; reason: string }> = [];
	reject(frame: string, code: number, reason: string): Response {
		this.rejected.push({ frame: JSON.parse(frame.slice("__YPS:".length)) as Control, code, reason });
		return new Response(null, { status: 200, headers: { "X-Test-Upgrade": "rejected" } });
	}
}

/** Timers that fire only when the test advances them. */
export class ManualTimers implements TimerPort {
	now = 1_700_000_000_000;
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	set(callback: () => void, ms: number): unknown {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + ms, callback });
		return id;
	}
	clear(handle: unknown): void { this.timers.delete(handle as number); }
	/** Moves the clock forward by `ms`, firing every timer that falls due, in time order. */
	advance(ms: number): void {
		const until = this.now + ms;
		for (;;) {
			let next: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of this.timers) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
			if (!next) break;
			this.timers.delete(next[0]);
			this.now = Math.max(this.now, next[1].at);
			next[1].callback();
		}
		this.now = until;
	}
}

export interface DeviceSeed {
	deviceId: string;
	deviceName: string;
	/** The bearer secret; tests never print it. */
	token: string;
}

export function newDevice(deviceId: string, deviceName = `${deviceId} name`): DeviceSeed {
	return { deviceId, deviceName, token: randomBase64Url(32) };
}

export function newVaultId(): string {
	return randomBase64Url(16);
}

/** One vault DO: its SQLite file, the row model over it, its sockets and the current runtime's host. */
export interface VaultObject {
	readonly name: string;
	readonly storage: NodeSqliteStorage;
	readonly model: CfRowModel;
	readonly registry: FakeRegistry;
	readonly upgrades: RecordingUpgrades;
	readonly timers: ManualTimers;
	host: VaultHost;
	/** A new runtime over the same storage and sockets (hibernation wake or eviction). */
	restart(): VaultHost;
	/** SQL statements run against this object, in order. */
	readonly statements: string[];
	/** Top-level `transactionSync` calls on this object. */
	readonly transactions: { count: number };
	/** The object's PITR when the cluster was made with `{ pitr: true }`. */
	readonly pitr: FakePitr | null;
}

/** The config DO's storage alarm: one scheduled time (or none) and every `setAlarm`. */
export class FakeAlarms implements RestoreAlarmPort {
	scheduled: number | null = null;
	readonly history: number[] = [];
	getAlarm(): Promise<number | null> { return Promise.resolve(this.scheduled); }
	setAlarm(scheduledTime: number): Promise<void> {
		this.scheduled = scheduledTime;
		this.history.push(scheduledTime);
		return Promise.resolve();
	}
}

/** The config DO singleton on its own SQLite file, with the row model and the statements it ran. */
export interface ConfigObject {
	readonly storage: NodeSqliteStorage;
	readonly model: CfRowModel;
	readonly statements: string[];
	readonly clock: { now: number };
	readonly alarms: FakeAlarms;
	host: ConfigHost;
	/** A new config runtime over the same storage and alarm (eviction or a crash: in-memory runs are lost). */
	restart(): ConfigHost;
	/** Runs the alarm handler as Cloudflare does: the alarm is consumed, then `alarm()` runs. */
	fireAlarm(): Promise<void>;
}

/** D8b crash injection: called before and after each vault RPC of the restore runner; a never-settling promise is a crash. */
export type RestoreHook = (step: keyof RestoreVaultPort, phase: "before" | "after", vaultId: string) => void | Promise<void>;

/** A promise that never settles: the caller's run stops here for good, as when its isolate dies. */
export function crash(): Promise<never> {
	return new Promise<never>(() => {});
}

/** Every vault DO a test touched, keyed by `idFromName` name, plus a fake `YAOS_VAULT` namespace over them. */
export class VaultCluster {
	readonly objects = new Map<string, VaultObject>();
	/** Each `stub.fetch` the Worker made: object name, method, internal URL. */
	readonly fetches: Array<{ name: string; method: string; url: string }> = [];
	/** Each RPC the Worker made on a vault stub: object name and method. */
	readonly rpcs: Array<{ name: string; method: string }> = [];
	/** D8b: consulted around each restore-runner vault RPC (crash injection, writes in the window). */
	restoreHook: RestoreHook | null = null;
	private readonly directory = mkdtempSync(join(tmpdir(), "yaos-worker-"));
	private configObject: ConfigObject | null = null;
	private readonly withPitr: boolean;

	constructor(options: { pitr?: boolean } = {}) {
		this.withPitr = options.pitr === true;
	}

	/** The config DO (one per cluster), on the clock `now` of the returned object. */
	config(): ConfigObject {
		if (this.configObject) return this.configObject;
		const storage = NodeSqliteStorage.open(join(this.directory, "config.sqlite"));
		const model = new CfRowModel(storage);
		const statements: string[] = [];
		const port = {
			sql: {
				exec: (query: string, ...bindings: unknown[]) => {
					statements.push(query);
					return model.exec(query, ...bindings) as never;
				},
			},
			transactionSync: <T>(closure: () => T): T => storage.transactionSync(closure),
		};
		const clock = { now: 1_700_000_000_000 };
		const alarms = new FakeAlarms();
		const ports: RestorePorts = { vault: (vaultId) => this.restorePort(vaultId), alarms };
		const make = () => new ConfigHost(port, { now: () => clock.now }, ports);
		const object: ConfigObject = {
			storage, model, statements, clock, alarms, host: make(),
			restart() { object.host = make(); return object.host; },
			async fireAlarm() {
				alarms.scheduled = null;
				await object.host.alarm();
			},
		};
		this.configObject = object;
		return object;
	}

	/** The runner's vault port: a fresh namespace stub per call (as config.ts does), with the restore hook around it. */
	private restorePort(vaultId: string): RestoreVaultPort {
		const stub = () => this.stub(vaultId);
		const hooked = async <T>(step: keyof RestoreVaultPort, call: () => Promise<T>): Promise<T> => {
			await this.restoreHook?.(step, "before", vaultId);
			let outcome: { ok: true; value: T } | { ok: false; error: unknown };
			try {
				outcome = { ok: true, value: await call() };
			} catch (error) {
				outcome = { ok: false, error };
			}
			await this.restoreHook?.(step, "after", vaultId);
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		};
		return {
			prepareRestore: (restoreId, at, refreshOnly) =>
				hooked("prepareRestore", () => stub().prepareRestore(restoreId, at, refreshOnly)),
			rewind: (restoreId, bookmark) => hooked("rewind", () => stub().rewind(restoreId, bookmark)),
			finishRestore: (restoreId, devices) => hooked("finishRestore", () => stub().finishRestore(restoreId, devices)),
		};
	}

	object(name: string): VaultObject {
		const existing = this.objects.get(name);
		if (existing) return existing;
		const storage = NodeSqliteStorage.open(join(this.directory, `${this.objects.size}.sqlite`));
		const model = new CfRowModel(storage);
		const statements: string[] = [];
		const transactions = { count: 0 };
		let depth = 0;
		const port = {
			sql: {
				exec: (query: string, ...bindings: unknown[]) => {
					statements.push(query);
					return model.exec(query, ...bindings) as never;
				},
			},
			transactionSync: <T>(closure: () => T): T => {
				if (depth === 0) transactions.count++;
				depth++;
				try {
					return storage.transactionSync(closure);
				} finally {
					depth--;
				}
			},
			// Durable Object deleteAll(): every table goes (DDL is not billed by the row model).
			deleteAll: (): Promise<void> => {
				storage.transactionSync(() => {
					const tables = storage.sql.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray();
					for (const { name: table } of tables) storage.sql.exec(`DROP TABLE "${table}"`);
				});
				return Promise.resolve();
			},
		};
		const registry = new FakeRegistry();
		const upgrades = new RecordingUpgrades();
		const timers = new ManualTimers();
		// ctx.abort(): every socket of the object drops, and the next request runs a new runtime.
		const pitr = this.withPitr ? new FakePitr(storage, () => {
			for (const socket of registry.list) socket.close(1006, "durable object reset");
			model.forgetSchema();
			object.restart();
		}) : null;
		const make = () => new VaultHost({ storage: port, sockets: registry, upgrades, relayConfig: DEFAULT_STREAM_RELAY_CONFIG,
			clock: { now: () => timers.now }, timers, ...(pitr ? { pitr } : {}) });
		const object: VaultObject = {
			name, storage, model, registry, upgrades, timers, statements, transactions, pitr, host: make(),
			restart() { object.host = make(); return object.host; },
		};
		this.objects.set(name, object);
		return object;
	}

	/** Initializes the vault, inserts the devices as P2 enroll will, then restarts so the host reloads from SQL. */
	async seed(vaultId: string, devices: DeviceSeed[] = []): Promise<VaultObject> {
		const object = this.object(vaultId);
		object.host.init(vaultId);
		for (const device of devices) {
			const hash = Buffer.from(await sha256Hex(new TextEncoder().encode(device.token)), "hex");
			object.storage.sql.exec("INSERT INTO device (token_hash, device_id, device_name, enrollment_request_id, enrolled_at)"
				+ " VALUES (?, ?, ?, ?, ?)", hash, device.deviceId, device.deviceName, `req-${device.deviceId}`, object.timers.now);
		}
		object.restart();
		return object;
	}

	namespace(): WorkerEnv["YAOS_VAULT"] {
		const methods: Record<string, unknown> = {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => this.stub(id.name),
		};
		return new Proxy({}, { get: (_target, property) => methods[String(property)] }) as WorkerEnv["YAOS_VAULT"];
	}

	/** One vault stub: `fetch` and every RPC of vault.ts, each on the object's current runtime. */
	private stub(name: string) {
		const host = () => this.object(name).host;
		return {
			fetch: (request: Request) => {
				this.fetches.push({ name, method: request.method, url: request.url });
				return host().fetch(request);
			},
			init: (vaultId: string) => this.rpc(name, "init", () => host().init(vaultId)),
			mintOwnerCode: (purpose: Parameters<VaultHost["mintOwnerCode"]>[0]) =>
				this.rpc(name, "mintOwnerCode", () => host().mintOwnerCode(purpose)),
			listDevices: () => this.rpc(name, "listDevices", () => host().listDevices()),
			revokeDevice: (deviceId: string) => this.rpc(name, "revokeDevice", () => host().revokeDevice(deviceId)),
			deleteVault: () => this.rpc(name, "deleteVault", () => host().deleteVault()),
			resetStreams: () => this.rpc(name, "resetStreams", () => host().resetStreams()),
			prepareRestore: (restoreId: string, at: number, refreshOnly: boolean) =>
				this.rpc(name, "prepareRestore", () => host().prepareRestore(restoreId, at, refreshOnly)),
			rewind: (restoreId: string, bookmark: string) => this.rpc(name, "rewind", () => host().rewind(restoreId, bookmark)),
			finishRestore: (restoreId: string, devices: DeviceRecord[]) =>
				// RPC arguments are structured-cloned.
				this.rpc(name, "finishRestore", () => host().finishRestore(restoreId, structuredClone(devices))),
		};
	}

	/** A DO RPC: the result arrives as a promise (structured-cloned, as RPC results are), and the call is recorded. */
	private async rpc<T>(name: string, method: string, call: () => T | Promise<T>): Promise<T> {
		this.rpcs.push({ name, method });
		return structuredClone(await call());
	}

	close(): void {
		for (const object of this.objects.values()) object.storage.close();
		this.configObject?.storage.close();
		rmSync(this.directory, { recursive: true, force: true });
	}
}

/**
 * A `YAOS_CONFIG` namespace that records every property access on the namespace and every RPC on its stub. T-HOTPATH
 * asserts both stay empty on device paths.
 */
export function recordingConfigNamespace(source: { claimed: boolean } | ConfigHost | ConfigObject): {
	namespace: WorkerEnv["YAOS_CONFIG"];
	accesses: string[];
} {
	const accesses: string[] = [];
	const stub = new Proxy({}, {
		get(_target, property) {
			accesses.push(`stub.${String(property)}`);
			// A ConfigObject is read per call, so a restarted config runtime takes over.
			const host = source instanceof ConfigHost ? source : "host" in source ? source.host : null;
			if (host) {
				const method = (host as unknown as Record<string, unknown>)[String(property)];
				return typeof method === "function"
					? async (...args: unknown[]) => structuredClone(await (method as (...a: unknown[]) => unknown).apply(host, args))
					: undefined;
			}
			if (property === "isClaimed") return () => Promise.resolve((source as { claimed: boolean }).claimed);
			return undefined;
		},
	});
	const namespace = new Proxy({}, {
		get(_target, property) {
			accesses.push(`namespace.${String(property)}`);
			if (property === "idFromName") return (name: string) => ({ name });
			if (property === "get") return () => stub;
			return undefined;
		},
	});
	return { namespace: namespace as WorkerEnv["YAOS_CONFIG"], accesses };
}

/** Appends one frame through the host's socket path and forces the group commit (seq is assigned in the commit). */
export function appendCommitted(object: VaultObject, deviceId: string, stream: string, clientFrameId: string,
	payload: Uint8Array): FakeSocket {
	const response = object.host.acceptStreams(deviceId);
	if (response.status !== 200) throw new Error(`acceptStreams answered ${response.status}`);
	const socket = object.registry.lastClient!;
	object.registry.lastClient = null;
	const frame = encodeAppendFrame({ stream, clientFrameId, payload });
	object.host.webSocketMessage(socket, frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
	object.host.relay.flush("forced");
	return socket;
}

export function bearer(device: DeviceSeed): Record<string, string> {
	return { Authorization: `Bearer ${device.token}` };
}

/**
 * R2 as the Worker uses it (D9 blobs and the D5 purge): `put` (bytes or a stream), `get`, `head`, `list({prefix,
 * limit})` and `delete(keys)`, in memory. `stuck` keeps every listing truncated. `calls` records each operation.
 */
/**
 * An in-memory R2 bucket with the calls the Worker makes: blob put/get/head (D9) and the D5 purge's list/delete.
 * `calls` records each call in order (a put says whether its value was a stream); `stuck` keeps every listing truncated.
 */
export class FakeBucket {
	readonly objects = new Map<string, Uint8Array>();
	readonly calls: string[] = [];
	stuck = false;
	lists = 0;
	async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string): Promise<{ key: string }> {
		this.calls.push(`put ${key} ${value instanceof ReadableStream ? "stream" : "bytes"}`);
		const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
		this.objects.set(key, bytes);
		return { key };
	}
	get(key: string): Promise<{ key: string; body: ReadableStream } | null> {
		this.calls.push(`get ${key}`);
		const bytes = this.objects.get(key);
		return Promise.resolve(bytes ? { key, body: new Blob([bytes.slice()]).stream() } : null);
	}
	head(key: string): Promise<{ key: string } | null> {
		this.calls.push(`head ${key}`);
		return Promise.resolve(this.objects.has(key) ? { key } : null);
	}
	list(options: { prefix?: string; limit?: number }) {
		this.lists++;
		this.calls.push(`list ${options.prefix ?? ""}`);
		const matching = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
		const objects = matching.slice(0, options.limit ?? 1000).map((key) => ({ key }));
		return Promise.resolve({ objects, truncated: this.stuck || matching.length > objects.length });
	}
	delete(keys: string | string[]): Promise<void> {
		const list = typeof keys === "string" ? [keys] : keys;
		this.calls.push(`delete ${list.length}`);
		for (const key of list) this.objects.delete(key);
		return Promise.resolve();
	}
	asR2(): R2Bucket {
		return this as unknown as R2Bucket;
	}
}
