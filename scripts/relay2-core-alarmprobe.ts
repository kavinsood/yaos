/**
 * Relay v2 server-core probe (round 4): cost of the relay alarm pieces and rows
 * written per append on real SQLite (node:sqlite). Usage:
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2-core-alarmprobe.ts [appends] [bodyKiB]
 * Env YAOS_RELAY_LEAN_ROWS=true measures the lean append.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../packages/server-node/src/storage";
import { RelayBodyService, type RelaySocketHost } from "../server/src/relayBodies";
import { RelayBodyStore } from "../server/src/relayBodyStore";
import { readRelayConfig } from "../server/src/relayFlag";
import type { VaultDocumentCache } from "../server/src/vaultDocumentCache";
import type { VaultSocketAttachment, VaultSocketPort } from "../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../server/src/vaultStore";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const appends = Number(process.argv[2] ?? 750);
const bodyKiB = Number(process.argv[3] ?? 30);
const owner = { vaultId: "probe-vault", vaultGeneration: "probe-generation", principalId: "p", membershipRevision: 1,
	deviceId: "d", deviceCredentialRevision: 1, role: "owner" as const, policyVersion: 1, capabilityDigest: "c" };
const directory = await mkdtemp(join(tmpdir(), "yaos-relay2-alarmprobe-"));
const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
let written = 0;
const storage = {
	sql: { exec: (query: string, ...bindings: unknown[]) => {
		const cursor = sqlite.sql.exec(query, ...bindings);
		return new Proxy(cursor, { get(target, key) {
			const value = Reflect.get(target, key);
			if (key === "toArray" || key === "one") return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				written += target.rowsWritten; return result;
			};
			return typeof value === "function" ? value.bind(target) : value;
		} });
	} },
	transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
} as unknown as VaultStoragePort;
const store = new VaultStore(storage);
const root = new Y.Doc();
root.getMap("sys").set("schemaVersion", 8);
root.getMap("sys").set("protocolVersion", 5);
store.provisionVault(owner.vaultId, owner.vaultGeneration, Y.encodeStateAsUpdate(root), 1);
if (readRelayConfig(null).leanRows) store.enableLeanRows();
store.installAuthorityFence({ changeId: "probe", vaultId: owner.vaultId, vaultGeneration: owner.vaultGeneration, subjectDigest: "probe",
	subjects: [{ principalId: "p", role: "owner", state: "active", membershipRevision: 1, policyVersion: 1, capabilityDigest: "c",
		displayName: "O", colorSeed: "o" }, { deviceId: "d", principalId: "p", state: "active", credentialRevision: 1 }] });
const doc = new Y.Doc({ guid: "body" });
const text = doc.getText("body");
const updates: Uint8Array[] = [];
doc.on("update", (u: Uint8Array) => updates.push(u));
text.insert(0, "lorem ipsum dolor sit amet ".repeat(Math.ceil((bodyKiB * 1024) / 27)));
store.commitUpdate({ documentId: "body", kind: "body", update: updates[0]!, catalog: [{ bodyId: "body", fileId: "body", path: "a.md",
	previousPath: null, lifecycle: "active", bodyGeneration: 1, contentHash: null, size: null }] });
const relayStore = new RelayBodyStore(storage, store);
const relay = new RelayBodyService({ config: { ...readRelayConfig(null), rateBytesPerSec: 1 << 30 }, store: () => store,
	relayStore: () => relayStore, cache: { get: () => undefined } as unknown as VaultDocumentCache, runtimeEpoch: "r",
	armCheckpointAlarm: () => {} });
const host: RelaySocketHost = { sockets: () => [], sendControl: () => {}, fenceRelaySocket: () => {},
	broadcastRelayUpdate: () => {}, notifyBodyCommitted: () => {} };
relay.bindHost(host);
const attachment = { ...owner, runtimeEpoch: "r", documentId: "body", kind: "body", documentEpoch: store.documentHead("body")!.semanticEpoch,
	socketId: "s1", relay: true } as unknown as VaultSocketAttachment;
const socket = { send() {}, close() {}, deserializeAttachment: () => attachment, serializeAttachment() {} } as unknown as VaultSocketPort;
const frameOf = (update: Uint8Array) => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0); encoding.writeVarUint(encoder, 2); encoding.writeVarUint8Array(encoder, update);
	const decoder = decoding.createDecoder(encoding.toUint8Array(encoder)); decoding.readVarUint(decoder); return decoder;
};
const t = { append: 0, candidates: 0, checkpoint: 0, floor: 0, coalesce: 0, passes: 0 };
let coalesceRows = 0;
let appendRows = 0, checkpointRows = 0, floorRows = 0;
for (let index = 0; index < appends; index++) {
	text.insert(Math.floor(text.length / 2), "x");
	written = 0;
	let t0 = performance.now();
	relay.handleSyncFrame(socket, attachment, frameOf(updates.at(-1)!));
	t.append += performance.now() - t0;
	appendRows += written;
	if ((index + 1) % 50 === 0) {
		t0 = performance.now();
		store.listJournalCheckpointCandidates(50, 1 << 20, 25);
		t.candidates += performance.now() - t0;
		written = 0; t0 = performance.now();
		relayStore.coalesceLeanCatalog();
		t.coalesce += performance.now() - t0; coalesceRows += written;
		written = 0; t0 = performance.now();
		relay.checkpointBody("body");
		t.checkpoint += performance.now() - t0; checkpointRows += written;
		written = 0; t0 = performance.now();
		const floor = Math.max(0, store.currentSequence() - 1000);
		if (floor > store.journalFloor()) store.advanceFeedFloor(floor);
		t.floor += performance.now() - t0; floorRows += written;
		t.passes++;
	}
}
const r = (x: number) => +x.toFixed(3);
console.log(JSON.stringify({ lean: process.env.YAOS_RELAY_LEAN_ROWS === "true", appends, bodyKiB, passes: t.passes,
	msPerAppend: r(t.append / appends), rowsWrittenPerAppend: r(appendRows / appends),
	appendCounterRowsPerAppend: r(relay.counters.rowsWritten / appends),
	msPerPass: { candidates: r(t.candidates / t.passes), checkpoint: r(t.checkpoint / t.passes), floor: r(t.floor / t.passes), coalesce: r(t.coalesce / t.passes) },
	coalesceRowsPerPass: r(coalesceRows / t.passes),
	checkpointRowsPerPass: r(checkpointRows / t.passes), floorRowsTotal: floorRows, amortisedRowsPerAppend: r((appendRows + checkpointRows + floorRows + coalesceRows) / appends) }));
sqlite.close();
await rm(directory, { recursive: true, force: true });
