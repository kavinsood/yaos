// YAOS spike: worker-side message handler. Kept free of globals so it can be
// driven in node:test over a MessageChannel; spikeWorker.ts binds it to the
// real DedicatedWorkerGlobalScope. Nothing here may throw out of a handler:
// every failure is posted back as data.
import { runCryptoProbe, type CryptoProbeOptions, type CryptoProbeReport } from "./cryptoProbe";
import { runIdbProbe } from "./idbProbe";
import { defaultNow, errInfo, r1, settle, toStep, type ErrInfo, type WorkerSelfReport } from "./report";

export type MainToSpike =
	| { type: "ping"; id: number; t: number }
	| { type: "probe"; id: number; idbTimeoutMs?: number }
	| { type: "echo"; id: number; buf: ArrayBuffer }
	| { type: "crypto"; id: number; opts?: Omit<CryptoProbeOptions, "where"> };

export type SpikeToMain =
	| { type: "boot"; workerNow: number }
	| { type: "pong"; id: number; t: number; workerNow: number }
	| { type: "probeResult"; id: number; report: WorkerSelfReport }
	| { type: "cryptoResult"; id: number; report: CryptoProbeReport }
	| { type: "echo"; id: number; buf: ArrayBuffer | null; receivedBytes: number; patternOk: boolean }
	| { type: "echoAfter"; id: number; byteLengthAfterPost: number | null; postError?: ErrInfo }
	| { type: "workerError"; source: string; error: ErrInfo; detail?: unknown }
	| { type: "error"; id?: number; error: ErrInfo };

export interface SpikeScopeLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface SpikeWorkerEnv {
	/** May throw (e.g. SecurityError in opaque origins). */
	getIndexedDB: () => IDBFactory | undefined;
	subtle?: SubtleCrypto;
	/** Bound to the worker's crypto; used by the E2EE crypto probe. */
	getRandomValues?: (a: Uint8Array) => Uint8Array;
	typeofWebSocket: string;
	typeofStructuredClone: string;
	typeofFetch: string;
	storage?: { persisted?: () => Promise<boolean> };
	userAgent?: string;
	hardwareConcurrency?: number;
	location?: string;
	now?: () => number;
}

/** Byte pattern used by the transfer echo: byte i = (i * 31) & 255. */
export function fillPattern(u8: Uint8Array): Uint8Array {
	for (let i = 0; i < u8.length; i++) u8[i] = (i * 31) & 255;
	return u8;
}

export function checkPattern(u8: Uint8Array): boolean {
	for (let i = 0; i < u8.length; i++) if (u8[i] !== ((i * 31) & 255)) return false;
	return true;
}

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function collectWorkerSelfReport(env: SpikeWorkerEnv, idbTimeoutMs = 4000): Promise<WorkerSelfReport> {
	const now = env.now ?? defaultNow;
	let typeofIndexedDB = "undefined";
	try {
		typeofIndexedDB = typeof env.getIndexedDB();
	} catch {
		typeofIndexedDB = "threw";
	}
	const idb = await runIdbProbe(env.getIndexedDB, { where: "worker", timeoutMs: idbTimeoutMs, now });
	const subtle = env.subtle;
	const digest = subtle
		? toStep(
				await settle(() => subtle.digest("SHA-256", new TextEncoder().encode("yaos")), 3000, now),
				(b) => toHex(b),
			)
		: { ok: false, ms: 0, skipped: true };
	const persistedFn = env.storage?.persisted;
	const storagePersisted: WorkerSelfReport["storagePersisted"] =
		typeof persistedFn === "function"
			? { present: true, result: toStep(await settle(() => persistedFn.call(env.storage), 3000, now), (v) => v) }
			: { present: false };
	const out: WorkerSelfReport = {
		typeofIndexedDB,
		idb,
		cryptoSubtle: { typeofSubtle: typeof subtle, digest },
		typeofWebSocket: env.typeofWebSocket,
		typeofStructuredClone: env.typeofStructuredClone,
		typeofFetch: env.typeofFetch,
		storagePersisted,
	};
	if (env.location !== undefined) out.location = env.location;
	if (env.userAgent !== undefined) out.userAgent = env.userAgent;
	if (env.hardwareConcurrency !== undefined) out.hardwareConcurrency = env.hardwareConcurrency;
	return out;
}

function isMsg(v: unknown): v is { type: string; id?: unknown } {
	return Boolean(v) && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

export function installSpikeWorker(scope: SpikeScopeLike, env: SpikeWorkerEnv): void {
	const now = env.now ?? defaultNow;
	const post = (msg: SpikeToMain, transfer: Transferable[] = []): ErrInfo | null => {
		try {
			scope.postMessage(msg, transfer);
			return null;
		} catch (e) {
			const error = errInfo(e);
			try {
				scope.postMessage({ type: "workerError", source: "postMessage", error } satisfies SpikeToMain, []);
			} catch {
				/* nothing left to report through */
			}
			return error;
		}
	};

	const handle = async (data: unknown): Promise<void> => {
		const id = isMsg(data) && typeof data.id === "number" ? data.id : undefined;
		try {
			if (!isMsg(data)) {
				post({ type: "error", error: { name: "BadMessage", message: `unexpected message: ${typeof data}` } });
				return;
			}
			const msg = data as MainToSpike;
			switch (msg.type) {
				case "ping":
					post({ type: "pong", id: msg.id, t: msg.t, workerNow: r1(now()) });
					return;
				case "probe": {
					const report = await collectWorkerSelfReport(env, msg.idbTimeoutMs);
					post({ type: "probeResult", id: msg.id, report });
					return;
				}
				case "crypto": {
					const report = await runCryptoProbe(
						{ subtle: env.subtle, getRandomValues: env.getRandomValues, getIndexedDB: env.getIndexedDB, now },
						{ ...msg.opts, where: "worker" },
					);
					post({ type: "cryptoResult", id: msg.id, report });
					return;
				}
				case "echo": {
					const buf = msg.buf instanceof ArrayBuffer ? msg.buf : null;
					const receivedBytes = buf ? buf.byteLength : -1;
					const patternOk = buf ? checkPattern(new Uint8Array(buf)) : false;
					const postError = post({ type: "echo", id: msg.id, buf, receivedBytes, patternOk }, buf ? [buf] : []);
					const after: SpikeToMain = { type: "echoAfter", id: msg.id, byteLengthAfterPost: buf ? buf.byteLength : null };
					if (postError) after.postError = postError;
					post(after);
					return;
				}
				default:
					post({ type: "error", id, error: { name: "UnknownType", message: `unknown message type ${String((data as { type: string }).type)}` } });
			}
		} catch (e) {
			post({ type: "error", id, error: errInfo(e, true) });
		}
	};

	scope.addEventListener("message", (ev) => {
		void handle((ev as MessageEvent).data);
	});
	scope.addEventListener("messageerror", () => {
		post({ type: "workerError", source: "messageerror", error: { name: "MessageError", message: "worker received a message that could not be deserialized" } });
	});
	scope.addEventListener("error", (ev) => {
		const e = ev as ErrorEvent;
		post({ type: "workerError", source: "error", error: errInfo(e.error ?? e.message, true), detail: { message: e.message, filename: e.filename, lineno: e.lineno } });
	});
	scope.addEventListener("unhandledrejection", (ev) => {
		post({ type: "workerError", source: "unhandledrejection", error: errInfo((ev as PromiseRejectionEvent).reason, true) });
	});
	post({ type: "boot", workerNow: r1(now()) });
}
