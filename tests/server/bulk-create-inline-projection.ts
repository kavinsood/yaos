// b3-int: bulk create → inline recovery projection (PHASE4 P2) through the real
// VaultRuntime (the code path both the Worker DO and packages/server-node use).
// - A committed bulk create puts each body's opaque state object to R2 right
//   after the receipt, with no RecoveryJob call and no alarm pass.
// - The receipt is never delayed: no put happens before the response returns.
// - Replaying the same batch re-puts nothing (no hook, and the alarm pass finds
//   the content already indexed).
// - D8: while the daily limit is latched the inline hook skips (no put attempt);
//   the alarm pass projects after the reset. create-bulk answers the typed 503.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import { VaultRuntime } from "../../server/src/server";
import { contentObjectKey } from "../../server/src/recoveryProtocol";
import type { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import { CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE, DAILY_LIMIT_ERROR_CODE, DailyLimitLatch, instrumentStorageForDailyLimit } from "../../server/src/dailyLimit";
import { FakeObjectStore } from "../mocks/workerEnv.ts";
import { decodeRecoveryStateObject } from "../../legacy-src/snapshots/recoveryStateDecode";
import { suite } from "../harness.ts";

const s = suite("bulk-create-inline-projection");

const VAULT_ID = "inline-vault-0001";
const GENERATION = "inline-generation-0001";
const OWNER: VaultActorContext = {
	vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-owner", membershipRevision: 1,
	deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "owner-digest",
};

const realNow = Date.now;
let clock = realNow();

function text(i: number): string { return `# Inline ${i}\n\n${`Body line ${i} of ordinary prose.\n`.repeat(12)}`; }
function hashOf(value: string): string { return sha256HexSync(canonicalMarkdownBytes(value)); }
/** Memoized: an exact replay must send byte-identical frames (a fresh Y.Doc has a new clientID). */
const frames = new Map<string, Uint8Array>();
function frame(value: string): Uint8Array {
	const known = frames.get(value);
	if (known) return known;
	const doc = new Y.Doc();
	doc.getText("body").insert(0, value);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	frames.set(value, update);
	return update;
}

interface World {
	vault: VaultRuntime;
	objects: FakeObjectStore;
	latch: DailyLimitLatch;
	jobCalls: number;
	alarmAt(): number | null;
	/** Set when the create-bulk response has been returned to the caller. */
	responded: boolean;
	putsBeforeResponse: number;
	simulateLimit: boolean;
	bulk(batchId: string, names: number[]): Promise<Response>;
	settle(): Promise<void>;
	fireAlarmsThrough(target: number): Promise<void>;
}

async function withWorld(options: { relay: boolean; instrument: boolean }, check: (world: World) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-inline-projection-"));
	clock = realNow();
	Date.now = () => clock;
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		const tasks = new Set<Promise<unknown>>();
		let alarm: number | null = null;
		const latch = new DailyLimitLatch(() => clock);
		const world = {} as World;
		world.jobCalls = 0;
		world.responded = true;
		world.putsBeforeResponse = 0;
		world.simulateLimit = false;
		const objects = new FakeObjectStore({ onPut: () => { if (!world.responded) world.putsBeforeResponse++; } });
		const storage = options.instrument
			? instrumentStorageForDailyLimit(sqlite, latch, () => world.simulateLimit)
			: sqlite;
		const vault = new VaultRuntime({
			storage: storage as never,
			dailyLimit: latch,
			sockets: {
				sockets: () => [],
				createPair: () => { throw new Error("no sockets in this suite"); },
				accept: () => {},
				upgradeResponse: () => { throw new Error("no sockets in this suite"); },
			},
			alarms: {
				setAlarm: async (time: number) => { alarm = time; },
				deleteAlarm: async () => { alarm = null; },
				getAlarm: async () => alarm,
			},
			execution: {
				waitUntil: (task) => {
					const tracked = task.finally(() => tasks.delete(tracked));
					tasks.add(tracked);
				},
			},
			objectStore: objects,
			recoveryJobs: { call: async () => { world.jobCalls++; return new Response(JSON.stringify({ error: "unused" }), { status: 503 }); } },
			relayBodies: options.relay,
		});
		const fetchVault = async (path: string, init: RequestInit = {}) => {
			const headers = actorHeaders(OWNER);
			new Headers(init.headers).forEach((value, name) => headers.set(name, value));
			headers.set("x-yaos-vault-id", VAULT_ID);
			headers.set("x-yaos-vault-generation", GENERATION);
			return await vault.fetch(new Request(`https://internal${path}`, { ...init, headers }));
		};
		Object.assign(world, {
			vault, objects, latch,
			alarmAt: () => alarm,
			bulk: async (batchId: string, names: number[]) => {
				const body = encodeBinaryEnvelope({ batchId, rootEpoch: 1, attachments: [],
					files: names.map((i) => ({ operationId: `op-${i}`, bodyId: `body-${i}`, path: `inline-${i}.md`, updates: [frame(text(i))] })) });
				world.responded = false;
				try {
					return await fetchVault("/lifecycle/create-bulk", { method: "POST", body: body.slice().buffer });
				} finally {
					world.responded = true;
				}
			},
			settle: async () => {
				// The inline task starts on a macrotask; let it begin, then drain.
				await new Promise((resolve) => setTimeout(resolve, 5));
				while (tasks.size > 0) await Promise.all([...tasks]);
			},
			fireAlarmsThrough: async (target: number) => {
				for (let i = 0; i < 50; i++) {
					await world.settle();
					if (alarm === null || alarm > target) break;
					clock = Math.max(clock, alarm);
					alarm = null;
					await vault.alarm();
				}
				clock = Math.max(clock, target);
			},
		});
		const provisioned = await fetchVault("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) });
		assert.equal(provisioned.status, 201);
		(vault as unknown as { store: VaultStore }).store.installAuthorityFence({
			changeId: "inline-bootstrap", vaultId: VAULT_ID, vaultGeneration: GENERATION, subjectDigest: "inline-bootstrap-digest",
			subjects: [
				{ principalId: OWNER.principalId, role: OWNER.role, state: "active", membershipRevision: 1,
					policyVersion: 1, capabilityDigest: OWNER.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
				{ deviceId: OWNER.deviceId, principalId: OWNER.principalId, state: "active", credentialRevision: 1 },
			],
		});
		await world.settle();
		await check(world);
	} finally {
		Date.now = realNow;
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

const stateKey = (i: number) => contentObjectKey(VAULT_ID, GENERATION, hashOf(text(i)));
const stateKeys = (objects: FakeObjectStore) => objects.puts.filter((put) => put.key.includes("/recovery-v2/state/"));

for (const relay of [false, true]) {
	const mode = relay ? "relay" : "base";

	s.test(`[${mode}] a bulk create projects every body to R2 inline: no RecoveryJob, no alarm pass, receipt first; a replay re-puts nothing`, async () => {
		await withWorld({ relay, instrument: false }, async (world) => {
			const names = [1, 2, 3, 4, 5];
			const response = await world.bulk("batch-inline-1", names);
			assert.equal(response.status, 200);
			assert.equal(world.putsBeforeResponse, 0, "no R2 put runs inside the create-bulk request");
			await world.settle();
			for (const i of names) {
				const bytes = world.objects.objects.get(stateKey(i));
				assert.ok(bytes, `state object for note ${i}`);
				assert.equal(new TextDecoder().decode((await decodeRecoveryStateObject(bytes)).plain), text(i));
			}
			assert.equal(stateKeys(world.objects).length, names.length, "one put per body");
			assert.equal(world.jobCalls, 0, "the RecoveryJob is not involved");
			const inline = (world.vault as unknown as { inlineProjection: { scheduled: number; projected: number; skippedDailyLimit: number } }).inlineProjection;
			assert.deepEqual(inline, { scheduled: 1, projected: names.length, skippedDailyLimit: 0 });

			const replay = await world.bulk("batch-inline-1", names);
			assert.equal(replay.status, 200, "an exact replay answers the stored receipt");
			await world.settle();
			// The alarm pass (the guarantee) rechecks the same bodies: indexed → no put.
			await world.fireAlarmsThrough(clock + 10 * 60_000);
			assert.equal(stateKeys(world.objects).length, names.length, "replay + the alarm pass re-put nothing");
			assert.equal(world.jobCalls, 0);
		});
	});
}

s.test("D8: while the daily limit is latched the inline hook skips (no put attempt); the alarm projects after the reset", async () => {
	await withWorld({ relay: true, instrument: false }, async (world) => {
		// Uninstrumented storage: the commit succeeds while the latch stays set, which
		// isolates the hook's own check (with real instrumentation a successful row
		// write clears the latch, so the hook would rightly run).
		assert.ok(world.latch.note(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE)));
		const response = await world.bulk("batch-limited", [7, 8]);
		assert.equal(response.status, 200);
		await world.settle();
		assert.equal(stateKeys(world.objects).length, 0, "the hook does not attempt a put while latched");
		const resetAt = world.latch.body()!.resetAt;
		world.latch.clear();
		await world.fireAlarmsThrough(Math.max(clock, resetAt) + 10 * 60_000);
		assert.ok(world.objects.objects.has(stateKey(7)) && world.objects.objects.has(stateKey(8)), "the alarm pass projected both");
		assert.equal(world.jobCalls, 0);
	});
});

s.test("D8: create-bulk under the (simulated) daily row limit answers the typed 503, and nothing is projected", async () => {
	await withWorld({ relay: true, instrument: true }, async (world) => {
		world.simulateLimit = true;
		const response = await world.bulk("batch-503", [9]);
		assert.equal(response.status, 503);
		assert.ok(Number(response.headers.get("retry-after")) > 0);
		assert.equal((await response.json() as { error?: string }).error, DAILY_LIMIT_ERROR_CODE);
		await world.settle();
		assert.equal(stateKeys(world.objects).length, 0);
		world.simulateLimit = false;
		world.latch.clear();
		const retried = await world.bulk("batch-503", [9]);
		assert.equal(retried.status, 200, "the same batch commits after the reset");
		await world.settle();
		assert.ok(world.objects.objects.has(stateKey(9)));
	});
});

await s.done();
