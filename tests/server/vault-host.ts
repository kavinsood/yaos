// Vault DO host (server/src/vault/host.ts) and config DO host (server/src/config/host.ts) on Node SQLite: the §6.1 and
// §6.3 schemas, vault init (D5) and the unknown-vault probe, bearer auth from the in-memory device map, the streams
// accept seam with the D6 constants, the D7 gate seam, and the hibernation wake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigHost, CONFIG_SCHEMA } from "../../server/src/config/host";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../../server/src/shared/socketCloseCodes";
import { encodeAppendFrame } from "../../server/src/streams/protocol";
import { OWNER_CAPABILITY_DIGEST } from "../../server/src/vault/host";
import { suite } from "../harness.ts";
import { NodeSqliteStorage } from "./helpers/nodeSqliteStorage";
import {
	FakeSocket,
	VaultCluster,
	appendCommitted,
	bearer,
	newDevice,
	newVaultId,
	type VaultObject,
} from "./helpers/workerHarness.ts";

const s = suite("vault-host");

const INTERNAL = "https://vault.internal";

async function withCluster(check: (cluster: VaultCluster) => Promise<void> | void): Promise<void> {
	const cluster = new VaultCluster();
	try {
		await check(cluster);
	} finally {
		cluster.close();
	}
}

type Column = { name: string; type: string; notnull: number; pk: number };

/** Tables and indexes of a SQLite file, with each table's columns and WITHOUT ROWID flag. */
function schemaOf(storage: NodeSqliteStorage): Record<string, unknown> {
	const entries = storage.sql.exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
		"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").toArray();
	const result: Record<string, unknown> = {};
	for (const entry of entries) {
		if (entry.type === "index") {
			const columns = storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_index_info('${entry.name}')`).toArray();
			result[entry.name] = { index: entry.tbl_name, columns: columns.map((column) => column.name) };
			continue;
		}
		const columns = storage.sql.exec<Column>(`SELECT name, type, "notnull", pk FROM pragma_table_info('${entry.name}')`)
			.toArray().map((column) => `${column.name} ${column.type}${column.notnull ? " NOT NULL" : ""}`
				+ `${column.pk ? ` PK${column.pk}` : ""}`);
		result[entry.name] = { withoutRowid: /\)\s*WITHOUT ROWID\s*$/i.test(entry.sql ?? ""), columns };
	}
	return result;
}

const STREAM_TABLES = {
	stream_head: { withoutRowid: true, columns: ["stream TEXT NOT NULL PK1", "last_seq INTEGER NOT NULL",
		"ckpt_seq INTEGER NOT NULL", "gc_seq INTEGER NOT NULL", "tail_first INTEGER", "open_rows INTEGER NOT NULL", "open BLOB"] },
	stream_head_last_seq: { index: "stream_head", columns: ["last_seq"] },
	stream_segment: { withoutRowid: true, columns: ["stream TEXT NOT NULL PK1", "first_seq INTEGER NOT NULL PK2",
		"last_seq INTEGER NOT NULL", "rows INTEGER NOT NULL", "bytes BLOB NOT NULL"] },
	stream_checkpoint: { withoutRowid: true, columns: ["stream TEXT NOT NULL PK1", "chunk INTEGER NOT NULL PK2",
		"covers_seq INTEGER NOT NULL", "bytes BLOB NOT NULL"] },
};

/** DECISIONS §6.1, column for column (a WITHOUT ROWID primary key is NOT NULL). */
const VAULT_TABLES = {
	...STREAM_TABLES,
	vault_meta: { withoutRowid: true, columns: ["id INTEGER NOT NULL PK1", "vault_id TEXT NOT NULL",
		"vault_generation TEXT NOT NULL", "ticket_key BLOB NOT NULL", "created_at INTEGER NOT NULL", "pending_restore_id TEXT",
		"last_restore_id TEXT", "last_restore_at INTEGER"] },
	device: { withoutRowid: true, columns: ["token_hash BLOB NOT NULL PK1", "device_id TEXT NOT NULL", "device_name TEXT NOT NULL",
		"enrollment_request_id TEXT NOT NULL", "enrolled_at INTEGER NOT NULL"] },
	pairing_code: { withoutRowid: true, columns: ["code_hash BLOB NOT NULL PK1", "purpose TEXT NOT NULL",
		"expires_at INTEGER NOT NULL", "used_at INTEGER", "used_request_id TEXT", "used_device_id TEXT"] },
};

/** DECISIONS §6.3. */
const CONFIG_TABLES = {
	operator: { withoutRowid: true,
		columns: ["id INTEGER NOT NULL PK1", "key_hash BLOB NOT NULL", "claimed_at INTEGER NOT NULL"] },
	session: { withoutRowid: true, columns: ["token_hash BLOB NOT NULL PK1", "expires_at INTEGER NOT NULL"] },
	vault: { withoutRowid: true, columns: ["vault_id TEXT NOT NULL PK1", "name TEXT NOT NULL", "created_at INTEGER NOT NULL"] },
	restore_journal: { withoutRowid: true, columns: ["vault_id TEXT NOT NULL PK1", "restore_id TEXT NOT NULL",
		"at INTEGER NOT NULL", "bookmark TEXT", "devices BLOB", "created_at INTEGER NOT NULL"] },
};

function feed(object: VaultObject, headers: Record<string, string>): Promise<Response> {
	return object.host.fetch(new Request(`${INTERNAL}/streams/feed`, { headers }));
}

function ping(socket: FakeSocket, object: VaultObject, probeId: string): void {
	object.host.webSocketMessage(socket, `__YPS:${JSON.stringify({ type: "VAULT_PING", probeId })}`);
}

/** The seq of the last receipt sent to `socket` (STREAM_RECEIPTS after a group commit). */
function receiptSeq(socket: FakeSocket): number | undefined {
	const receipts = socket.last("STREAM_RECEIPTS")?.receipts as Array<{ seq: number }> | undefined;
	return receipts?.at(-1)?.seq;
}

function appendBytes(stream: string, clientFrameId: string): ArrayBuffer {
	const frame = encodeAppendFrame({ stream, clientFrameId, payload: new Uint8Array([1]) });
	return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

// ---- init and the unknown-vault probe ----------------------------------------------

s.test("§6.1: init creates exactly the vault schema and one vault_meta row (1 CF row)", async () => {
	await withCluster((cluster) => {
		const vaultId = newVaultId();
		const object = cluster.object(vaultId);
		const result = object.host.init(vaultId);
		assert.equal(result.created, true);
		assert.match(result.vaultGeneration, /^[A-Za-z0-9_-]{22}$/, "D8: base64url(16 bytes)");
		assert.deepEqual(schemaOf(object.storage), VAULT_TABLES);
		assert.equal(object.model.totals.cf, 1, "§6.2 vault init: INSERT meta = 1 CF row");
		type Row = { vault_id: string; vault_generation: string; ticket_key: ArrayBuffer; created_at: number;
			pending_restore_id: string | null };
		const rows = object.storage.sql.exec<Row>("SELECT * FROM vault_meta").toArray();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.vault_id, vaultId);
		assert.equal(rows[0]!.vault_generation, result.vaultGeneration);
		assert.equal(rows[0]!.ticket_key.byteLength, 32, "D4: 32-byte ticket key");
		assert.equal(rows[0]!.created_at, object.timers.now);
		assert.equal(rows[0]!.pending_restore_id, null);
	});
});

s.test("D5: init is idempotent, keeps the generation, and refuses another or malformed vaultId", async () => {
	await withCluster((cluster) => {
		const vaultId = newVaultId();
		const object = cluster.object(vaultId);
		const first = object.host.init(vaultId);
		const written = object.model.totals.cf;
		const again = object.host.init(vaultId);
		assert.deepEqual(again, { vaultId, vaultGeneration: first.vaultGeneration, created: false });
		const afterRestart = object.restart().init(vaultId);
		assert.deepEqual(afterRestart, again, "a new runtime reads the same vault");
		assert.equal(object.model.totals.cf, written, "no write on a repeated init");
		assert.throws(() => object.host.init(newVaultId()), /another vaultId/);
		assert.throws(() => cluster.object("x").host.init("short"), TypeError);
		assert.throws(() => cluster.object("y").host.init(`${vaultId.slice(1)}=`), TypeError);
	});
});

s.test("§6.1: an unknown vault is cached after one probe; it answers 401 / 404 and creates no table", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const object = cluster.object(vaultId);
		const stranger = newDevice("stranger-device-01");
		assert.equal((await feed(object, bearer(stranger))).status, 401);
		assert.equal((await feed(object, {})).status, 401);
		const read = await object.host.fetch(new Request(`${INTERNAL}/streams/read?stream=ns`, { headers: bearer(stranger) }));
		assert.equal(read.status, 401);
		const enroll = await object.host.fetch(new Request(`${INTERNAL}/enroll`, { method: "POST", body: "{}" }));
		assert.equal(enroll.status, 404);
		assert.deepEqual(await enroll.json(), { error: "invalid_code" });
		const socket = await object.host.fetch(
			new Request(`${INTERNAL}/ws/streams?streamsVersion=1`, { headers: { Upgrade: "websocket" } }));
		assert.equal(socket.headers.get("X-Test-Upgrade"), "rejected");
		assert.deepEqual(object.upgrades.rejected.map((entry) => [entry.frame, entry.code]),
			[[{ type: "error", code: "unauthorized" }, 1008]]);
		assert.deepEqual(object.statements,
			["SELECT vault_id, vault_generation, ticket_key, created_at, pending_restore_id, last_restore_id,"
				+ " last_restore_at FROM vault_meta WHERE id = 1"]);
		assert.deepEqual(schemaOf(object.storage), {}, "T-PAIR-NOWRITE: no DDL on a request path");
		assert.equal(object.model.totals.cf, 0);
		assert.equal((await object.host.fetch(new Request(`${INTERNAL}/streams/other`))).status, 404);
		// Init in the same object replaces the cached "unknown".
		object.host.init(vaultId);
		assert.equal((await feed(object, bearer(stranger))).status, 401);
		assert.deepEqual(schemaOf(object.storage), VAULT_TABLES);
	});
});

// ---- bearer auth -----------------------------------------------------------------

s.test("§6.1: bearer auth reads meta 1 + devices N once per runtime, then 0 rows per request", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const laptop = newDevice("laptop-device-0001");
		const object = await cluster.seed(vaultId, [owner, laptop]);
		object.statements.length = 0;
		for (const device of [owner, laptop, owner]) {
			const response = await feed(object, bearer(device));
			assert.equal(response.status, 200);
			const page = await response.json() as { vaultEpoch: string };
			assert.equal(page.vaultEpoch, object.host.load()!.meta.vaultGeneration);
		}
		const reads = object.statements.filter((sql) => /FROM (vault_meta|device)\b/.test(sql));
		assert.deepEqual(reads, [
			"SELECT vault_id, vault_generation, ticket_key, created_at, pending_restore_id, last_restore_id,"
				+ " last_restore_at FROM vault_meta WHERE id = 1",
			"SELECT token_hash, device_id, device_name, enrollment_request_id, enrolled_at FROM device",
		]);
		for (const headers of [bearer(newDevice("stranger-device-01")), { Authorization: `Bearer ${owner.token}x` },
			{ Authorization: owner.token }, { Authorization: "Bearer " }]) {
			const response = await feed(object, headers);
			assert.equal(response.status, 401);
			assert.deepEqual(await response.json(), { error: "unauthorized" });
		}
		const ticket = await object.host.fetch(
			new Request(`${INTERNAL}/auth/ticket`, { method: "POST", headers: bearer(owner), body: "{}" }));
		assert.equal(ticket.status, 400);
		assert.deepEqual(await ticket.json(), { error: "invalid_ticket_scope" }, "D4: the purpose is required");
		const debug = await object.host.fetch(
			new Request(`${INTERNAL}/debug/simulate-daily-limit`, { method: "POST", headers: bearer(owner), body: "{}" }));
		assert.deepEqual([debug.status, await debug.json()], [400, { error: "invalid_request" }],
			"simulate-daily-limit: `enabled` must be a boolean");
		const blobAuth = await object.host.fetch(new Request(`${INTERNAL}/blobs/auth`, { method: "POST", headers: bearer(owner) }));
		assert.equal(blobAuth.status, 204, "D9: the blob bearer check");
		assert.equal(object.model.totals.cf, 1, "bearer requests write nothing (1 = init)");
	});
});

// ---- streams accept seam, D6, D7 gate, hibernation ----------------------------------

s.test("D6: acceptStreams admits an enrolled device with the owner constants", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001", "Owner phone");
		const object = await cluster.seed(vaultId, [owner]);
		const response = object.host.acceptStreams(owner.deviceId);
		assert.equal(response.headers.get("X-Test-Upgrade"), "accepted");
		const socket = object.registry.lastClient!;
		const ready = socket.last("VAULT_READY")!;
		const meta = object.host.load()!.meta;
		assert.equal(ready.vaultId, vaultId);
		assert.equal(ready.vaultGeneration, meta.vaultGeneration);
		assert.equal(ready.vaultEpoch, meta.vaultGeneration);
		assert.equal(ready.runtimeEpoch, object.host.runtimeEpoch);
		assert.equal(ready.deviceId, owner.deviceId);
		assert.deepEqual(
			[ready.role, ready.canWrite, ready.membershipRevision, ready.deviceCredentialRevision, ready.policyVersion],
			["owner", true, 1, 1, 1],
		);
		assert.equal(ready.principalId, `owner:${vaultId}`);
		assert.equal(ready.capabilityDigest, OWNER_CAPABILITY_DIGEST);
		assert.equal(OWNER_CAPABILITY_DIGEST, "97478b5b5cff0be09d2556e1f5b7e08e5a4aa5a9727e768f954c54f55f3b5646");
		assert.equal((socket.attachment as { deviceName?: string }).deviceName, "Owner phone");
		assert.throws(() => object.host.acceptStreams("unknown-device-001"), /unknown vault or device/);
		assert.throws(() => cluster.object(newVaultId()).host.acceptStreams(owner.deviceId), /unknown vault or device/);
	});
});

s.test("D7 seam: removing a device from the map shuts its open socket at the next control or append", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const laptop = newDevice("laptop-device-0001");
		const object = await cluster.seed(vaultId, [owner, laptop]);
		const ownerSocket = appendCommitted(object, owner.deviceId, "ns", "frame-1", new Uint8Array([1]));
		object.host.acceptStreams(laptop.deviceId);
		const laptopSocket = object.registry.lastClient!;
		assert.equal(receiptSeq(ownerSocket), 1);

		object.host.load()!.devices.remove(owner.deviceId);
		object.host.webSocketMessage(ownerSocket, appendBytes("ns", "frame-2"));
		assert.deepEqual(ownerSocket.last("error"),
			{ type: "error", code: "authority_superseded", reason: "socket authority superseded" });
		assert.equal(ownerSocket.closed?.code, AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE);
		assert.equal(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, 4403);
		object.host.relay.flush("forced");
		assert.equal(object.host.relay.head(), 1, "the refused append did not commit");

		ping(laptopSocket, object, "probe-1");
		assert.equal(laptopSocket.last("VAULT_PONG")?.probeId, "probe-1", "other devices keep their sockets");
		assert.equal(laptopSocket.closed, null);
		assert.equal((await feed(object, bearer(owner))).status, 401, "bearer auth uses the same map");
	});
});

s.test("hibernation: a new runtime reloads meta and devices from SQL and tells old sockets to resend", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const laptop = newDevice("laptop-device-0001");
		const object = await cluster.seed(vaultId, [owner, laptop]);
		const socket = appendCommitted(object, owner.deviceId, "ns", "frame-1", new Uint8Array([1]));
		object.host.acceptStreams(laptop.deviceId);
		const laptopSocket = object.registry.lastClient!;
		const before = object.host.runtimeEpoch;

		const woken = object.restart();
		assert.notEqual(woken.runtimeEpoch, before);
		object.statements.length = 0;
		ping(socket, object, "probe-after-wake");
		const resend = socket.last("STREAM_RESEND")!;
		assert.deepEqual(resend, { type: "STREAM_RESEND", reason: "runtime_restarted", runtimeEpoch: woken.runtimeEpoch, head: 1 });
		assert.equal(laptopSocket.last("STREAM_RESEND")?.runtimeEpoch, woken.runtimeEpoch, "every old socket is told once");
		assert.equal(socket.last("VAULT_PONG")?.probeId, "probe-after-wake");
		assert.equal((socket.attachment as { runtimeEpoch: string }).runtimeEpoch, woken.runtimeEpoch);
		assert.ok(object.statements.some((sql) => /FROM device$/.test(sql)), "devices reloaded from SQL");
		ping(socket, object, "probe-2");
		assert.equal(socket.controls.filter((control) => control.type === "STREAM_RESEND").length, 1, "once per runtime");

		// A device row deleted while hibernated is not admitted by the next runtime.
		object.storage.sql.exec("DELETE FROM device WHERE device_id = ?", laptop.deviceId);
		object.restart();
		object.host.webSocketMessage(laptopSocket, appendBytes("ns", "frame-3"));
		assert.equal(laptopSocket.closed?.code, 4403);
		object.host.webSocketMessage(socket, appendBytes("ns", "frame-4"));
		object.host.relay.flush("forced");
		assert.equal(receiptSeq(socket), 2);
	});
});

s.test("socket error closes 1011 and forgets the socket; a non-streams socket is closed 1008", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const object = await cluster.seed(vaultId, [owner]);
		object.host.acceptStreams(owner.deviceId);
		const socket = object.registry.lastClient!;
		object.host.webSocketError(socket);
		assert.deepEqual(socket.closed, { code: 1011, reason: "socket error" });
		const stray = new FakeSocket();
		object.host.webSocketMessage(stray, "__YPS:{}");
		assert.equal(stray.closed?.code, 1008);
	});
});

// ---- config DO ---------------------------------------------------------------------

s.test("§6.3: the config singleton creates its schema once; claimed = the operator row, then cached", () => {
	const directory = mkdtempSync(join(tmpdir(), "yaos-config-"));
	const storage = NodeSqliteStorage.open(join(directory, "config.sqlite"));
	try {
		const statements: string[] = [];
		const port = {
			sql: {
				exec: (query: string, ...bindings: unknown[]) => {
					statements.push(query);
					return storage.sql.exec(query, ...bindings) as never;
				},
			},
			transactionSync: <T>(closure: () => T): T => storage.transactionSync(closure),
		};
		const host = new ConfigHost(port);
		assert.deepEqual(schemaOf(storage), CONFIG_TABLES);
		assert.equal(statements.filter((sql) => sql === CONFIG_SCHEMA).length, 1);
		assert.equal(host.isClaimed(), false);
		assert.equal(new ConfigHost(port).isClaimed(), false);
		assert.equal(statements.filter((sql) => sql === CONFIG_SCHEMA).length, 1, "the DDL runs once per object");
		storage.sql.exec("INSERT INTO operator (id, key_hash, claimed_at) VALUES (1, ?, ?)", new Uint8Array(32), 1);
		assert.equal(host.isClaimed(), true, "an unclaimed host re-reads");
		const reads = statements.length;
		storage.sql.exec("DELETE FROM operator");
		assert.equal(host.isClaimed(), true, "claimed stays true");
		assert.equal(statements.length, reads, "no read once claimed");
	} finally {
		storage.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

await s.done();
