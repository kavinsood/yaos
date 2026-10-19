/**
 * Subscriptions fan-out measurement (DESIGN §d.7 "Subscriptions", relay-wire §5.6): what a reader device receives
 * while a writer types in a note: with the note open on the reader (bound, so subscribed: its rows are pushed)
 * against the note closed there (not subscribed: its rows arrive as STREAM_SKIPPED and are read once the stream is
 * quiet).
 *
 * Per mode, on a fresh vault: two headless LogEngines on the production adapters (engineKit.ts). The writer creates
 * the note, both converge, then the writer (and in mode `open` the reader) binds it and the writer types `--keys`
 * keys at `--rate` keys/s (one editor transaction per key). Measured on the reader, from the first key until the note's last row landed in the reader's
 * store (its stream caught up through the writer's last receipt):
 *   - socket: binary messages and bytes received (PROVISIONAL / COMMITTED / COMMIT_NOTICE / STREAM_SKIPPED by kind),
 *     text (control) messages and bytes;
 *   - HTTP: catch-up read requests (`/streams/read`, batched or not) and their response bytes;
 *   - time from the last key to the note landing (closed: the deferral, desktop 5 s quiet; phone 150 s,
 *     `--reader-class`).
 * The reader's text must equal the writer's at the end (checked). Real deferral values (no tuning override).
 *
 *   node --import jiti/register e2e/client/fanout.ts --host URL [--label local] [--keys 300] [--rate 20]
 *        [--reader-class desktop|phone] [--operator-context FILE]
 *
 * Writes LOG_DIR/client-e2e-fanout-<label>-<stamp>.json (no secrets) and exits 1 on any failed check.
 */
import type { DeviceClass } from "../../src/core/limits";
import type { DocId, VaultPath } from "../../src/core/types";
import type { WebSocketCtor, WebSocketLike } from "../../src/engine/adapters/wsRelay";
import { Device, Report, converge, sleep, until } from "./engineKit";
import { DEFAULT_LOG_DIR, onboardVault, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const KEYS = Math.max(1, Number(arg("keys", "300")));
const RATE = Math.max(1, Number(arg("rate", "20")));
const READER_CLASS = arg("reader-class", "desktop") as DeviceClass;
const OPERATOR_CONTEXT = arg("operator-context", "");
const R = new Report();

const FRAME_KINDS: Record<number, string> = { 0x10: "provisional", 0x11: "committed", 0x12: "notice", 0x13: "skipped" };

/** What the reader's transport saw while `on`. */
class Meter {
	on = false;
	binMsgs = 0;
	binBytes = 0;
	textMsgs = 0;
	textBytes = 0;
	readonly byKind: Record<string, number> = {};
	readRequests = 0;
	readBytes = 0;

	/** A WebSocket that counts what it receives (the adapter's onmessage still gets every message). */
	socket(): WebSocketCtor {
		const meter = this;
		const Base = WebSocket as unknown as new (url: string) => WebSocketLike & EventTarget;
		return class extends Base {
			constructor(url: string) {
				super(url);
				this.addEventListener("message", (ev: Event) => {
					if (!meter.on) return;
					const data = (ev as MessageEvent).data as unknown;
					if (typeof data === "string") {
						meter.textMsgs++;
						meter.textBytes += Buffer.byteLength(data);
						const type = /"type":"([A-Z_]+)"/.exec(data)?.[1] ?? "?";
						meter.byKind[type] = (meter.byKind[type] ?? 0) + 1;
						return;
					}
					const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
					if (!bytes) return;
					meter.binMsgs++;
					meter.binBytes += bytes.byteLength;
					const kind = FRAME_KINDS[bytes[0] ?? 0] ?? `0x${(bytes[0] ?? 0).toString(16)}`;
					meter.byKind[kind] = (meter.byKind[kind] ?? 0) + 1;
				});
			}
		} as unknown as WebSocketCtor;
	}

	/** fetch that counts catch-up read responses. */
	fetch(): typeof fetch {
		return async (input, init) => {
			const res = await fetch(input, init);
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!this.on || !/\/streams\/read(Batch)?\b/.test(url)) return res;
			this.readRequests++;
			this.readBytes += (await res.clone().arrayBuffer()).byteLength;
			return res;
		};
	}

	result() {
		return {
			socket: { binMsgs: this.binMsgs, binBytes: this.binBytes, textMsgs: this.textMsgs, textBytes: this.textBytes, byKind: this.byKind },
			http: { readRequests: this.readRequests, readBytes: this.readBytes },
			totalBytes: this.binBytes + this.textBytes + this.readBytes,
		};
	}
}

const vaults: OnboardedVault[] = [];
const devices: Device[] = [];

async function measure(mode: "open" | "closed"): Promise<Record<string, unknown>> {
	R.step(`reader ${mode}`);
	const vault = await onboardVault(HOST, { devices: 2, label: `fanout-${mode}-${LABEL}`, ...(OPERATOR_CONTEXT ? { operatorContextFile: OPERATOR_CONTEXT } : {}) });
	vaults.push(vault);
	const writer = new Device("w", vault.devices[0]!);
	const reader = new Device("r", vault.devices[1]!);
	devices.push(writer, reader);
	const meter = new Meter();
	await writer.start(HOST, vault.vaultId, {});
	await reader.start(HOST, vault.vaultId, {}, {
		deviceClass: READER_CLASS, WebSocketImpl: meter.socket(), fetch: meter.fetch(),
	});
	await until(() => writer.e.status().phase === "live" && reader.e.status().phase === "live", 20_000, "live");
	const id: DocId = await writer.e.createDoc("notes/typed.md" as VaultPath, "header\n");
	await converge([writer, reader], 60_000 + 400_000 * (READER_CLASS === "desktop" ? 0 : 1));
	const stream = reader.e.streamOf(id);
	await writer.bind(id);
	if (mode === "open") await reader.bind(id);
	await sleep(2_000); // both sets are in place: the writer's names the note, the reader's only in mode open

	// Rows skipped before the first key (the note's creation, before the reader bound it) are not this run's.
	const skippedBefore = reader.e.c.live.stats.skipped;
	meter.on = true;
	const t0 = performance.now();
	const every = 1000 / RATE;
	for (let i = 0; i < KEYS; i++) {
		writer.type(id, i % 40 === 39 ? "\n" : String.fromCharCode(97 + (i % 26)));
		await sleep(Math.max(0, t0 + (i + 1) * every - performance.now()));
	}
	const typedAt = performance.now();
	// The writer's last row: everything typed is receipted (nothing of the note left in its outbox).
	await until(() => writer.e.c.outbox.ofStream(stream).length === 0 && writer.e.bodyDurable(id), 60_000, "writer receipted");
	const lastSeq = writer.e.c.repo.stream(stream)!.lastOwnSeq;
	const landed = () => {
		const r = reader.e.c.repo.stream(stream);
		return r !== undefined && r.appliedSeq >= lastSeq && r.stale === 0;
	};
	await until(landed, 20 * 60_000, "the note landed on the reader");
	const landedAt = performance.now();
	meter.on = false;
	const text = await writer.e.docText(id);
	R.check(`${mode}: reader text equals the writer's`, (await reader.e.docText(id)) === text, { writer: text.length });
	const live = reader.e.c.live.stats;
	const skipped = live.skipped - skippedBefore;
	const result = {
		mode, readerClass: READER_CLASS, keys: KEYS, rate: RATE,
		writerAppends: writer.e.c.sender.stats.appends,
		typingMs: Math.round(typedAt - t0),
		lastKeyToLandedMs: Math.round(landedAt - typedAt),
		firstKeyToLandedMs: Math.round(landedAt - t0),
		reader: meter.result(),
		readerEngine: { skippedRows: skipped, liveRows: live.rows, staleItems: live.stale, reads: reader.e.c.sess.stats.reads, readBatches: reader.e.c.sess.stats.readBatches, subscribeSends: reader.e.c.subs.stats.sends },
		checkpoint: { coversSeq: reader.e.c.repo.stream(stream)!.remoteCheckpointCoversSeq },
	};
	console.log(JSON.stringify(result));
	R.extra[mode] = result;
	if (mode === "closed") {
		R.check("closed: the reader was sent skips, not the note's payloads", skipped > 0 && (meter.byKind.committed ?? 0) + (meter.byKind.notice ?? 0) < skipped, meter.byKind);
	} else {
		R.check("open: the reader got the note pushed, no skips", skipped === 0 && (meter.byKind.skipped ?? 0) === 0 && (meter.byKind.provisional ?? 0) > 0, meter.byKind);
	}
	await writer.stop();
	await reader.stop();
	return result;
}

let fatal: string | null = null;
try {
	const open = await measure("open");
	const closed = await measure("closed");
	const o = open.reader as ReturnType<Meter["result"]>;
	const c = closed.reader as ReturnType<Meter["result"]>;
	R.extra.comparison = {
		socketMsgs: { open: o.socket.binMsgs + o.socket.textMsgs, closed: c.socket.binMsgs + c.socket.textMsgs },
		socketBytes: { open: o.socket.binBytes + o.socket.textBytes, closed: c.socket.binBytes + c.socket.textBytes },
		httpReadBytes: { open: o.http.readBytes, closed: c.http.readBytes },
		totalBytes: { open: o.totalBytes, closed: c.totalBytes },
		lastKeyToLandedMs: { open: open.lastKeyToLandedMs, closed: closed.lastKeyToLandedMs },
	};
	console.log(JSON.stringify({ comparison: R.extra.comparison }));
	R.check("the reader without the note open got fewer socket messages", c.socket.binMsgs < o.socket.binMsgs, R.extra.comparison);
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
} finally {
	for (const d of devices) {
		try { await d.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-fanout", LABEL, HOST, vaults[0] ?? null, fatal);
process.exit(failed === 0 ? 0 : 1);
