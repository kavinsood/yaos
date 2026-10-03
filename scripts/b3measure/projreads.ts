/**
 * b3-m-import (local): which statements does a P2 projection alarm pass run after a bulk first open, and which of them
 * are full scans? Real VaultRuntime over NodeSqliteStorage, relay3 config (lean + group commit), bulk create of N notes
 * in 350-note batches, every R2 put advancing the simulated clock by --put-ms (deployed ≈ 320 ms → ~31 puts per 10 s pass).
 *   node tests/run-typescript.mjs --test-aliases scripts/b3measure/projreads.ts [N=2000] [putMs=320] [passes=3]
 * Node's rowsRead is rows RETURNED, not rows scanned (Cloudflare bills scanned), so each distinct statement is also run
 * through EXPLAIN QUERY PLAN; a "SCAN <table>" line means a full-table (or full-index) walk.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { VaultRuntime } from "../../server/src/server";
import { readRelayConfig } from "../../server/src/relayFlag";
import type { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import { FakeObjectStore } from "../../tests/mocks/workerEnv.ts";

const N = Number(process.argv[2] ?? 2000), PUT_MS = Number(process.argv[3] ?? 320), PASSES = Number(process.argv[4] ?? 3);
const VAULT_ID = "projreads-vault", GENERATION = "projreads-gen";
const OWNER: VaultActorContext = { vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "p-owner", membershipRevision: 1,
	deviceId: "d-owner", deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "owner-digest" };
const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
const text = (i: number) => `# Note ${i}\n\n${`Line ${i} of ordinary prose for sizing.\n`.repeat(40)}`;
const frame = (v: string) => { const d = new Y.Doc(); d.getText("body").insert(0, v); const u = Y.encodeStateAsUpdate(d); d.destroy(); return u; };

const dir = await mkdtemp(join(tmpdir(), "yaos-projreads-"));
const sqlite = NodeSqliteStorage.open(join(dir, "vault.sqlite"));
let tally: Map<string, { n: number; returned: number; written: number; cursors: Array<{ rowsRead: number; rowsWritten: number }> }> | null = null;
const norm = (q: string) => q.replace(/\s+/g, " ").trim();
const sql = new Proxy(sqlite.sql, { get(t, p) {
	if (p === "exec") return (q: string, ...b: unknown[]) => { const c = t.exec(q, ...(b as never[]));
		if (tally) { const k = norm(q); const e = tally.get(k) ?? { n: 0, returned: 0, written: 0, cursors: [] }; e.n++; e.cursors.push(c as never); tally.set(k, e); }
		return c; };
	const v = Reflect.get(t, p, t) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
const storage = new Proxy(sqlite, { get(t, p) { if (p === "sql") return sql; const v = Reflect.get(t, p, t) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
const tasks = new Set<Promise<unknown>>();
let alarm: number | null = null;
let puts = 0;
const objects = new FakeObjectStore({ onPut: () => { puts++; clock += PUT_MS; } });
const vault = new VaultRuntime({ storage: storage as never,
	sockets: { sockets: () => [], createPair: () => { throw new Error("no sockets"); }, accept: () => {}, upgradeResponse: () => { throw new Error("no sockets"); } },
	alarms: { setAlarm: async (x: number) => { alarm = x; }, deleteAlarm: async () => { alarm = null; }, getAlarm: async () => alarm },
	execution: { waitUntil: (task) => { const tr = task.finally(() => tasks.delete(tr)); tasks.add(tr); } },
	objectStore: objects, recoveryJobs: { call: async () => new Response("{}", { status: 503 }) },
	relayBodies: true, relayConfig: readRelayConfig({ YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GROUP_COMMIT: "1" }) });
const fetchVault = async (path: string, init: RequestInit = {}) => { const h = actorHeaders(OWNER); new Headers(init.headers).forEach((v, k) => h.set(k, v));
	h.set("x-yaos-vault-id", VAULT_ID); h.set("x-yaos-vault-generation", GENERATION); return await vault.fetch(new Request(`https://internal${path}`, { ...init, headers: h })); };
const settle = async () => { await new Promise((r) => setTimeout(r, 5)); while (tasks.size) await Promise.all([...tasks]); };
try {
	if ((await fetchVault("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) })).status !== 201) throw new Error("provision");
	(vault as unknown as { store: VaultStore }).store.installAuthorityFence({ changeId: "b", vaultId: VAULT_ID, vaultGeneration: GENERATION, subjectDigest: "d",
		subjects: [{ principalId: OWNER.principalId, role: OWNER.role, state: "active", membershipRevision: 1, policyVersion: 1, capabilityDigest: OWNER.capabilityDigest, displayName: "O", colorSeed: "o" },
			{ deviceId: OWNER.deviceId, principalId: OWNER.principalId, state: "active", credentialRevision: 1 }] } as never);
	await settle();
	for (let s = 0, b = 0; s < N; s += 350, b++) {
		const ids = Array.from({ length: Math.min(350, N - s) }, (_v, k) => s + k);
		const body = encodeBinaryEnvelope({ batchId: `b${b}`, rootEpoch: 1, attachments: [], files: ids.map((i) => ({ operationId: `op-${i}`, bodyId: `body-${i}`, path: `f${i % 40}/n-${i}.md`, updates: [frame(text(i))] })) });
		const r = await fetchVault("/lifecycle/create-bulk", { method: "POST", body: body.slice().buffer });
		if (r.status !== 200) throw new Error(`bulk ${r.status} ${await r.text()}`);
		await settle();
	}
	console.log(`seeded ${N} notes; puts after inline: ${puts}; alarm ${alarm !== null}`);
	for (let p = 0; p < PASSES; p++) {
		await settle();
		if (alarm === null) { console.log("no alarm owed"); break; }
		clock = Math.max(clock, alarm); alarm = null;
		tally = new Map(); const p0 = puts, c0 = clock;
		await vault.alarm(); await settle();
		const rows = [...tally.entries()].map(([q, e]) => ({ q, n: e.n, ret: e.cursors.reduce((s, c) => s + c.rowsRead, 0), w: e.cursors.reduce((s, c) => s + (c.rowsWritten || 0), 0) }));
		tally = null;
		console.log(`\npass ${p}: puts=${puts - p0} simMs=${clock - c0} statements=${rows.reduce((s, r) => s + r.n, 0)} returned=${rows.reduce((s, r) => s + r.ret, 0)} written=${rows.reduce((s, r) => s + r.w, 0)}`);
		for (const r of rows.sort((a, b) => b.n - a.n)) {
			let plan = "";
			if (/^\s*(SELECT|WITH)/i.test(r.q)) {
				try { const params = (r.q.match(/\?/g) ?? []).map(() => null);
					plan = sqlite.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${r.q}`, ...(params as never[])).toArray().map((x) => x.detail).filter((d) => /SCAN/.test(d)).join(" | ");
				} catch (e) { plan = `explain failed: ${String(e).slice(0, 60)}`; }
			}
			console.log(`  n=${String(r.n).padStart(4)} ret=${String(r.ret).padStart(6)} w=${String(r.w).padStart(4)} ${plan ? `[${plan}] ` : ""}${r.q.slice(0, 150)}`);
		}
	}
} finally { Date.now = realNow; sqlite.close(); await rm(dir, { recursive: true, force: true }); }
process.exit(0);
