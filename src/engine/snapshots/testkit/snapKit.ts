/**
 * Test doubles for the snapshot job tests: in-memory side files, one relay's snap stream folded in memory (shared
 * by several devices), a blob store whose stored objects and transport can be faulted, and a sealing crypto port
 * (XOR seal, prefixed addresses) that proves parts go through the attachments' blob path.
 */
import { sha256Hex } from "../../../core/hash/sha256";
import { applySnapOp, newSnapFold } from "../../../core/snap/fold";
import type { SnapOp } from "../../../core/snap/record";
import { kindOfPath, type ContentHash, type DeviceId, type VaultPath } from "../../../core/types";
import type { BlobPort } from "../../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../../ports/crypto";
import type { SideFileName, SideFilePort } from "../../../ports/vault";
import { World } from "../../reconcile/testkit/world";
import { SnapshotJob, type SnapshotDeps } from "../snapshotJob";

export class MemSide implements SideFilePort {
	readonly files = new Map<string, Uint8Array>();
	async read(n: SideFileName) { return this.files.get(n)?.slice() ?? null; }
	async write(n: SideFileName, b: Uint8Array) { this.files.set(n, b.slice()); }
	async remove(n: SideFileName) { this.files.delete(n); }
	async list(prefix: "snapshots/") { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort() as SideFileName[]; }
	names(suffix: string): string[] { return [...this.files.keys()].filter((k) => k.endsWith(suffix)).sort(); }
}

/** One relay's snap stream, folded as rows arrive; `port(self)` is one device's SnapIndexPort over it. */
export class MemIndex {
	readonly state = newSnapFold();
	ready = true;
	readonly submitted: { readonly self: DeviceId; readonly ops: readonly SnapOp[] }[] = [];
	port(self: DeviceId) {
		return {
			self,
			view: () => ({ state: this.state, ready: this.ready }),
			submit: async (ops: readonly SnapOp[]) => {
				this.submitted.push({ self, ops });
				for (const op of ops) applySnapOp(this.state, self, op);
			},
		};
	}
	puts(): number { return this.submitted.flatMap((s) => s.ops).filter((o) => o.t === "put").length; }
}

/** Blob store with faults: `failPut` throws like a network error; `onGet` may alter or drop what is served. */
export class FaultyStore implements BlobPort {
	readonly objects = new Map<BlobAddress, Uint8Array>();
	readonly calls = { has: 0, put: 0, get: 0 };
	failPut: ((address: BlobAddress, nth: number) => boolean) | null = null;
	onGet: ((address: BlobAddress, bytes: Uint8Array) => Uint8Array | null) | null = null;
	constructor(readonly maxBlobBytes = 10 * 1024 * 1024) {}
	async has(addresses: readonly BlobAddress[]) {
		this.calls.has++;
		return new Set(addresses.filter((a) => this.objects.has(a)));
	}
	async put(address: BlobAddress, bytes: Uint8Array) {
		const nth = this.calls.put++;
		if (this.failPut?.(address, nth)) throw new Error("blob put: network_error");
		this.objects.set(address, bytes.slice());
	}
	async get(address: BlobAddress) {
		this.calls.get++;
		const b = this.objects.get(address);
		if (!b) return null;
		return this.onGet ? this.onGet(address, b.slice()) : b.slice();
	}
}

const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
/** Keyed-looking blob address (64 hex like the relay's blob routes require), not the plain sha256. */
export const addressOf = (h: ContentHash) => sha256Hex(new TextEncoder().encode(`addr:${h}`)) as BlobAddress;
export const sealingCrypto = {
	suite: 0, keyEpoch: 0,
	seal: async () => { throw new Error("unused"); }, open: async () => { throw new Error("unused"); },
	sealBlob: async (b: Uint8Array) => xor(b), openBlob: async (b: Uint8Array) => xor(b),
	blobAddress: async (h: ContentHash) => addressOf(h),
} as unknown as CryptoPort;

export const DEV_A = "dev-A-0000000000000" as DeviceId;
export const DEV_B = "dev-B-0000000000000" as DeviceId;
export const P = (s: string): VaultPath => s as VaultPath;
export const DAY = 24 * 60 * 60 * 1000;

export interface DevOptions {
	readonly label?: string;
	readonly self?: DeviceId;
	readonly index?: MemIndex | null;
	readonly store?: BlobPort | null;
	readonly keepDaily?: number;
	readonly enabled?: boolean;
	readonly upload?: boolean;
	readonly partBytes?: number;
	readonly files?: SnapshotDeps["files"];
}

export function device(o: DevOptions = {}) {
	const w = new World();
	const side = new MemSide();
	const notices: { level: string; code: string; message: string }[] = [];
	const diags: string[] = [];
	const settings = { enabled: o.enabled ?? true, keepDaily: o.keepDaily ?? 7, uploadToBlobStore: o.upload ?? true };
	const remote = o.store && o.index ? { store: o.store, index: o.index.port(o.self ?? DEV_A) } : null;
	const job = new SnapshotJob({
		disk: w.gateway, side, clock: w.clock, crypto: sealingCrypto, settings: () => settings, remote, deviceLabel: o.label ?? "laptop",
		files: o.files ?? (() => w.vault.paths().filter((p) => !p.startsWith(".")).map((p) => ({ path: P(p), kind: kindOfPath(P(p)), size: w.vault.bytesOf(p)!.length }))),
		notice: (level, code, message) => notices.push({ level, code, message: message ?? "" }),
		diag: (l) => diags.push(l),
		...(o.partBytes ? { partBytes: o.partBytes } : {}),
	});
	return { w, side, job, notices, diags, settings };
}

/** Deterministic incompressible bytes (so a small part size really yields several parts). */
export function noise(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
	return b;
}
