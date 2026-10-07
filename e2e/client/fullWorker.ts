/**
 * The engine thread of a FullClient on the worker carrier (fullKit.ts EngineThread): what the plugin's Blob-URL
 * worker runs (engine/workerMain.ts startWorkerEngine), on worker_threads. Each carrier is createEngine (carrier
 * "worker") over createWorkerEngineTransport on its MessagePort, with the ports fullKit gives the inline engine
 * (fullEnginePorts) over this thread's IndexedDB and net switch, which outlive the carriers (engine restarts).
 *
 * Diagnostics, never secrets: log lines; monitorEventLoopDelay({ resolution: 1 }) and a 1 ms heartbeat (probe);
 * engine-to-main posts of attachment-sized buffers, moved or copied; with workerData.events, APPENDs and relay
 * events (the net switch's session tap), blob put / get start and end, and heartbeat gaps, stamped absNow().
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { IDBFactory } from "fake-indexeddb";
import type { BlobPort } from "../../src/ports";
import { createEngine, type EngineHandle } from "../../src/engine/compose/protocolEngine";
import { createWorkerEngineTransport, type WorkerScopeLike } from "../../src/protocol/workerTransport";
import {
	absNow, ENGINE_GAP_EVENT_MS, fullEnginePorts, loopStats, NetSwitch, postCounted,
	type EngineThreadData, type EngineThreadEvent, type FromEngineThread, type LargePost, type ToEngineThread,
} from "./fullKit";

const port = parentPort;
if (!port) throw new Error("fullWorker.ts runs as a worker_threads Worker (fullKit.ts EngineThread)");
const { events } = workerData as EngineThreadData;
const send = (m: FromEngineThread) => port.postMessage(m);
const emit = (e: EngineThreadEvent) => {
	if (events) send({ t: "event", e });
};
const log = (line: string) => send({ t: "log", line });

const factory = new IDBFactory();
const net = new NetSwitch();
if (events) {
	net.tap = {
		append: (f) => emit({ kind: "append", at: absNow(), stream: f.stream, frameId: f.clientFrameId, bytes: f.payload.byteLength }),
		event: (e) => {
			const at = absNow();
			switch (e.t) {
				case "receipt":
				case "refused":
					emit({ kind: "relay", at, t: e.t, stream: e.stream, frameId: e.clientFrameId, deviceId: null });
					return;
				case "provisional":
				case "provisionalDropped":
					emit({ kind: "relay", at, t: e.t, stream: e.stream, frameId: e.clientFrameId, deviceId: e.deviceId });
					return;
				case "committed":
					emit({ kind: "relay", at, t: e.t, stream: e.frame.stream, frameId: e.frame.clientFrameId, deviceId: e.frame.deviceId });
					return;
				default:
					emit({ kind: "relay", at, t: e.t, stream: null, frameId: null, deviceId: null });
			}
		},
	};
}

/** Blob put / get, timed (events only). */
function timed(blob: BlobPort | null): BlobPort | null {
	if (!blob || !events) return blob;
	return new Proxy(blob, {
		get: (t, k, recv) => {
			const v = Reflect.get(t, k, recv) as unknown;
			if (typeof v !== "function" || (k !== "put" && k !== "get")) return v;
			const op = k;
			return (...a: unknown[]) => {
				const sent = op === "put" ? (a[1] as readonly Uint8Array[]).reduce((n, p) => n + p.byteLength, 0) : 0;
				emit({ kind: "blob", at: absNow(), op, phase: "start", bytes: sent, error: null });
				const p = (v as (...x: unknown[]) => Promise<unknown>).apply(t, a);
				p.then(
					(r) => emit({ kind: "blob", at: absNow(), op, phase: "end", bytes: op === "get" && r instanceof Uint8Array ? r.byteLength : sent, error: null }),
					(err: unknown) => emit({ kind: "blob", at: absNow(), op, phase: "error", bytes: sent, error: err instanceof Error ? err.message : String(err) }),
				);
				return p;
			};
		},
	});
}

const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
let beat = performance.now();
let maxGap = 0;
setInterval(() => {
	const now = performance.now();
	const gap = now - beat;
	beat = now;
	if (gap > maxGap) maxGap = gap;
	if (gap >= ENGINE_GAP_EVENT_MS) emit({ kind: "gap", at: absNow(), ms: gap });
}, 1).unref();

const posts: LargePost[] = [];
const engines = new Map<number, { readonly handle: EngineHandle; readonly port: MessagePort }>();

port.on("message", (m: ToEngineThread) => {
	switch (m.t) {
		case "carrier": {
			const p = m.port;
			const scope: WorkerScopeLike = {
				postMessage: (message, transfer) => {
					for (const x of postCounted("engine-to-main", message, () => p.postMessage(message, transfer as ArrayBuffer[]))) {
						posts.push(x);
						emit(x);
					}
				},
				addEventListener: (type: string, listener: (ev: { readonly data: unknown }) => void) => {
					if (type === "message") p.on("message", (data: unknown) => listener({ data }));
					else p.on("messageerror", listener);
				},
				close: () => p.close(),
			};
			const handle = createEngine(createWorkerEngineTransport(scope), {
				carrier: "worker",
				clientVersion: "full-e2e",
				...(m.tuning ? { tuning: m.tuning } : {}),
				tzOffsetMinutes: () => 0,
				log,
				makePorts: async (config) => {
					const ports = await fullEnginePorts(config, { net, factory, log, onBlobKind: (kind) => send({ t: "blobKind", kind }) });
					const probe = ports.probeBlob;
					return { ...ports, blob: timed(ports.blob), ...(probe ? { probeBlob: async () => timed(await probe()) } : {}) };
				},
			});
			engines.set(m.id, { handle, port: p });
			return;
		}
		case "dispose": {
			const e = engines.get(m.id);
			if (!e) return;
			engines.delete(m.id);
			e.handle.dispose();
			e.port.close();
			return;
		}
		case "online":
			net.setOnline(m.online);
			return;
		case "probe": {
			const mem = process.memoryUsage();
			send({ t: "probe", rid: m.rid, value: { at: absNow(), loop: loopStats(loop), heartbeatMaxGapMs: Math.round(maxGap * 100) / 100,
				heapUsedBytes: mem.heapUsed, arrayBuffersBytes: mem.arrayBuffers, posts: [...posts] } });
			if (m.reset) {
				loop.reset();
				maxGap = 0;
			}
			return;
		}
	}
});
send({ t: "up" });
