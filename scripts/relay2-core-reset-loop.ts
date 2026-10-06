/**
 * Relay v2 server-core: local repeated semantic-reset loop (round 2, item 4)
 * and 10 MB checkpoint-merge memory sanity check (item 8).
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2-core-reset-loop.ts [--mb 5] [--n 8] [--json-body]
 *   ... scripts/relay2-core-reset-loop.ts --bloated <fixture.update>   (byte ops on a bloated state only)
 * Real SQLite (NodeSqliteStorage) + VaultStore + RelayBodyService + the real
 * reset route handler. Per iteration: HTTP-equivalent body read, lease, route
 * reset (binary body), post-reset step1-equivalent read. Records ms per phase,
 * ywasm linear memory, JS heap and row counts.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { NodeSqliteStorage } from "../tests/server/helpers/nodeSqliteStorage";
import { bytesToBase64 } from "../server/src/base64url";
import { diffUpdate, mergeUpdates, stateVectorFromUpdate, ywasmLinearMemoryBytes } from "../server/src/crdt/ywasmByteOps";
import { RelayBodyService } from "../server/src/relayBodies";
import { RelayBodyStore } from "../server/src/relayBodyStore";
import { DEFAULT_RELAY_CONFIG } from "../server/src/relayFlag";
import { handleSemanticReset } from "../server/src/relayRoutes";
import { canonicalMarkdownBytes } from "../server/src/shared/markdownCodec";
import { sha256HexSync } from "../server/src/vaultDocumentStore";
import type { VaultDocumentCache } from "../server/src/vaultDocumentCache";
import { VaultStore, type VaultStoragePort } from "../server/src/vaultStore";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? Number(args[index + 1]) : fallback;
};
const MB = flag("mb", 5);
const N = flag("n", 8);
const JSON_MODE = args.includes("--json-body");
const bloatedIndex = args.indexOf("--bloated");
const BLOATED = bloatedIndex >= 0 ? args[bloatedIndex + 1]! : null;
const VAULT_ID = "relay2-loop-vault";
const VAULT_GENERATION = "relay2-loop-generation";
const BODY = "relay2-loop-body";
const owner = { vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION, principalId: "principal-owner",
	membershipRevision: 1, deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner" as const,
	policyVersion: 1, capabilityDigest: "owner-digest" };

const mib = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10;
const time = <T>(fn: () => T): [T, number] => { const at = performance.now(); const value = fn(); return [value, Math.round(performance.now() - at)]; };
const timeAsync = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
	const at = performance.now(); const value = await fn(); return [value, Math.round(performance.now() - at)];
};

function contentOf(bytes: number): string {
	const line = "- relay v2 reset loop line with some markdown **bold** and `code` 0123456789\n";
	return "# loop\n\n" + line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

if (BLOATED) {
	// Item 8: a bloated body (e.g. the reset agent's sized-5m fixture, 8.7 MB / 246k structs)
	// through the relay byte ops only: SV, checkpoint+tail merge, step2 diffs. No document.
	const state = new Uint8Array(readFileSync(BLOATED));
	const edits = new Y.Doc();
	Y.applyUpdate(edits, state);
	const textName = [...edits.share.keys()][0]!;
	const tail: Uint8Array[] = [];
	for (let edit = 0; edit < 50; edit++) {
		const before = Y.encodeStateVector(edits);
		const text = edits.getText(textName);
		text.insert((edit * 7919) % Math.max(1, text.length), "relay ");
		tail.push(Y.encodeStateAsUpdate(edits, before));
	}
	const oldSv = Y.encodeStateVector(edits);
	edits.destroy();
	const out: Record<string, unknown> = { file: BLOATED, stateBytes: state.byteLength, ywasmStartMiB: mib(ywasmLinearMemoryBytes()) };
	const [sv, svMs] = time(() => stateVectorFromUpdate(state));
	const [merged, mergeMs] = time(() => mergeUpdates([state, ...tail]));
	const [full, fullDiffMs] = time(() => diffUpdate(merged, Uint8Array.of(0)));
	const [delta, deltaMs] = time(() => diffUpdate(merged, sv));
	const [again, remergeMs] = time(() => mergeUpdates([merged, ...tail]));
	Object.assign(out, { svMs, mergeMs, mergedBytes: merged.byteLength, fullDiffMs, fullDiffBytes: full.byteLength,
		deltaMs, deltaBytes: delta.byteLength, remergeMs, remergeBytes: again.byteLength, oldSvBytes: oldSv.byteLength,
		ywasmPeakMiB: mib(ywasmLinearMemoryBytes()), capMiB: 96 });
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), "yaos-relay2-loop-"));
const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
const storage = {
	sql: { exec: (query: string, ...bindings: unknown[]) => sqlite.sql.exec(query, ...bindings) },
	transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
} as unknown as VaultStoragePort;
const result: Record<string, unknown> = { mb: MB, n: N, body: JSON_MODE ? "json-base64" : "octet-stream" };
try {
	const store = new VaultStore(storage);
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", 8);
	root.getMap("sys").set("protocolVersion", 5);
	store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
	root.destroy();
	store.installAuthorityFence({ changeId: "loop", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
		subjectDigest: "loop-digest", subjects: [
			{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
				policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
			{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
		] });
	const content = contentOf(MB * 1024 * 1024);
	const hash = (text: string) => { const bytes = canonicalMarkdownBytes(text); return { hash: sha256HexSync(bytes), size: bytes.byteLength }; };
	// Seed: first chunk through the base commit (creates the catalog row), the rest as relay appends.
	const seed = new Y.Doc({ guid: BODY });
	const text = seed.getText("body");
	const CHUNK = 900_000;
	const chunk = (from: number) => {
		const before = Y.encodeStateVector(seed);
		text.insert(text.length, content.slice(from, from + CHUNK));
		return Y.encodeStateAsUpdate(seed, before);
	};
	const first = hash(content.slice(0, CHUNK));
	store.commitUpdate({ documentId: BODY, kind: "body", update: chunk(0),
		catalog: [{ bodyId: BODY, fileId: BODY, path: "loop.md", previousPath: null, lifecycle: "active",
			bodyGeneration: 1, contentHash: first.hash, size: first.size }] });
	const relayStore = new RelayBodyStore(storage, store);
	for (let from = CHUNK; from < content.length; from += CHUNK) {
		relayStore.appendRelayBodyUpdate({ bodyId: BODY, expectedEpoch: store.documentHead(BODY)!.semanticEpoch,
			update: chunk(from), attributions: [{ actor: owner }], catalogContent: null, receipts: [] });
	}
	seed.destroy();
	const relay = new RelayBodyService({
		config: { ...DEFAULT_RELAY_CONFIG, resetCooldownMs: 0 },
		store: () => store, relayStore: () => relayStore,
		cache: { get: () => undefined } as unknown as VaultDocumentCache,
		runtimeEpoch: "runtime-loop", armCheckpointAlarm: () => {},
	});
	const deps = { relay, relayStore: () => relayStore, isActiveBody: () => true, discardResident: () => {},
		fenceSockets: () => 0 };
	const full = hash(content);
	const iterations: Array<Record<string, unknown>> = [];
	for (let i = 0; i < N; i++) {
		const [state, readMs] = time(() => relay.bodyHttpState(BODY)!);
		const head = store.documentHead(BODY)!;
		const [lease, leaseMs] = time(() => relay.acquireLease(BODY, owner, head.semanticEpoch, 120_000));
		if (!lease.granted) throw new Error(`lease ${JSON.stringify(lease)}`);
		// Client-side fresh lineage (not timed as server work).
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, content);
		const snapshot = Y.encodeStateAsUpdate(fresh);
		fresh.destroy();
		const meta = { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch, coveredSequence: head.latestSequence,
			contentHash: full.hash, contentBytes: full.size };
		const request = JSON_MODE
			? new Request("http://local/semantic-reset", { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...meta, snapshot: bytesToBase64(snapshot) }) })
			: new Request(`http://local/semantic-reset`, { method: "POST", headers: {
				"content-type": "application/octet-stream", "x-yaos-lease-id": meta.leaseId,
				"x-yaos-expected-epoch": String(meta.expectedEpoch), "x-yaos-covered-sequence": String(meta.coveredSequence),
				"x-yaos-content-hash": meta.contentHash, "x-yaos-content-bytes": String(meta.contentBytes),
			}, body: snapshot });
		const [response, resetMs] = await timeAsync(() => handleSemanticReset(deps, BODY, request, owner));
		const outcome = await response.json() as Record<string, unknown>;
		if (response.status !== 200) throw new Error(`reset ${response.status} ${JSON.stringify(outcome)}`);
		const [after, step1Ms] = time(() => relay.fullState(BODY)!);
		const counts = relayStore.tableCounts();
		iterations.push({ i, readMs, leaseMs, resetMs, postResetReadMs: step1Ms, snapshotBytes: snapshot.byteLength,
			mergedBytesBefore: state.bytes.byteLength, mergedBytesAfter: after.bytes.byteLength, epoch: outcome.epoch,
			ywasmMiB: mib(ywasmLinearMemoryBytes()), heapMiB: mib(process.memoryUsage().heapUsed),
			rssMiB: mib(process.memoryUsage().rss), journalRows: counts.vault_journal,
			checkpointChunks: counts.vault_checkpoints, manifests: counts.vault_checkpoint_manifests,
			catalogEvents: counts.vault_catalog_events, semanticCatalogEvents: counts.vault_semantic_catalog_events });
		console.error(JSON.stringify(iterations.at(-1)));
	}
	result.iterations = iterations;
	result.materialisations = relay.counters.materialisations;
	result.documentMaterialisations = { ...store.documentMaterialisations, recentNonRoot: undefined };
	// Item 8: 10 MB checkpoint merge through byte ops (checkpoint + tail -> merged), memory within the 96 MiB cap.
	const big = new Y.Doc();
	const bigText = big.getText("body");
	const bigContent = contentOf(10 * 1024 * 1024);
	const parts: Uint8Array[] = [];
	for (let from = 0; from < bigContent.length; from += CHUNK) {
		const before = Y.encodeStateVector(big);
		bigText.insert(bigText.length, bigContent.slice(from, from + CHUNK));
		parts.push(Y.encodeStateAsUpdate(big, before));
	}
	for (let edit = 0; edit < 200; edit++) {
		const before = Y.encodeStateVector(big);
		bigText.insert((edit * 7919) % bigText.length, "x");
		parts.push(Y.encodeStateAsUpdate(big, before));
	}
	big.destroy();
	const checkpoint = mergeUpdates(parts.slice(0, 12));
	const [merged, mergeMs] = time(() => mergeUpdates([checkpoint, ...parts.slice(12)]));
	const [, svMs] = time(() => stateVectorFromUpdate(merged));
	result.tenMb = { parts: parts.length, checkpointBytes: checkpoint.byteLength, mergedBytes: merged.byteLength, mergeMs, svMs,
		ywasmMiB: mib(ywasmLinearMemoryBytes()), capMiB: 96 };
} finally {
	sqlite.close();
	await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
