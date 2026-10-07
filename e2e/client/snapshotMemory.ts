/**
 * Snapshot memory bench (DESIGN §j.4): a synthetic vault (~50 MiB: markdown + attachments <= 1 MiB) is exported by
 * SnapshotJob.take("manual"), with side files on the real disk (a temp dir); then the snapshot is verified end to
 * end (SnapshotJob.manifest: every part, the bundle digest and every entry, as restore pass 1 does).
 *
 *   node --expose-gc --import jiti/register e2e/client/snapshotMemory.ts [--mib 50]
 *
 * Measures the live set (heapUsed + arrayBuffers after a forced gc) at every port call the job makes (disk read,
 * side-file read/write/remove), minus the same figure after the vault was built. The vault's own bytes are part of
 * the baseline; every read returns a copy, as the host does. Also reports the growth of the process's max RSS
 * (over the whole run, so it covers the verify phase too).
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { kindOfPath, type DocKind, type VaultPath } from "../../src/core/types";
import type { SideFileName, SideFilePort } from "../../src/ports/vault";
import type { DiskOp, DiskReadRequest, DiskReadResult, Lane } from "../../src/protocol/messages";
import type { DiskGateway, ExecResult } from "../../src/engine/reconcile/deps";
import { SnapshotJob } from "../../src/engine/snapshots/snapshotJob";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc");
const MIB = 1024 * 1024;
const mibArg = process.argv.indexOf("--mib");
const TARGET = (mibArg >= 0 ? Number(process.argv[mibArg + 1]) : 50) * MIB;

function live(): number {
	gc!();
	const m = process.memoryUsage();
	return m.heapUsed + m.arrayBuffers;
}

/** Deterministic text: words from a small vocabulary (compresses like prose, ~3x). */
function note(i: number, size: number): Uint8Array {
	const words = ["sync", "vault", "note", "the", "of", "relay", "device", "and", "merge", "a", "link", "[[x]]", "#tag", "to", "in"];
	let s = `# Note ${i}\n\n`;
	let x = i * 2654435761 >>> 0;
	while (s.length < size) {
		x = (x * 1103515245 + 12345) >>> 0;
		s += words[x % words.length]! + ((x >>> 8) % 11 === 0 ? ".\n" : " ");
	}
	return new TextEncoder().encode(s.slice(0, size));
}
function blob(i: number, size: number): Uint8Array {
	const b = new Uint8Array(size);
	let x = (i + 1) * 0x9e3779b9 >>> 0;
	for (let k = 0; k < size; k++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[k] = x & 0xff; }
	return b;
}

const vault = new Map<string, Uint8Array>();
let total = 0;
for (let i = 0; total < TARGET * 0.4; i++) { const b = blob(i, 1000 * 1000); vault.set(`att/${i}.bin`, b); total += b.length; }
for (let i = 0; total < TARGET; i++) { const b = note(i, 20 * 1024); vault.set(`notes/${Math.floor(i / 100)}/${i}.md`, b); total += b.length; }

const samples: number[] = [];
let base = 0;
const sample = () => { samples.push(live() - base); };

const gateway: DiskGateway = {
	async read(reads: readonly DiskReadRequest[], _lane: Lane): Promise<readonly DiskReadResult[]> {
		sample();
		return reads.map((r) => {
			const b = vault.get(r.path);
			const stat = { path: r.path, size: b?.length ?? 0, mtimeMs: 0, ctimeMs: 0 };
			if (!b) return { path: r.path, ok: false as const, reason: "missing" as const, stat: null };
			return { path: r.path, ok: true as const, stat, bytes: b.slice() };
		});
	},
	async exec(_ops: readonly DiskOp[], _lane: Lane): Promise<readonly ExecResult[]> { throw new Error("bench: no writes"); },
};

const dir = mkdtempSync(join(tmpdir(), "yaos-snapmem-"));
let sideBytes = 0;
const side: SideFilePort = {
	async read(n: SideFileName) { sample(); const p = join(dir, n); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; },
	async write(n: SideFileName, b: Uint8Array) { sample(); const p = join(dir, n); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); sideBytes += b.length; },
	async remove(n: SideFileName) { sample(); rmSync(join(dir, n), { force: true }); },
	async list(prefix: "snapshots/") { const d = join(dir, prefix); return existsSync(d) ? readdirSync(d).map((f) => `${prefix}${f}` as SideFileName) : []; },
};

const files = [...vault.entries()].map(([path, b]) => ({ path: path as VaultPath, kind: kindOfPath(path as VaultPath) as DocKind, size: b.length }));
const settings = { enabled: true, keepDaily: 7, uploadToBlobStore: false };
let now = Date.UTC(2026, 9, 7);
const deps = {
	disk: gateway, side, clock: { now: () => now, monotonic: () => now }, files: () => files, settings: () => settings,
	crypto: { blobAddress: async (h: string) => h }, remote: null, deviceLabel: "bench",
} as unknown as ConstructorParameters<typeof SnapshotJob>[0];
const job = new SnapshotJob(deps);

const rss0 = process.resourceUsage().maxRSS * 1024;
base = live();
const t0 = performance.now();
const res = await job.take("manual");
const ms = performance.now() - t0;
sample();
const exportPeak = Math.max(...samples);
samples.length = 0;
base = live();
const t1 = performance.now();
const manifest = res ? await job.manifest(res.id) : null;
const verifyMs = performance.now() - t1;
sample();
const verifyPeak = Math.max(...samples);
const rss1 = process.resourceUsage().maxRSS * 1024;
rmSync(dir, { recursive: true, force: true });
now += 1;
console.log(JSON.stringify({
	vaultBytes: total, vaultFiles: vault.size, snapshot: res ? "taken" : "skipped", sideFileBytes: sideBytes, ms: Math.round(ms),
	peakLiveGrowthMiB: +(exportPeak / MIB).toFixed(1), verifiedFiles: manifest?.files.length ?? null, verifyMs: Math.round(verifyMs),
	verifyPeakLiveGrowthMiB: +(verifyPeak / MIB).toFixed(1), maxRssGrowthMiB: +((rss1 - rss0) / MIB).toFixed(1),
}));
