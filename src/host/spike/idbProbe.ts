// YAOS spike: IndexedDB open/put/get/close/delete probe. Runs unchanged on the
// main thread (inline fallback path) and inside the Blob-URL worker. Every step
// has a timeout so a hang is reported as `hang: true` instead of stalling.
import { defaultNow, errInfo, r1, settle, skipped, toStep, type ErrInfo, type IdbProbeReport, type StepResult } from "./report";

export interface IdbProbeOptions {
	where: "main" | "worker";
	timeoutMs?: number;
	now?: () => number;
	name?: string;
}

const STORE = "kv";

function sampleRecord(): { text: string; n: number; bytes: Uint8Array; nested: { a: unknown[]; ok: boolean } } {
	return { text: "yaos spike ✓ héllo \u{1F9EA}", n: 42, bytes: Uint8Array.from([0, 1, 2, 127, 128, 250, 255]), nested: { a: [1, "two", null], ok: true } };
}

/** Structural equality for the sample record (Uint8Array compared byte by byte, cross-realm safe). */
export function recordsEqual(a: ReturnType<typeof sampleRecord>, b: unknown): boolean {
	if (!b || typeof b !== "object") return false;
	const o = b as { text?: unknown; n?: unknown; bytes?: unknown; nested?: unknown };
	if (o.text !== a.text || o.n !== a.n) return false;
	if (!ArrayBuffer.isView(o.bytes) || o.bytes.byteLength !== a.bytes.byteLength) return false;
	const got = new Uint8Array(o.bytes.buffer, o.bytes.byteOffset, o.bytes.byteLength);
	for (let i = 0; i < a.bytes.length; i++) if (got[i] !== a.bytes[i]) return false;
	return JSON.stringify(o.nested) === JSON.stringify(a.nested);
}

function reqError(req: { error: DOMException | null }, fallback: string): unknown {
	try {
		return req.error ?? new Error(fallback);
	} catch (e) {
		return e;
	}
}

export async function runIdbProbe(getFactory: () => IDBFactory | undefined, opts: IdbProbeOptions): Promise<IdbProbeReport> {
	const now = opts.now ?? defaultNow;
	const timeoutMs = opts.timeoutMs ?? 4000;
	const t0 = now();
	const dbName = opts.name ?? `yaos-spike-probe-${Math.random().toString(36).slice(2, 10)}`;
	const report: IdbProbeReport = {
		where: opts.where,
		typeofIndexedDB: "undefined",
		dbName,
		open: skipped(),
		put: skipped(),
		get: skipped(),
		equal: null,
		close: skipped(),
		deleteDatabase: skipped(),
		ok: false,
		totalMs: 0,
	};
	let factory: IDBFactory | undefined;
	try {
		factory = getFactory();
		report.typeofIndexedDB = typeof factory;
	} catch (e) {
		report.typeofIndexedDB = "threw";
		report.accessError = errInfo(e);
	}
	if (!factory) {
		report.totalMs = r1(now() - t0);
		return report;
	}
	const f = factory;
	try {
		report.hasDatabasesFn = typeof f.databases === "function";
	} catch {
		report.hasDatabasesFn = false;
	}

	// open (creates the object store in onupgradeneeded)
	let upgradeFired = false;
	let upgradeError: ErrInfo | undefined;
	let blocked = false;
	const pending: { req: IDBOpenDBRequest | null } = { req: null };
	const opened = await settle(
		() =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const req = f.open(dbName, 1);
				pending.req = req;
				req.onupgradeneeded = () => {
					upgradeFired = true;
					try {
						req.result.createObjectStore(STORE);
					} catch (e) {
						upgradeError = errInfo(e);
					}
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(reqError(req, "open failed"));
				req.onblocked = () => {
					blocked = true;
				};
			}),
		timeoutMs,
		now,
	);
	report.open = { ...toStep(opened), upgradeFired, blocked };
	if (upgradeError) report.open.upgradeError = upgradeError;
	const late = pending.req;
	if (opened.kind === "hang" && late) {
		// If the open completes after we gave up, close it so deleteDatabase is not blocked forever.
		late.onsuccess = () => {
			try {
				late.result.close();
			} catch {
				/* ignore */
			}
		};
	}

	if (opened.kind === "ok") {
		const db = opened.value;
		const record = sampleRecord();
		report.put = toStep(
			await settle(
				() =>
					new Promise<void>((resolve, reject) => {
						const tx = db.transaction(STORE, "readwrite");
						tx.oncomplete = () => resolve();
						tx.onerror = () => reject(reqError(tx, "put transaction error"));
						tx.onabort = () => reject(reqError(tx, "put transaction aborted"));
						tx.objectStore(STORE).put(record, "k1");
					}),
				timeoutMs,
				now,
			),
		);
		if (report.put.ok) {
			const got = await settle(
				() =>
					new Promise<unknown>((resolve, reject) => {
						const tx = db.transaction(STORE, "readonly");
						const req = tx.objectStore(STORE).get("k1");
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(reqError(req, "get error"));
						tx.onabort = () => reject(reqError(tx, "get transaction aborted"));
					}),
				timeoutMs,
				now,
			);
			report.get = toStep(got);
			report.equal = got.kind === "ok" ? recordsEqual(record, got.value) : null;
		}
		report.close = toStep(await settle(() => db.close(), timeoutMs, now));
	}

	// Always try to delete: also cleans up after a failed/hung open.
	let delBlocked = false;
	const del: StepResult = toStep(
		await settle(
			() =>
				new Promise<void>((resolve, reject) => {
					const req = f.deleteDatabase(dbName);
					req.onsuccess = () => resolve();
					req.onerror = () => reject(reqError(req, "deleteDatabase error"));
					req.onblocked = () => {
						delBlocked = true;
					};
				}),
			timeoutMs,
			now,
		),
	);
	report.deleteDatabase = { ...del, blocked: delBlocked };
	report.ok = report.open.ok && report.put.ok && report.get.ok && report.equal === true;
	report.totalMs = r1(now() - t0);
	return report;
}
