/**
 * The engine side of a blob GC sweep ("Clean up unused server attachments", e2ee-design §10.4): the
 * preconditions and the live set for blobs/gc.ts, run in the worker by the writer engine. One sweep at a time;
 * stop() aborts a running one.
 *
 * Preconditions (any failure: zero deletes, a refusal with its reason):
 *  - the vault has a blob store (ports.blob: VAULT_READY attachments capability, adapters/httpBlob.ts);
 *  - suite 1: a sealing epoch is pinned and verified, and so is K_1 (addresses are HMAC(kAddr of K_1));
 *  - the write gate open (writeGate.ts): a revoked device, or one behind a newer winner it has no key for, reads
 *    rows it cannot open and is refused "keys-unverified" before it lists (its deletes would be refused anyway);
 *  - a relay session, writable;
 *  - suite 1: this session's `k` read done (KeyringRuntime.sendReady). Before it every row is held (§14.3 kComplete),
 *    so the sweep's own ns / cfg / snap reads would halt the folds on rows this device opens a moment later;
 *  - ns / cfg / snap read to the relay's head now, in this session (SessionLoop.readFresh), and not stale;
 *  - no quarantined ns / cfg / snap row, and every fold complete: not halted, its snapshot decodes, every tail row opened, decodes, is
 *    folded, and (snap) names no record version this reader does not know (FoldRuntime.gap);
 *  - every body row the relay still serves opens for this reader (blobs/bodyRefs.ts).
 *
 * Live hashes: every ns entry's blob (tombstones included, until pruned), cfg file blobs and snap record parts
 * (blobs/touch.ts committedBlobHashes); every own outbox frame's (frameBlobHashes; a bodyUpdateRef: the sha256
 * of its full update); the blob queue's (pending and running transfers); and every bodyUpdateRef the relay
 * still serves on the body / canvas streams of every ns entry and of every stream this device has
 * (blobs/bodyRefs.ts).
 */

import { bytesToHex } from "../../core/codec/lib0";
import { CryptoSuite } from "../../core/envelope";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, docStream, streamClass, type ContentHash, type Seq, type StreamName } from "../../core/types";
import { scanBodyRefs } from "../blobs/bodyRefs";
import { gcRefused, sweepBlobs, type GcMark, type GcOutcome } from "../blobs/gc";
import { committedBlobHashes, frameBlobHashes } from "../blobs/touch";
import type { EngineCtx } from "./context";

type Refusal = Extract<GcMark, { ok: false }>;
type Marked = Extract<GcMark, { ok: true }> & { readonly through: Map<StreamName, Seq>; readonly own: Map<ContentHash, Uint8Array> };

const refuse = (refused: Refusal["refused"], detail: string): Refusal => ({ ok: false, refused, detail });

export class BlobGc {
	private running: { readonly ctrl: AbortController; readonly done: Promise<GcOutcome> } | null = null;

	constructor(private readonly c: EngineCtx) {}

	/** One sweep. `queued`: hashes local transfers still need (BlobQueue.liveHashes). */
	run(queued: () => Iterable<ContentHash>): Promise<GcOutcome> {
		if (this.running) return Promise.resolve(gcRefused("busy", "a clean-up is already running"));
		const ctrl = new AbortController();
		const done = this.sweep(queued, ctrl.signal).then((out) => {
			if (out.refused !== null && out.refused !== "interrupted") this.c.diag("blob-gc-refused", { refused: out.refused, detail: out.detail });
			return out;
		}).finally(() => {
			if (this.running?.ctrl === ctrl) this.running = null;
		});
		this.running = { ctrl, done };
		return done;
	}

	async stop(): Promise<void> {
		const r = this.running;
		if (!r) return;
		r.ctrl.abort();
		await r.done.catch(() => undefined);
	}

	private async sweep(queued: () => Iterable<ContentHash>, signal: AbortSignal): Promise<GcOutcome> {
		const c = this.c;
		const pre = this.preconditions();
		if (pre) return gcRefused(pre.refused, pre.detail);
		// The write-gated ports (context.ts): the probe PUT, the deletes and an R4 re-upload all pass the gate.
		const store = c.deps.blob!;
		let first: Marked | null = null;
		let own = new Map<ContentHash, Uint8Array>();
		const out = await sweepBlobs({
			store, crypto: c.deps.crypto, hash: c.ports.hash, clock: c.ports.clock, random: c.ports.random,
			graceMs: c.tuning.blobGcGraceMs, signal, policy: c.touch,
			mark: async () => {
				const m = await this.mark(queued, signal, undefined);
				if (m.ok) {
					first = m;
					own = m.own;
				}
				return m;
			},
			remark: async () => {
				const m = await this.mark(queued, signal, first?.through);
				if (m.ok) for (const [h, b] of m.own) own.set(h, b);
				return m;
			},
			bytes: async (h) => own.get(h) ?? (await c.opts.blobBytes?.(h)) ?? null,
			diag: (code, fields) => c.diag(code, fields),
		});
		if (!c.stopped) {
			const now = c.now();
			await c.repo.pruneBlobPuts(now - c.tuning.blobGcGraceMs / 2, now).catch(() => 0);
		}
		return out;
	}

	private preconditions(): Refusal | null {
		const c = this.c;
		const { blob, crypto } = c.ports;
		if (!blob) return refuse("no-store", "this server has no attachment storage");
		if (crypto.suite !== CryptoSuite.none) {
			const e = crypto.sealEpoch();
			if (e < 1 || !crypto.keyState(e).verified || !crypto.keyState(1).verified) {
				return refuse("keys-unverified", "the vault's encryption key is not confirmed on this device");
			}
		}
		const shut = c.gate();
		if (shut !== null) return refuse("keys-unverified", `this device may not write to the vault (${shut})`);
		if (!c.session || c.stopped) return refuse("offline", "not connected to the server");
		if (c.readOnly || !c.session.canWrite) return refuse("read-only", "this device has read-only access");
		if (!c.keyring.sendReady()) return refuse("not-caught-up", "the vault's key records are not read on this connection yet");
		return null;
	}

	/** Preconditions and the live set; `from` (an earlier mark's through): body refs only of rows since (R4). */
	private async mark(queued: () => Iterable<ContentHash>, signal: AbortSignal, from: ReadonlyMap<StreamName, Seq> | undefined): Promise<Marked | Refusal> {
		const c = this.c;
		const pre = this.preconditions();
		if (pre) return pre;
		const folds = [NS_STREAM, CFG_STREAM, SNAP_STREAM];
		if (!(await c.sess.readFresh(folds))) return refuse("not-caught-up", "could not read the vault's file list from the server just now");
		for (const s of folds) {
			if (c.repo.stream(s)?.stale === 1) return refuse("not-caught-up", `${s} is behind the server`);
			const q = await c.repo.quarantineOf(s);
			if (q.length > 0) return refuse("fold-incomplete", `${s} row ${q[0]!.seq}: quarantined (${q[0]!.reason})`);
		}
		for (const rt of [c.ns, c.cfg, c.snap]) {
			const g = await rt.gap();
			if (g) return refuse("fold-incomplete", `${rt.stream} row ${g.seq}: ${g.reason}`);
		}
		const committed = committedBlobHashes(c.ns.state, c.cfg.state, c.snap.state);
		const live = new Set(committed);
		const own = new Map<ContentHash, Uint8Array>();
		for (const rec of c.outbox.values()) {
			const refs = frameBlobHashes(rec);
			if (refs !== "bodyRef") {
				for (const h of refs) live.add(h);
				continue;
			}
			const h = bytesToHex(await c.ports.hash.sha256(rec.content)) as ContentHash;
			live.add(h);
			own.set(h, rec.content);
		}
		for (const h of queued()) live.add(h);
		const streams = new Set<StreamName>();
		for (const e of c.ns.state.entries.values()) {
			const s = docStream(e.kind, e.docId);
			if (s) streams.add(s);
		}
		for (const r of c.repo.streams()) {
			const cls = streamClass(r.stream);
			if (cls === "body" || cls === "canvas") streams.add(r.stream);
		}
		const session = c.session;
		if (!session) return refuse("offline", "not connected to the server");
		const scan = await scanBodyRefs({ session, crypto: c.ports.crypto, vaultId: c.opts.vaultId, signal, yieldNow: () => c.ports.clock.yieldNow() }, streams, from);
		if (!scan.ok) return refuse("body-unreadable", `a note's history row ${scan.seq} does not open on this device (${scan.reason})`);
		for (const h of scan.hashes) live.add(h);
		const through = new Map(from ?? []);
		for (const [s, seq] of scan.through) through.set(s, seq);
		return { ok: true, live, committed, through, own };
	}
}
