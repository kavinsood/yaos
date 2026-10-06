/**
 * Fresh-device bootstrap bench: a writer seeds N notes (+ binary attachments) into a new vault, then fresh devices
 * start against it one after another, each with a BootTrace (bootTrace.ts) on its production ports. Reports, per
 * fresh device: ticket / socket / VAULT_READY, feed and catch-up read requests (count, concurrency, span), storage
 * transactions, first/last disk write, time until every file is on disk and until clean convergence, and the
 * spans in relay round trips (median of a timed feed request with the device credential).
 *
 *   node --import jiti/register e2e/client/bootBench.ts --host URL --label L [--notes 1000] [--attachments 20]
 *        [--big 2] [--repeat 1] [--watcher-ms 100]
 *
 * Writes LOG_DIR/client-e2e-boot-<label>-<stamp>.json (no secrets) and exits 1 on a failed check.
 */
import { Report, sleep } from "./engineKit";
import { BootTrace, type HttpEvent } from "./bootTrace";
import { converge, randomBytes, waitFor } from "./fullCheck";
import { FullClient } from "./fullKit";
import { DEFAULT_LOG_DIR, onboardVault, pairDevice, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", "http://127.0.0.1:8791").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const NOTES = Number(arg("notes", "1000"));
const ATTACH = Number(arg("attachments", "20"));
const BIG = Number(arg("big", "2"));
const REPEAT = Number(arg("repeat", "1"));
const WATCHER_MS = Number(arg("watcher-ms", "100"));
const R = new Report();
const r1 = (v: number) => Math.round(v * 10) / 10;
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]! : 0);

/** Median ms of timed relay requests with a device credential (the credential stays in this function). */
async function relayRtt(vault: OnboardedVault): Promise<Record<string, number>> {
	const dev = vault.devices[0]!;
	const base = `${HOST}/vault/${encodeURIComponent(vault.vaultId)}`;
	const time = async (url: string, auth: boolean) => {
		const s = performance.now();
		await (await fetch(url, auth ? { headers: { Authorization: `Bearer ${dev.deviceToken}` } } : {})).arrayBuffer();
		return performance.now() - s;
	};
	await time(`${HOST}/api/capabilities`, false);
	const caps: number[] = [];
	const feed: number[] = [];
	for (let i = 0; i < 7; i++) caps.push(await time(`${HOST}/api/capabilities`, false));
	for (let i = 0; i < 7; i++) feed.push(await time(`${base}/streams/feed?after=0&limit=1`, true));
	return { workerMs: r1(median(caps)), relayRequestMs: r1(median(feed)) };
}

function seed(a: FullClient): void {
	for (let i = 0; i < NOTES; i++) {
		const body = `# Note ${i}\n\n${`Some text for note ${i}. `.repeat(8 + (i % 50))}\n- [ ] task ${i}\n`;
		a.vault.userWrite(`bulk/f${i % 25}/sub${i % 4}/n${i}.md`, body);
	}
	for (let i = 0; i < ATTACH; i++) a.vault.externalWrite(`att/img-${i}.png`, randomBytes(40 * 1024 + i, 100 + i));
	for (let i = 0; i < BIG; i++) a.vault.externalWrite(`att/doc-${i}.pdf`, randomBytes(300 * 1024 + i, 200 + i));
}

function analyze(tr: BootTrace, rtt: number, filesMs: number, cleanMs: number) {
	const by = (route: string) => tr.http.filter((e) => e.route === route);
	const span = (ev: HttpEvent[]) => (ev.length ? { first: r1(ev[0]!.startMs), last: r1(Math.max(...ev.map((e) => e.startMs + e.ms))) } : null);
	const reads = by("/streams/read");
	const feed = by("/streams/feed");
	const ws = tr.ws[0];
	const maxReads = Math.max(0, ...tr.samples.map((s) => s.reads));
	const writes = tr.samples.filter((s, i) => i > 0 && s.writes > tr.samples[i - 1]!.writes);
	const live = tr.samples.find((s) => s.phase === "live");
	const txByStores: Record<string, { n: number; ms: number }> = {};
	for (const t of tr.tx) {
		const e = (txByStores[`${t.mode} ${t.stores}`] ??= { n: 0, ms: 0 });
		e.n++;
		e.ms = r1(e.ms + t.ms);
	}
	const readSpan = span(reads);
	const rt = (ms: number | null | undefined) => (ms == null ? null : r1(ms / rtt));
	return {
		rttMs: rtt,
		ticket: by("/auth/ticket").map((e) => r1(e.ms)),
		socket: ws ? { ctor: r1(ws.ctorMs), open: ws.openMs && r1(ws.openMs), ready: ws.readyMs && r1(ws.readyMs) } : null,
		feed: { n: feed.length, ms: feed.map((e) => r1(e.ms)), bytes: feed.reduce((s, e) => s + e.bytes, 0), span: span(feed) },
		reads: {
			n: reads.length, streamsPerRequest: reads.length ? r1(reads.reduce((s, e) => s + Math.max(1, e.streams), 0) / reads.length) : 0,
			p50Ms: r1(median(reads.map((e) => e.ms))), maxMs: r1(Math.max(0, ...reads.map((e) => e.ms))),
			bytes: reads.reduce((s, e) => s + e.bytes, 0), maxInFlight: maxReads, span: readSpan,
			spanRtts: readSpan ? rt(readSpan.last - readSpan.first) : null,
		},
		checkpoints: by("/streams/checkpoint").length,
		blobs: by("/blobs").length,
		otherHttp: tr.http.filter((e) => !["/streams/read", "/streams/feed", "/auth/ticket", "/streams/checkpoint", "/blobs"].includes(e.route)).map((e) => e.route),
		tx: { n: tr.tx.length, ms: r1(tr.tx.reduce((s, t) => s + t.ms, 0)), top: Object.entries(txByStores).sort((x, y) => y[1].n - x[1].n).slice(0, 6) },
		disk: { writes: writes.at(-1)?.writes ?? 0, first: writes[0] ? r1(writes[0].t) : null, last: writes.at(-1) ? r1(writes.at(-1)!.t) : null },
		liveAt: live ? r1(live.t) : null,
		filesMs: r1(filesMs), cleanMs: r1(cleanMs), filesRtts: rt(filesMs),
	};
}

let vault: OnboardedVault | null = null;
const all: FullClient[] = [];
let fatal: string | null = null;
try {
	R.step("seed");
	vault = await onboardVault(HOST, { devices: 1, label: `boot-${LABEL}` });
	const a = new FullClient({ name: "a", host: HOST, vaultId: vault.vaultId, device: vault.devices[0]!, watcherDelayMs: WATCHER_MS });
	all.push(a);
	await a.start();
	await converge([a], 60_000);
	const ts = performance.now();
	seed(a);
	await waitFor(() => a.vault.snapshot().size >= NOTES + ATTACH + BIG, "seed on disk", 60_000);
	await converge([a], 900_000, 500);
	R.record("seed_upload_ms", performance.now() - ts);
	const files = a.vault.snapshot().size;
	R.extra.vaultShape = { notes: NOTES, attachments: ATTACH, big: BIG, files, vaultSeq: a.vrt?.log.c.repo.cursor.vaultSeq ?? null, blob: a.blobKind };
	const rtt = await relayRtt(vault);
	R.extra.rtt = rtt;
	console.log(`seeded ${files} files; relay request ${rtt.relayRequestMs} ms, worker ${rtt.workerMs} ms`);

	for (let k = 0; k < REPEAT; k++) {
		R.step(`fresh device ${k + 1}`);
		const dev = await pairDevice(vault, `F${k}`);
		const tr = new BootTrace();
		const f = new FullClient({ name: `f${k}`, host: HOST, vaultId: vault.vaultId, device: dev, watcherDelayMs: WATCHER_MS, trace: tr });
		all.push(f);
		tr.reset();
		tr.sample(() => {
			const c = f.vrt?.log.c;
			return { phase: f.vrt?.status().phase ?? null, reads: c?.sess.readsInFlight ?? 0, feeding: c?.sess.isFeeding ?? false,
				writes: f.vault.calls.write, readsDone: c?.sess.stats.reads ?? 0, feedPages: c?.sess.stats.feedPages ?? 0 };
		});
		const t0 = performance.now();
		await f.start();
		const filesMs = await waitFor(() => f.vault.snapshot().size >= files, "every file on the fresh device", 900_000, t0, 10);
		await converge([a, f], 900_000);
		const cleanMs = performance.now() - t0;
		tr.stop();
		R.record("fresh_files_ms", filesMs);
		R.record("fresh_clean_ms", cleanMs);
		const res = analyze(tr, rtt.relayRequestMs, filesMs, cleanMs);
		R.extra[`boot ${k + 1}`] = res;
		R.check("fresh device has every file", f.vault.snapshot().size === files, { files: f.vault.snapshot().size, expected: files });
		console.log(JSON.stringify(res));
		await f.stop();
		await sleep(500);
	}
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
} finally {
	for (const c of all) {
		try { await c.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-boot", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
