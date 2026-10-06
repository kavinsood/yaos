// Node harness for the Worker router (server/src/router.ts) and the vault DO host (server/src/vault/host.ts):
// VaultHost objects on real SQLite behind a fake vault namespace, a config namespace that records every access,
// fake hibernatable sockets, virtual timers and a recording upgrade-reject port. No Cloudflare global is used.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomBase64Url } from "../../../server/src/base64url";
import { ConfigHost } from "../../../server/src/config/host";
import { sha256Hex } from "../../../server/src/hex";
import type { SocketPort, SocketRegistryPort, TimerPort, UpgradeRejectPort } from "../../../server/src/ports";
import { encodeAppendFrame } from "../../../server/src/streams/protocol";
import { DEFAULT_STREAM_RELAY_CONFIG } from "../../../server/src/streams/relay";
import { VaultHost } from "../../../server/src/vault/host";
import type { WorkerEnv } from "../../../server/src/router";
import { CfRowModel } from "./cfRowModel";
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
}

/** The config DO singleton on its own SQLite file, with the row model and the statements it ran. */
export interface ConfigObject {
	readonly storage: NodeSqliteStorage;
	readonly model: CfRowModel;
	readonly statements: string[];
	readonly clock: { now: number };
	readonly host: ConfigHost;
}

/** Every vault DO a test touched, keyed by `idFromName` name, plus a fake `YAOS_VAULT` namespace over them. */
export class VaultCluster {
	readonly objects = new Map<string, VaultObject>();
	/** Each `stub.fetch` the Worker made: object name, method, internal URL. */
	readonly fetches: Array<{ name: string; method: string; url: string }> = [];
	/** Each RPC the Worker made on a vault stub: object name and method. */
	readonly rpcs: Array<{ name: string; method: string }> = [];
	private readonly directory = mkdtempSync(join(tmpdir(), "yaos-worker-"));
	private configObject: ConfigObject | null = null;

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
		this.configObject = { storage, model, statements, clock, host: new ConfigHost(port, { now: () => clock.now }) };
		return this.configObject;
	}

	object(name: string): VaultObject {
		const existing = this.objects.get(name);
		if (existing) return existing;
		const storage = NodeSqliteStorage.open(join(this.directory, `${this.objects.size}.sqlite`));
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
		const make = () => new VaultHost({ storage: port, sockets: registry, upgrades, relayConfig: DEFAULT_STREAM_RELAY_CONFIG,
			clock: { now: () => timers.now }, timers });
		const object: VaultObject = {
			name, storage, model, registry, upgrades, timers, statements, host: make(),
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
		const stub = (name: string) => ({
			fetch: (request: Request) => {
				this.fetches.push({ name, method: request.method, url: request.url });
				return this.object(name).host.fetch(request);
			},
			init: (vaultId: string) => this.rpc(name, "init", () => this.object(name).host.init(vaultId)),
			mintOwnerCode: (purpose: Parameters<VaultHost["mintOwnerCode"]>[0]) =>
				this.rpc(name, "mintOwnerCode", () => this.object(name).host.mintOwnerCode(purpose)),
			listDevices: () => this.rpc(name, "listDevices", () => this.object(name).host.listDevices()),
			revokeDevice: (deviceId: string) => this.rpc(name, "revokeDevice", () => this.object(name).host.revokeDevice(deviceId)),
			deleteVault: () => this.rpc(name, "deleteVault", () => this.object(name).host.deleteVault()),
		});
		const methods: Record<string, unknown> = {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => stub(id.name),
		};
		return new Proxy({}, { get: (_target, property) => methods[String(property)] }) as WorkerEnv["YAOS_VAULT"];
	}

	/** A DO RPC: the result arrives as a promise, and the call is recorded. */
	private async rpc<T>(name: string, method: string, call: () => T | Promise<T>): Promise<T> {
		this.rpcs.push({ name, method });
		return await call();
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
export function recordingConfigNamespace(source: { claimed: boolean } | ConfigHost): {
	namespace: WorkerEnv["YAOS_CONFIG"];
	accesses: string[];
} {
	const accesses: string[] = [];
	const stub = new Proxy({}, {
		get(_target, property) {
			accesses.push(`stub.${String(property)}`);
			if (source instanceof ConfigHost) {
				const method = (source as unknown as Record<string, unknown>)[String(property)];
				return typeof method === "function"
					? async (...args: unknown[]) => await (method as (...a: unknown[]) => unknown).apply(source, args)
					: undefined;
			}
			if (property === "isClaimed") return () => Promise.resolve(source.claimed);
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
