/**
 * Subscriptions fan-out measurement (DESIGN §d.7 "Subscriptions", relay-wire §5.6): what a reader device receives
 * while a writer types in a note the reader does NOT have open, with the reader subscribed (the engine's own set)
 * against a reader that never subscribes (every stream pushed: the behaviour before subscriptions).
 *
 * Per mode, on a fresh vault: two headless LogEngines on the production adapters (engineKit.ts). The writer creates
 * the note, both converge, then the writer binds it and types `--keys` keys at `--rate` keys/s (one editor
 * transaction per key). Measured on the reader, from the first key until the note's last row landed in the reader's
 * store (its stream caught up through the writer's last receipt):
 *   - socket: binary messages and bytes received (PROVISIONAL / COMMITTED / COMMIT_NOTICE / STREAM_SKIPPED by kind),
 *     text (control) messages and bytes;
 *   - HTTP: catch-up read requests (`/streams/read`, batched or not) and their response bytes;
 *   - time from the last key to the note landing (the deferral: desktop 5 s quiet; phone 150 s, `--reader-class`).
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

async function measure(mode: "subscribed" | "all"): Promise<Record<string, unknown>> {
	R.step(`reader ${mode}`);
	const vault = await onboardVault(HOST, { devices: 2, label: `fanout-${mode}-${LABEL}`, ...(OPERATOR_CONTEXT ? { operatorContextFile: OPERATOR_CONTEXT } : {}) });
	vaults.push(vault);
	const writer = new Device("w", vault.devices[0]!);
	const reader = new Device("r", vault.devices[1]!);
	devices.push(writer, reader);
	const meter = new Meter();
	await writer.start(HOST, vault.vaultId, {});
	await reader.start(HOST, vault.vaultId, {}, {
		deviceClass: READER_CLASS, subscribe: mode === "subscribed", WebSocketImpl: meter.socket(), fetch: meter.fetch(),
	});
	await until(() => writer.e.status().phase === "live" && reader.e.status().phase === "live", 20_000, "live");
	const id: DocId = await writer.e.createDoc("notes/typed.md" as VaultPath, "header\n");
	await converge([writer, reader], 60_000 + 400_000 * (READER_CLASS === "desktop" ? 0 : 1));
	const stream = reader.e.streamOf(id);
	await writer.bind(id);
	await sleep(2_000); // the writer's set (now with the note) is in place; the reader's never names it

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
	const result = {
		mode, readerClass: READER_CLASS, keys: KEYS, rate: RATE,
		writerAppends: writer.e.c.sender.stats.appends,
		typingMs: Math.round(typedAt - t0),
		lastKeyToLandedMs: Math.round(landedAt - typedAt),
		firstKeyToLandedMs: Math.round(landedAt - t0),
		reader: meter.result(),
		readerEngine: { skippedRows: live.skipped, liveRows: live.rows, staleItems: live.stale, reads: reader.e.c.sess.stats.reads, readBatches: reader.e.c.sess.stats.readBatches, subscribeSends: reader.e.c.subs.stats.sends },
		checkpoint: { coversSeq: reader.e.c.repo.stream(stream)!.remoteCheckpointCoversSeq },
	};
	console.log(JSON.stringify(result));
	R.extra[mode] = result;
	if (mode === "subscribed") {
		R.check("subscribed: the reader was sent skips, not the note's payloads", live.skipped > 0 && (meter.byKind.committed ?? 0) + (meter.byKind.notice ?? 0) < live.skipped, meter.byKind);
	} else {
		R.check("all: the reader got no skips", live.skipped === 0 && (meter.byKind.skipped ?? 0) === 0, meter.byKind);
	}
	await writer.stop();
	await reader.stop();
	return result;
}

let fatal: string | null = null;
try {
	const sub = await measure("subscribed");
	const all = await measure("all");
	const s = sub.reader as ReturnType<Meter["result"]>;
	const a = all.reader as ReturnType<Meter["result"]>;
	R.extra.comparison = {
		socketMsgs: { subscribed: s.socket.binMsgs + s.socket.textMsgs, all: a.socket.binMsgs + a.socket.textMsgs },
		socketBytes: { subscribed: s.socket.binBytes + s.socket.textBytes, all: a.socket.binBytes + a.socket.textBytes },
		httpReadBytes: { subscribed: s.http.readBytes, all: a.http.readBytes },
		totalBytes: { subscribed: s.totalBytes, all: a.totalBytes },
		lastKeyToLandedMs: { subscribed: sub.lastKeyToLandedMs, all: all.lastKeyToLandedMs },
	};
	console.log(JSON.stringify({ comparison: R.extra.comparison }));
	R.check("subscribed reader got fewer socket messages", s.socket.binMsgs < a.socket.binMsgs, R.extra.comparison);
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
