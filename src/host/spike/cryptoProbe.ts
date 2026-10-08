// YAOS spike: E2EE platform probe for the suite-1 design (docs/client-remake/e2ee-design.md).
// Runs unchanged inside the Blob-URL worker and on the main thread (the day-1 inline fallback's realm):
//   getRandomValues; importKey(extractable:false) + exportKey refusal; HKDF (RFC 5869 A.1),
//   HMAC-SHA-256 (RFC 4231 4.3) and AES-256-GCM (GCM spec test case 16) known answers;
//   AES-GCM tamper / wrong-AAD / wrong-nonce rejection; a non-extractable CryptoKey stored in
//   IndexedDB (structured clone), read back after close+reopen and still usable; and
//   AES-256-GCM seal/open timing at 1 KiB / 64 KiB / 1 MiB.
// Key material is public test vectors or fresh random keys that never leave the probe.
import { defaultNow, errInfo, settle, skipped, toStep, type ErrInfo, type StepResult } from "./report";

export interface CryptoProbeEnv {
	subtle?: SubtleCrypto;
	/** Must be bound to its crypto object (an unbound getRandomValues throws "Illegal invocation"). */
	getRandomValues?: (a: Uint8Array) => Uint8Array;
	/** May throw (SecurityError in opaque origins). */
	getIndexedDB: () => IDBFactory | undefined;
	now?: () => number;
}

export interface CryptoProbeOptions {
	where: "main" | "worker";
	stepTimeoutMs?: number;
	/** Minimum measuring time per size and per operation. */
	benchMs?: number;
	benchMaxIters?: number;
	sizes?: number[];
	dbName?: string;
}

export interface BenchRow {
	bytes: number;
	iters: number;
	firstSealMs: number;
	sealMeanMs: number;
	sealP50Ms: number;
	sealMiBps: number;
	openMeanMs: number;
	openP50Ms: number;
	openMiBps: number;
}

export interface CryptoProbeReport {
	where: "main" | "worker";
	typeofSubtle: string;
	typeofGetRandomValues: string;
	random: StepResult;
	importNonExtractable: StepResult;
	hkdf: StepResult;
	hmac: StepResult;
	aesGcm: StepResult;
	idbKey: StepResult & { deleteDatabase?: StepResult };
	bench: { ok: boolean; rows: BenchRow[]; error?: ErrInfo; hang?: boolean; skipped?: boolean };
	/** Every step above passed its checks. */
	ok: boolean;
	totalMs: number;
}

export const BENCH_SIZES = [1024, 64 * 1024, 1024 * 1024];

// RFC 5869 Appendix A.1 (HKDF-SHA-256, test case 1).
const HKDF_A1 = { ikm: "0b".repeat(22), salt: "000102030405060708090a0b0c", info: "f0f1f2f3f4f5f6f7f8f9", okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865" };
// RFC 4231 section 4.3 (HMAC-SHA-256, test case 2: key "Jefe").
const HMAC_TC2 = { key: "4a656665", data: "7768617420646f2079612077616e7420666f72206e6f7468696e673f", mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" };
// McGrew & Viega, "The Galois/Counter Mode of Operation (GCM)", test case 16 (AES-256, 96-bit IV, AAD).
const GCM_TC16 = {
	key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
	iv: "cafebabefacedbaddecaf888",
	aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
	pt: "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
	ctTag: "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b",
};

export function toHex(u8: Uint8Array): string {
	return Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Error name of a rejected call, or "accepted" when it resolved (a failed security check). */
async function rejection(run: () => Promise<unknown> | unknown): Promise<string> {
	try {
		await run();
		return "accepted";
	} catch (e) {
		return errInfo(e).name;
	}
}

async function check<T>(timeoutMs: number, now: () => number, run: () => Promise<T>, pass: (v: T) => boolean): Promise<StepResult> {
	const s = await settle(run, timeoutMs, now);
	const out = toStep(s, (v) => v);
	if (s.kind === "ok" && !pass(s.value)) out.ok = false;
	return out;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error ?? new Error("IDB request failed"));
	});
}

function openDb(f: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const r = f.open(name, 1);
		r.onupgradeneeded = () => r.result.createObjectStore("keys");
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error ?? new Error("open failed"));
		r.onblocked = () => reject(new Error("open blocked"));
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("transaction error"));
		tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
	});
}

function p50(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s[(s.length - 1) >> 1] ?? 0) : 0;
}

export async function runCryptoProbe(env: CryptoProbeEnv, opts: CryptoProbeOptions): Promise<CryptoProbeReport> {
	const now = env.now ?? defaultNow;
	const T = opts.stepTimeoutMs ?? 8000;
	const t0 = now();
	const subtle = env.subtle;
	const grv = env.getRandomValues;
	const report: CryptoProbeReport = {
		where: opts.where,
		typeofSubtle: typeof subtle,
		typeofGetRandomValues: typeof grv,
		random: skipped("no getRandomValues"),
		importNonExtractable: skipped("no crypto.subtle"),
		hkdf: skipped("no crypto.subtle"),
		hmac: skipped("no crypto.subtle"),
		aesGcm: skipped("no crypto.subtle"),
		idbKey: skipped("no crypto.subtle"),
		bench: { ok: false, rows: [], skipped: true },
		ok: false,
		totalMs: 0,
	};
	const finish = (): CryptoProbeReport => {
		const steps = [report.random, report.importNonExtractable, report.hkdf, report.hmac, report.aesGcm, report.idbKey];
		report.ok = steps.every((s) => s.ok) && report.bench.ok;
		report.totalMs = r3(now() - t0);
		return report;
	};

	if (grv) {
		report.random = await check(
			T,
			now,
			async () => {
				const a = grv(new Uint8Array(32));
				const b = grv(new Uint8Array(32));
				const max = grv(new Uint8Array(65536));
				return { distinct: !sameBytes(a, b), nonZero: a.some((x) => x !== 0), max65536Ok: max.length === 65536, over65536: await rejection(() => grv(new Uint8Array(65537))) };
			},
			(v) => v.distinct && v.nonZero && v.max65536Ok,
		);
	}
	if (!subtle) return finish();
	const nonce = (): Uint8Array => (grv ? grv(new Uint8Array(12)) : fromHex(GCM_TC16.iv));

	report.importNonExtractable = await check(
		T,
		now,
		async () => {
			const k = await subtle.importKey("raw", fromHex(GCM_TC16.key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
			return {
				extractable: k.extractable,
				type: k.type,
				exportRaw: await rejection(() => subtle.exportKey("raw", k)),
				exportJwk: await rejection(() => subtle.exportKey("jwk", k)),
				hkdfExtractableTrue: await rejection(() => subtle.importKey("raw", fromHex(HKDF_A1.ikm), "HKDF", true, ["deriveKey"])),
			};
		},
		(v) => v.extractable === false && v.exportRaw !== "accepted" && v.exportJwk !== "accepted",
	);

	const derived: { aes: CryptoKey | null } = { aes: null };
	report.hkdf = await check(
		T,
		now,
		async () => {
			const base = await subtle.importKey("raw", fromHex(HKDF_A1.ikm), "HKDF", false, ["deriveBits", "deriveKey"]);
			const bits = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: fromHex(HKDF_A1.salt), info: fromHex(HKDF_A1.info) }, base, 42 * 8));
			const params = (info: string): HkdfParams => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) });
			const aes = await subtle.deriveKey(params("yaos-spike/aes"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
			const mac = await subtle.deriveKey(params("yaos-spike/hmac"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
			derived.aes = aes;
			return { rfc5869A1: toHex(bits) === HKDF_A1.okm, derivedAesExtractable: aes.extractable, derivedHmacExtractable: mac.extractable, derivedHmacTagBytes: (await subtle.sign("HMAC", mac, utf8("x"))).byteLength };
		},
		(v) => v.rfc5869A1 && v.derivedAesExtractable === false && v.derivedHmacExtractable === false && v.derivedHmacTagBytes === 32,
	);

	report.hmac = await check(
		T,
		now,
		async () => {
			const k = await subtle.importKey("raw", fromHex(HMAC_TC2.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
			const tag = new Uint8Array(await subtle.sign("HMAC", k, fromHex(HMAC_TC2.data)));
			const bad = tag.slice();
			bad[0] = (bad[0] ?? 0) ^ 1;
			return { rfc4231Tc2: toHex(tag) === HMAC_TC2.mac, verifyGood: await subtle.verify("HMAC", k, tag, fromHex(HMAC_TC2.data)), verifyFlipped: await subtle.verify("HMAC", k, bad, fromHex(HMAC_TC2.data)) };
		},
		(v) => v.rfc4231Tc2 && v.verifyGood && !v.verifyFlipped,
	);

	report.aesGcm = await check(
		T,
		now,
		async () => {
			const k = await subtle.importKey("raw", fromHex(GCM_TC16.key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
			const p = { name: "AES-GCM", iv: fromHex(GCM_TC16.iv), additionalData: fromHex(GCM_TC16.aad), tagLength: 128 };
			const ct = new Uint8Array(await subtle.encrypt(p, k, fromHex(GCM_TC16.pt)));
			const pt = new Uint8Array(await subtle.decrypt(p, k, fromHex(GCM_TC16.ctTag)));
			const flip = (i: number): Uint8Array => {
				const c = ct.slice();
				c[i] = (c[i] ?? 0) ^ 1;
				return c;
			};
			const iv2 = fromHex(GCM_TC16.iv);
			iv2[0] = (iv2[0] ?? 0) ^ 1;
			const msg = utf8("yaos spike round trip");
			const rtKey = derived.aes ?? k;
			const rtIv = nonce();
			const rt = await subtle.encrypt({ name: "AES-GCM", iv: rtIv, additionalData: utf8("aad") }, rtKey, msg);
			const back = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: rtIv, additionalData: utf8("aad") }, rtKey, rt));
			return {
				gcmTc16Encrypt: toHex(ct) === GCM_TC16.ctTag,
				gcmTc16Decrypt: toHex(pt) === GCM_TC16.pt,
				overheadBytes: ct.length - fromHex(GCM_TC16.pt).length,
				roundTrip: sameBytes(back, msg),
				tamperCiphertext: await rejection(() => subtle.decrypt(p, k, flip(0))),
				tamperTag: await rejection(() => subtle.decrypt(p, k, flip(ct.length - 1))),
				wrongAad: await rejection(() => subtle.decrypt({ ...p, additionalData: utf8("other") }, k, ct)),
				wrongNonce: await rejection(() => subtle.decrypt({ ...p, iv: iv2 }, k, ct)),
			};
		},
		(v) => v.gcmTc16Encrypt && v.gcmTc16Decrypt && v.roundTrip && [v.tamperCiphertext, v.tamperTag, v.wrongAad, v.wrongNonce].every((r) => r !== "accepted"),
	);

	report.idbKey = await runIdbKeyStep(env, subtle, derived.aes, nonce, opts.dbName, T, now);
	report.bench = await runBench(subtle, derived.aes, nonce, opts, now);
	return finish();
}

interface IdbKeyValue {
	keySource: "hkdf-derived" | "generateKey";
	storedType: string;
	isCryptoKey: boolean;
	extractable?: boolean;
	algorithm?: string;
	usages?: string[];
	opensOldCiphertext?: boolean;
	sealsForOriginal?: boolean;
	exportRaw?: string;
}

/** Put a non-extractable AES-GCM key in IndexedDB, close, reopen, read it back and use it both ways. */
async function runIdbKeyStep(
	env: CryptoProbeEnv,
	subtle: SubtleCrypto,
	derivedKey: CryptoKey | null,
	nonce: () => Uint8Array,
	dbName: string | undefined,
	T: number,
	now: () => number,
): Promise<CryptoProbeReport["idbKey"]> {
	let f: IDBFactory | undefined;
	try {
		f = env.getIndexedDB();
	} catch (e) {
		return { ...skipped("indexedDB access threw"), error: errInfo(e) };
	}
	if (!f) return skipped("no indexedDB");
	const factory = f;
	const name = dbName ?? `yaos-spike-crypto-${Math.random().toString(36).slice(2, 10)}`;
	const state = { abandoned: false, open: [] as IDBDatabase[] };
	const openTracked = async (): Promise<IDBDatabase> => {
		const db = await openDb(factory, name);
		if (state.abandoned) db.close();
		else state.open.push(db);
		return db;
	};
	const step: CryptoProbeReport["idbKey"] = await check<IdbKeyValue>(
		T,
		now,
		async () => {
			const keySource = derivedKey ? "hkdf-derived" : "generateKey";
			const key = derivedKey ?? (await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
			const iv = nonce();
			const msg = utf8("sealed before the key went into IndexedDB");
			const sealed = await subtle.encrypt({ name: "AES-GCM", iv }, key, msg);
			const db1 = await openTracked();
			const tx = db1.transaction("keys", "readwrite");
			const done = txDone(tx);
			tx.objectStore("keys").put({ key, label: "yaos-spike" }, "k");
			await done;
			db1.close();
			const db2 = await openTracked();
			const got: unknown = await req(db2.transaction("keys", "readonly").objectStore("keys").get("k"));
			db2.close();
			const stored = got && typeof got === "object" ? (got as { key?: unknown }).key : undefined;
			const storedType = Object.prototype.toString.call(stored);
			if (storedType !== "[object CryptoKey]") return { keySource, storedType, isCryptoKey: false };
			const ck = stored as CryptoKey;
			const opened = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, ck, sealed));
			const iv2 = nonce();
			const resealed = await subtle.encrypt({ name: "AES-GCM", iv: iv2 }, ck, msg);
			const reopened = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: iv2 }, key, resealed));
			return {
				keySource,
				storedType,
				isCryptoKey: true,
				extractable: ck.extractable,
				algorithm: ck.algorithm.name,
				usages: [...ck.usages].sort(),
				opensOldCiphertext: sameBytes(opened, msg),
				sealsForOriginal: sameBytes(reopened, msg),
				exportRaw: await rejection(() => subtle.exportKey("raw", ck)),
			};
		},
		(v) => v.isCryptoKey && v.extractable === false && v.opensOldCiphertext === true && v.sealsForOriginal === true && v.exportRaw !== "accepted",
	);
	state.abandoned = true;
	for (const db of state.open) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
	step.deleteDatabase = toStep(await settle(() => req(factory.deleteDatabase(name)), T, now));
	return step;
}

async function timeLoop(run: () => Promise<unknown>, minMs: number, maxIters: number, now: () => number): Promise<{ times: number[]; total: number }> {
	const times: number[] = [];
	const t0 = now();
	while ((now() - t0 < minMs || times.length < 3) && times.length < maxIters) {
		const s = now();
		await run();
		times.push(now() - s);
	}
	return { times, total: now() - t0 };
}

/** AES-256-GCM seal (fresh 96-bit nonce + 64-byte AAD) and open, per size. */
async function runBench(subtle: SubtleCrypto, key: CryptoKey | null, nonce: () => Uint8Array, opts: CryptoProbeOptions, now: () => number): Promise<CryptoProbeReport["bench"]> {
	const sizes = opts.sizes ?? BENCH_SIZES;
	const benchMs = opts.benchMs ?? 300;
	const maxIters = opts.benchMaxIters ?? 2000;
	const rows: BenchRow[] = [];
	const mbps = (bytes: number, ms: number): number => (ms > 0 ? Math.round((bytes / 1048576 / (ms / 1000)) * 10) / 10 : 0);
	const s = await settle(
		async () => {
			const k = key ?? (await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
			const aad = new Uint8Array(64).fill(0x61);
			for (const bytes of sizes) {
				const data = new Uint8Array(bytes);
				for (let i = 0; i < bytes; i++) data[i] = (i * 31) & 255;
				const seal = (iv: Uint8Array): Promise<ArrayBuffer> => subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, k, data);
				const t = now();
				const iv0 = nonce();
				const sealed = await seal(iv0);
				const firstSealMs = now() - t;
				const sl = await timeLoop(() => seal(nonce()), benchMs, maxIters, now);
				const op = await timeLoop(() => subtle.decrypt({ name: "AES-GCM", iv: iv0, additionalData: aad }, k, sealed), benchMs, maxIters, now);
				const sealMean = sl.total / sl.times.length;
				const openMean = op.total / op.times.length;
				rows.push({
					bytes,
					iters: sl.times.length,
					firstSealMs: r3(firstSealMs),
					sealMeanMs: r3(sealMean),
					sealP50Ms: r3(p50(sl.times)),
					sealMiBps: mbps(bytes, sealMean),
					openMeanMs: r3(openMean),
					openP50Ms: r3(p50(op.times)),
					openMiBps: mbps(bytes, openMean),
				});
			}
		},
		Math.max(opts.stepTimeoutMs ?? 8000, sizes.length * (benchMs * 2 + 10000)),
		now,
	);
	if (s.kind === "ok") return { ok: rows.length === sizes.length, rows };
	if (s.kind === "hang") return { ok: false, rows, hang: true };
	return { ok: false, rows, error: s.error };
}
