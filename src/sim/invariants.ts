/**
 * Quiescence invariants (DESIGN §l.3).
 *
 *   1 convergence      same file set and byte-equal contents on every device;
 *                      the relay fold (a fresh observer bootstrapped from the
 *                      relay, net.oracle()) equals the disk: every live markdown
 *                      doc has its file with the same text, every markdown file
 *                      has a live doc; every device's ns, cfg and snap folds encode
 *                      to the same bytes as the oracle's (a fresh device that adopted
 *                      the relay's checkpoints, if any, plus the tail); every resident
 *                      body replica equals its file
 *   2 tokens           every live (not user-deleted, not crash-unacknowledged) token
 *                      survives somewhere in the converged vault (conflict copies count),
 *                      contiguous: "[A.15]" exactly, so a token split by a concurrent
 *                      edit ("[A.[B.23] 53]") or missing a bracket counts as lost.
 *                      Exempt: tokens Obsidian itself overwrote (an editor save landing
 *                      before the watcher reported an external write; ClobberRecord)
 *   3 destroyed        every token that ever reached any disk is in the vault, in a
 *                      trash record, or was deleted by a user action. Exempt: text held
 *                      only in a pending (disk-error) conflict copy when the app crashed
 *   5 clean            relay quiet, engines ready and caught up to the relay head,
 *                      ns not halted, no pending ns ops, no open intents, outbox and
 *                      disk queues empty, no frozen docs, no fatals; no vault events
 *                      in flight, no dirty views, open bound views equal their file,
 *                      bindMismatch = defaultReloadWhileBound = 0
 *   settings           every device's synced config files are equal (JSON parsed)
 *   quiet              no echo loop: after quiescence nothing appends, writes, posts
 *                      or saves
 *   log                attachment bytes never rode the relay's sequence log (DESIGN
 *                      §j.1): every committed stream is ns / cfg / snap / k / b: / c:,
 *                      no ns / cfg / snap / k row exceeds MAX_NS_FRAME_BYTES, and no
 *                      live attachment doc has a b: / c: row
 *   checkpoint         no checkpoint was disputed at the gate (devices and the oracle;
 *                      every checkpoint on the sim relay is honest; a reader-dependent
 *                      failure, a key or rules version not held yet, is no verdict), and no device has a
 *                      stream frozen, stale or behind the relay's last seq (after GC a
 *                      device that could not adopt the checkpoint stays behind)
 *   liveness           blob store calls after the heal (blobStore.ts): none still in
 *                      flight at quiescence (a stall's dead calls all ended, by their
 *                      idle window or a link abort), and the idle window never cut a
 *                      call that kept moving (a slow one)
 *
 * Not checked here: 4 (fold determinism; WP-A's fold fuzz covers it) and 6
 * (resource bounds; WP-C budget tests).
 */

import { encodeNsFoldV1 } from "../core/codec/nsFoldV1";
import { READER_DEPENDENT } from "../engine/runtime/quarantineRelease";
import type { QuarantineRecord } from "../engine/store/schema";
import { checkNsInvariants } from "../core/ns/verify";
import { pathKey } from "../core/paths/pathKey";
import { MAX_NS_FRAME_BYTES } from "../core/limits";
import { NS_STREAM, type VaultPath } from "../core/types";
import { SETTING_FILES, tokensIn, type TokenLedger } from "./actors";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import { bytesPrint, type FoldPrints, type OracleDoc, type SimNet } from "./net";
import { ABSENT, canvasCanonical, canvasFiles, canvasProblem, docIdOf, engineCanvasText, isConflictCopy, isTracked, lineageOf, readModel, type CanvasOracle } from "./canvas";
import { canonicalJson, formatCanvasText, parseCanvasText, type JsonValue } from "../core/hash/canvasCanonical";

export interface Violation {
	readonly inv: "convergence" | "tokens" | "destroyed" | "clean" | "quiet" | "e2ee" | "log" | "liveness" | "checkpoint" | "canvas";
	readonly detail: string;
}

const relayKey = (p: string) => pathKey(p as VaultPath) as string;

function files(d: SimDevice): Map<string, { path: string; text: string }> {
	const out = new Map<string, { path: string; text: string }>();
	for (const [path, text] of d.vault.snapshot()) out.set(d.vault.key(path), { path, text });
	return out;
}

function brief(s: string): string {
	return JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
}

const hex = bytesPrint;

export function checkConvergence(devs: readonly SimDevice[], oracle: { readonly docs: readonly OracleDoc[]; readonly error: string | null; readonly folds?: FoldPrints | null }): Violation[] {
	const out: Violation[] = [];
	const first = devs[0];
	if (!first) return out;
	const ref = files(first);
	for (const d of devs.slice(1)) {
		const mine = files(d);
		for (const [k, f] of ref) {
			const m = mine.get(k);
			if (!m) out.push({ inv: "convergence", detail: `${f.path} on ${first.name}, missing on ${d.name}` });
			else if (m.path.split("/").pop() !== f.path.split("/").pop()) out.push({ inv: "convergence", detail: `leaf display differs: ${f.path} vs ${m.path}` });
			else if (f.path.endsWith(".canvas")) {
				// Canvas files converge logically (DESIGN §j.2: a formatting-only difference is never rewritten).
				const x = canvasCanonical(f.text);
				const y = canvasCanonical(m.text);
				if (x === null || y === null || x !== y) out.push({ inv: "convergence", detail: `${f.path} differs (canonical): ${first.name}=${brief(x ?? `invalid ${f.text}`)} ${d.name}=${brief(y ?? `invalid ${m.text}`)}` });
			} else if (m.text !== f.text) out.push({ inv: "convergence", detail: `${f.path} differs: ${first.name}=${brief(f.text)} ${d.name}=${brief(m.text)}` });
			else if (!f.path.endsWith(".md")) {
				const x = first.vault.bytesOf(f.path);
				const y = d.vault.bytesOf(m.path);
				if (!x || !y || hex(x) !== hex(y)) out.push({ inv: "convergence", detail: `${f.path} bytes differ: ${first.name}=${x ? hex(x) : "-"} ${d.name}=${y ? hex(y) : "-"}` });
			}
		}
		for (const [k, m] of mine) if (!ref.has(k)) out.push({ inv: "convergence", detail: `${m.path} on ${d.name}, missing on ${first.name}` });
	}
	if (oracle.error) out.push({ inv: "convergence", detail: `relay oracle: ${oracle.error}` });
	const byKey = new Map<string, { path: string; text: string }>();
	for (const f of ref.values()) byKey.set(relayKey(f.path), f);
	const docKeys = new Set<string>();
	for (const doc of oracle.docs) {
		const k = relayKey(doc.path);
		docKeys.add(k);
		const f = byKey.get(k);
		if (!f) out.push({ inv: "convergence", detail: `relay doc ${doc.path} has no file` });
		else if (f.path !== doc.path) out.push({ inv: "convergence", detail: `relay path ${doc.path} vs disk ${f.path}` });
		else if (doc.kind === "canvas") {
			// A fresh device's projection of the c: stream (checkpoint + tail) is the file's logical content.
			if (doc.invalid) out.push({ inv: "convergence", detail: `relay canvas ${doc.path} does not project: ${doc.invalid}` });
			else if (doc.text !== null && canvasCanonical(doc.text) !== canvasCanonical(f.text)) out.push({ inv: "convergence", detail: `relay canvas ${doc.path}=${brief(canvasCanonical(doc.text) ?? doc.text)} disk=${brief(canvasCanonical(f.text) ?? f.text)}` });
		} else if (doc.text !== null && f.text !== doc.text) out.push({ inv: "convergence", detail: `relay ${doc.path}=${brief(doc.text)} disk=${brief(f.text)}` });
	}
	for (const [k, f] of byKey) if ((f.path.endsWith(".md") || f.path.endsWith(".png") || f.path.endsWith(".canvas")) && !docKeys.has(k)) out.push({ inv: "convergence", detail: `${f.path} never reached the relay` });
	const folds = { ns: new Map<string, string[]>(), cfg: new Map<string, string[]>(), snap: new Map<string, string[]>() };
	const add = (cls: keyof typeof folds, print: string, who: string) => folds[cls].set(print, [...(folds[cls].get(print) ?? []), who]);
	// The relay oracle is a fresh device: it bootstrapped from the relay's checkpoints (when there are any) plus the
	// tail, so its folds equal the devices' only if adopting a checkpoint gives the fold of the rows it covers.
	if (oracle.folds) for (const cls of ["ns", "cfg", "snap"] as const) add(cls, oracle.folds[cls], "oracle");
	for (const d of devs) {
		const c = d.vrt?.log.c;
		const st = c?.ns.state;
		if (!c || !st) continue;
		const bad = checkNsInvariants(st);
		if (bad) out.push({ inv: "convergence", detail: `${d.name}: ns invariant ${bad}` });
		add("ns", hex(encodeNsFoldV1(st)), d.name);
		add("cfg", hex(c.cfg.encodeState()), d.name);
		add("snap", hex(c.snap.encodeState()), d.name);
		for (const [path, text] of d.vault.snapshot()) {
			if (path.endsWith(".canvas")) {
				const crdt = engineCanvasText(d, path);
				if (crdt !== null && canvasCanonical(crdt) !== canvasCanonical(text)) out.push({ inv: "convergence", detail: `${d.name}: canvas replica of ${path}=${brief(canvasCanonical(crdt) ?? crdt)} disk=${brief(canvasCanonical(text) ?? text)}` });
				continue;
			}
			if (!path.endsWith(".md")) continue;
			const crdt = d.engineText(path);
			if (crdt !== null && crdt !== text) out.push({ inv: "convergence", detail: `${d.name}: body replica of ${path}=${brief(crdt)} disk=${brief(text)}` });
		}
	}
	for (const cls of ["ns", "cfg", "snap"] as const) {
		const m = folds[cls];
		if (m.size > 1) out.push({ inv: "convergence", detail: `${cls} fold bytes differ: ${[...m].map(([h, n]) => `${n.join(",")}=${h}`).join(" ")}` });
	}
	return out;
}

/** Invariant "log": only small records rode the relay log; attachment bytes went to the blob store only. */
export function checkLogCarriesNoBlobs(net: SimNet, oracle: { readonly docs: readonly OracleDoc[] }): Violation[] {
	const out: Violation[] = [];
	const audit = net.logAudit();
	for (const s of audit.foreign) out.push({ inv: "log", detail: `foreign stream ${s} on the relay log` });
	if (audit.largestRecordRow > MAX_NS_FRAME_BYTES) out.push({ inv: "log", detail: `an ns/cfg/snap/k row of ${audit.largestRecordRow} B` });
	for (const d of oracle.docs) if (d.kind === "blob" && audit.docStreams.has(d.docId)) out.push({ inv: "log", detail: `attachment ${d.path} has a b:/c: stream` });
	return out;
}

/** Settings converge (LWW per key): every device's synced config files are equal (JSON compared parsed). */
export function checkSettings(devs: readonly SimDevice[]): Violation[] {
	const out: Violation[] = [];
	// JSON settings files sync as per-key registers (§j.3): a file with no keys is the same state as no file.
	const norm = (path: string, b: Uint8Array | undefined): string => {
		if (!b) return path.endsWith(".json") ? "[]" : "-";
		const text = new TextDecoder().decode(b);
		if (!path.endsWith(".json")) return text;
		try {
			const o = JSON.parse(text) as Record<string, unknown>;
			return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
		} catch {
			return `invalid:${text}`;
		}
	};
	const first = devs[0];
	if (!first) return out;
	for (const path of SETTING_FILES) {
		const ref = norm(path, first.configDir.files.get(path));
		for (const d of devs.slice(1)) {
			const mine = norm(path, d.configDir.files.get(path));
			if (mine !== ref) out.push({ inv: "convergence", detail: `config ${path}: ${first.name}=${brief(ref)} ${d.name}=${brief(mine)}` });
		}
	}
	return out;
}

/** Fingerprint of the synced config files (quiescence detection). */
export function settingsPrint(d: SimDevice): string {
	return SETTING_FILES.map((p) => {
		const b = d.configDir.files.get(p);
		return b ? hex(b) : "-";
	}).join(",");
}

/** Tokens Obsidian itself destroyed (editor save over an unseen external/user write; vault.ts ClobberRecord). */
export function clobberedTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const d of devs) {
		for (const c of d.vault.clobbered) {
			const saved = new Set(tokensIn(c.savedText));
			for (const t of tokensIn(c.text)) if (!saved.has(t)) out.add(t);
		}
	}
	return out;
}

/** Contiguous tokens in the converged vault (device 0; convergence is checked separately). */
function vaultTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const text of devs[0]?.vault.snapshot().values() ?? []) for (const t of tokensIn(text)) out.add(t);
	return out;
}

export function checkTokens(devs: readonly SimDevice[], ledger: TokenLedger): Violation[] {
	const present = vaultTokens(devs);
	const clobbered = clobberedTokens(devs);
	const lost = ledger.live().filter((e) => !present.has(e.token) && !clobbered.has(e.token));
	return lost.slice(0, 10).map((e) => ({ inv: "tokens" as const, detail: `lost ${e.token} (${e.via} on ${e.dev} at step ${e.step})${lost.length > 10 ? ` (+${lost.length - 10} more)` : ""}` }));
}

export function checkNothingDestroyed(devs: readonly SimDevice[], ledger: TokenLedger): Violation[] {
	const kept = vaultTokens(devs);
	for (const d of devs) for (const r of d.vault.trashed) for (const t of tokensIn(r.text)) kept.add(t);
	for (const t of clobberedTokens(devs)) kept.add(t);
	// Known gap (wp-d-notes): a conflict copy still retrying a disk error dies with an app crash.
	for (const d of devs) for (const text of d.crashLost) for (const t of tokensIn(text)) kept.add(t);
	const out: Violation[] = [];
	const seen = new Set<string>();
	for (const d of devs) {
		for (const v of d.vault.history) {
			for (const t of tokensIn(v.text)) {
				if (seen.has(t)) continue;
				seen.add(t);
				if (kept.has(t) || ledger.entries.get(t)?.state === "deleted") continue;
				if (out.length < 10) out.push({ inv: "destroyed", detail: `${t} was on ${d.name}:${v.path} (${v.by}) and is gone` });
			}
		}
	}
	return out;
}

export function checkClean(devs: readonly SimDevice[], net: SimNet, isDown: (i: number) => boolean): Violation[] {
	const out: Violation[] = [];
	const bad = (detail: string) => out.push({ inv: "clean", detail });
	if (!net.quiet()) bad(`relay not quiet (pending ${net.relay.pendingCount()})`);
	const head = net.streamHead(NS_STREAM);
	devs.forEach((d, i) => {
		const n = d.name;
		if (isDown(i)) bad(`${n}: app still down`);
		if (!d.runtime.engine.isReady) bad(`${n}: engine not ready`);
		const rt = d.vrt;
		if (!rt) bad(`${n}: no vault runtime`);
		else {
			const v = rt.log.nsView();
			if (v.halted || v.overlayHalted) bad(`${n}: ns halted`);
			if (!v.caughtUp || v.coversSeq < head) bad(`${n}: ns covers ${v.coversSeq} of head ${head}`);
			if (v.pending.length > 0) bad(`${n}: ${v.pending.length} pending ns frames`);
			if (!rt.log.isIdle()) bad(`${n}: log engine not idle`);
			const intents = rt.rec.ctx.store.intents.size;
			if (intents > 0) bad(`${n}: ${intents} open intents`);
			const queued = rt.blobs.queued();
			if (queued.length > 0) bad(`${n}: blob transfers queued: ${queued.map((q) => `${q.direction}:${q.path}`).join(", ")}`);
		}
		if (d.vault.pendingEvents() > 0) bad(`${n}: ${d.vault.pendingEvents()} vault events in flight`);
		if (d.ui.fatals.length > 0) bad(`${n}: fatal ${d.ui.fatals[0]?.code}`);
		const st = d.ui.statuses[d.ui.statuses.length - 1];
		if (st) {
			const c = st.counts;
			if (c.pendingDiskOps > 0 || c.outboxFrames > 0 || c.frozenDocs > 0 || c.unreceiptedFrames > 0) bad(`${n}: status pendingDiskOps=${c.pendingDiskOps} outbox=${c.outboxFrames} unreceipted=${c.unreceiptedFrames} frozen=${c.frozenDocs}`);
		}
		for (const ws of d.workspaces) {
			for (const v of ws.history) {
				if (v.counters.defaultReloadWhileBound > 0) bad(`${n}: view ${v.viewId} defaultReloadWhileBound=${v.counters.defaultReloadWhileBound}`);
			}
		}
		for (const v of d.workspace.views_()) {
			if (v.isDirty()) bad(`${n}: view ${v.viewId} (${v.path}) still dirty`);
			if (!v.hasEditor() || v.path === null || !v.path.endsWith(".md")) continue;
			const disk = d.vault.textOf(v.path);
			if (disk === null) continue;
			if (!v.isBound()) bad(`${n}: view ${v.viewId} (${v.path}) never bound`);
			if (v.buffer !== disk) bad(`${n}: view ${v.viewId} buffer ${brief(v.buffer)} != disk ${brief(disk)}`);
		}
	});
	return out;
}

/**
 * Invariant "checkpoint" (DESIGN §b.5, §d.7, §d.9): the sim's relay holds only honest checkpoints (no fault forges
 * one), so the gate never disputes one on any device or on the oracle; and once quiescent no device still needs a
 * row: no stream is frozen, stale, or behind the relay's last seq of the stream (GC'd rows are reachable only
 * through the checkpoint, so a device that could not adopt one would be left here).
 */
export function checkCheckpoints(devs: readonly SimDevice[], net: SimNet): Violation[] {
	const out: Violation[] = [];
	const bad = (detail: string) => out.push({ inv: "checkpoint", detail });
	// A reader-dependent failure (a key or rules version this reader does not have yet) is not a verdict on the
	// checkpoint; the stream must still end caught up (below).
	// "disputed before" repeats an earlier dispute of the same checkpoint, judged when it was first seen.
	const verdict = (x: string) => {
		const reason = x.split(" ")[1]?.replace(/:$/, "") ?? "";
		return reason !== "disputed" && !READER_DEPENDENT.has(reason as QuarantineRecord["reason"]);
	};
	for (const d of devs) for (const x of d.disputed) if (verdict(x)) bad(`${d.name}: gate disputed a checkpoint: ${x}`);
	for (const x of net.oracleDisputed) if (verdict(x)) bad(`oracle: gate disputed a checkpoint: ${x}`);
	for (const d of devs) {
		const repo = d.vrt?.log.c.repo;
		if (!repo) continue;
		const behind: string[] = [];
		for (const r of repo.streams()) {
			if (r.cls === "other") continue;
			if (r.frozen) bad(`${d.name}: ${r.stream} frozen (${r.frozenReason ?? "?"})`);
			// The newest row a reader must apply: forged rows (hostile relay) fail the gate and never count.
			const rows = net.relay.store.rows(r.stream, true);
			let last = 0;
			for (let i = rows.length - 1; i >= 0; i--) if (!net.relay.forgedSeqs.has(rows[i]!.seq)) {
				last = rows[i]!.seq;
				break;
			}
			if (r.stale || r.appliedSeq < last) behind.push(`${r.stream} at ${r.appliedSeq} of ${last}${r.stale ? " stale" : ""} (gc ${net.relay.gcSeq(r.stream)})`);
		}
		if (behind.length > 0) bad(`${d.name}: ${behind.length} streams behind the relay: ${behind.slice(0, 4).join(", ")}`);
	}
	return out;
}

/** Invariant "liveness": no blob store call outlived the heal; the idle window cut no slow call. */
export function checkBlobLiveness(net: SimNet): Violation[] {
	const out: Violation[] = [];
	const s = net.blobs.liveness;
	if (s.slowCut > 0) out.push({ inv: "liveness", detail: `the idle window cut ${s.slowCut} blob calls that kept moving (slow, never stalled)` });
	const open = net.blobs.transfers();
	if (open.length > 0) out.push({ inv: "liveness", detail: `blob store calls still in flight: ${open.map((c) => `${c.route}@${c.startedAt}${c.stalled ? " stalled" : ""}`).join(", ")}` });
	return out;
}

export function activity(devs: readonly SimDevice[], net: SimNet): string {
	const rc = net.relay.counters();
	const parts: (number | string)[] = [net.relay.head(), rc.appendFrames, rc.provisionalBroadcasts];
	for (const d of devs) {
		const b = d.runtime.bindings.stats;
		parts.push(d.vault.calls.write, d.vault.calls.rename, d.vault.calls.trash, b.pushes, b.uploads, b.reloads, d.sideFiles.writes);
		for (const v of d.workspace.views_()) parts.push(v.counters.saves, v.counters.localTx, v.counters.remoteApplied);
	}
	return parts.join(",");
}

/** No echo loop: advancing `ms` after quiescence produces no appends, writes, posts or saves. */
export async function checkQuiet(clock: VirtualClock, devs: readonly SimDevice[], net: SimNet, ms = 30_000): Promise<Violation[]> {
	const before = activity(devs, net);
	await clock.advance(ms);
	const after = activity(devs, net);
	return before === after ? [] : [{ inv: "quiet", detail: `activity after quiescence: ${before} -> ${after}` }];
}

/**
 * Invariant "canvas" (DESIGN §j.2 "Merge semantics"), after the heal:
 *
 *   validity     every canvas file on every device is a valid JSON Canvas (canvasProblem); every canvas version
 *                the engine ever wrote (vault history, writer "sync": projections, materializations, conflict
 *                copies) was valid, so a broken file never reached a peer; a file the engine wrote is exactly the
 *                projection's formatting (formatCanvasText), any other bytes on disk were written by a user or
 *                another program
 *   records      every node and edge some user created and no user deleted exists in some canvas (conflict copies
 *                count); exempt: an edge whose endpoint node a user deleted (dangling edges are dropped from the
 *                projection and kept in the CRDT)
 *   delete rule  a record a user deleted is not back in the canvas (doc) it was deleted from, unless another
 *                device edited it without having seen the delete (a concurrent edit; the disk/CRDT merge keeps the
 *                CRDT side and copies the disk file) or the deleting device wrote a conflict copy lacking it after
 *                the delete (its merge had no base, or met a concurrent edit), or an IDB wipe without mirrors hit
 *                the deleting device after the delete (its unsent delete is gone). Other docs holding it (conflict
 *                copies, a duplicate a wipe or an epoch reset left under a suffixed name) are copies, not the doc
 *   text         canvas text-node edits carry ledger tokens: checkTokens / checkNothingDestroyed cover them (a
 *                Y.Text char merge of concurrent edits keeps both)
 *   writes       no lost update on a tracked field (canvas.ts oracle): a write that replaced value V (its
 *                saw-chain passes through V) is never undone back to V in every canvas holding the record. Values
 *                the user threw away with a conflict copy, fields of deleted records, and fields of an edge left
 *                dangling by a user's node delete (only conflict copies show it; the CRDT keeps it), are exempt. Unknown
 *                fields at the top level, on nodes and on edges are tracked fields
 *   order        an uncontested reorder holds: "bring to front / send to back" of node n on device X still puts n
 *                above / below every node that was on the canvas then, unless another device reordered n or one of
 *                those nodes, X reordered them later, a program sorted them, or a conflict copy holds them
 */
export function checkCanvas(devs: readonly SimDevice[], oracle: CanvasOracle): Violation[] {
	const out: Violation[] = [];
	const bad = (detail: string) => {
		if (out.length < 12) out.push({ inv: "canvas", detail });
	};
	for (const d of devs) {
		for (const path of canvasFiles(d)) {
			const text = d.vault.textOf(path) ?? "";
			const why = canvasProblem(text);
			if (why) {
				bad(`${d.name}: ${path} is not a valid canvas after the heal (${why}): ${brief(text)}`);
				continue;
			}
			const parsed = parseCanvasText(text);
			if (parsed.kind !== "valid") {
				bad(`${d.name}: ${path} valid JSON Canvas but the engine's parser says ${parsed.kind}`);
				continue;
			}
			if (formatCanvasText(parsed.data) !== text && !d.vault.history.some((v) => v.by !== "sync" && v.text === text)) {
				bad(`${d.name}: ${path} holds bytes neither the projection's formatting nor written by a user: ${brief(text)}`);
			}
		}
		const seen = new Set<string>();
		for (const v of d.vault.history) {
			if (v.by !== "sync" || !v.path.endsWith(".canvas") || seen.has(v.text)) continue;
			seen.add(v.text);
			const why = canvasProblem(v.text);
			if (why) bad(`${d.name}: the engine wrote an invalid canvas to ${v.path} (${why}): ${brief(v.text)}`);
		}
	}
	const first = devs[0];
	if (!first) return out;

	// The converged canvases (device 0; convergence is checked separately): record -> [path, fields].
	const holders = new Map<string, { path: string; doc: string | null; obj: Readonly<Record<string, unknown>> }[]>();
	const roots: { path: string; root: Readonly<Record<string, unknown>> }[] = [];
	const order = new Map<string, { path: string; ids: string[] }>();
	for (const path of canvasFiles(first)) {
		const m = readModel(first.vault.textOf(path) ?? "");
		if (!m) continue;
		const doc = docIdOf(first, path);
		roots.push({ path, root: m.root });
		if (doc) order.set(doc, { path, ids: m.nodes.map((n) => String(n.id)) });
		for (const [kind, list] of [["n", m.nodes], ["e", m.edges]] as const) {
			for (const o of list) {
				const rec = `${kind}:${String(o.id)}`;
				holders.set(rec, [...(holders.get(rec) ?? []), { path, doc, obj: o }]);
			}
		}
	}
	const valueOf = (obj: Readonly<Record<string, unknown>>, field: string): string => (obj[field] === undefined ? ABSENT : canonicalJson(obj[field] as JsonValue));
	const deletedNode = (id: string) => oracle.record(`n:${id}`)?.deleted != null;

	// records
	for (const r of oracle.records.values()) {
		if (r.deleted) continue;
		if (r.key.startsWith("e:") && [...r.endpoints].some(deletedNode)) continue;
		if (!holders.has(r.key)) bad(`lost ${r.key} (created on ${r.created.dev} at step ${r.created.step} in ${r.created.path})`);
	}

	// delete rule
	const seenBy = (del: NonNullable<ReturnType<CanvasOracle["record"]>>["deleted"], rec: string, t: { field: string; value: string }): boolean => {
		if (!del) return true;
		if (t.field === "text") {
			const text = del.saw.get("text") ?? "";
			return t.value.startsWith("+") ? text.includes(t.value.slice(1)) : !text.includes(t.value.slice(1));
		}
		if (t.field === "rank") return false;
		const saw = del.saw.get(t.field) ?? ABSENT;
		if (saw === t.value) return true;
		if (!isTracked(rec, t.field)) return false;
		const w = oracle.writes.get(`${rec}|${t.field}|${saw}`);
		return w ? oracle.ancestors(w).has(t.value) : false;
	};
	for (const r of oracle.records.values()) {
		const del = r.deleted;
		if (!del || del.how !== "record" || del.doc === null) continue;
		// Back in the canvas (doc) it was deleted from; copies of that canvas (conflict copies, a duplicate a wipe or
		// an epoch reset left under a suffixed name) are other docs.
		const back = (holders.get(r.key) ?? []).filter((h) => h.doc === del.doc);
		if (back.length === 0) continue;
		const concurrent = r.touches.some((t) => t.dev !== del.dev && !seenBy(del, r.key, t));
		const dev = devs.find((x) => x.name === del.dev);
		const copied = dev?.vault.history.some((v) => v.by === "sync" && isConflictCopy(v.path) && v.path.endsWith(".canvas") && v.atMs >= del.atMs && !v.text.includes(`"${r.key.slice(2)}"`)) ?? false;
		// The deleting device's store was wiped with its mirrors after the delete: an unsent delete is gone with it.
		const wiped = oracle.wipes.some((x) => x.dev === del.dev && x.atMs >= del.atMs);
		if (!concurrent && !copied && !wiped) bad(`${r.key} deleted on ${del.dev} at step ${del.step} is back in ${back.map((h) => h.path).join(", ")} with no concurrent edit and no conflict copy`);
	}

	// writes (lost updates)
	const finalsOf = (rec: string, field: string, lineage: string | null | undefined, removal: boolean): string[] | null => {
		if (rec === "root") {
			// A root has no id: its holders are the canvases of the written one's lineage (canvas.ts LINEAGE_KEY;
			// conflict copies included, the field absent or not). A lineage no canvas holds any more (the canvas was
			// deleted, or merged into another doc whose root won) or none at all: every canvas holding the field, and a
			// removal is not judged (a canvas without the field may or may not be the written one).
			const known = lineage ? roots.filter((x) => lineageOf(x.root) === lineage) : [];
			const hs = known.length > 0 ? known : removal ? [] : roots.filter((x) => x.root[field] !== undefined);
			return hs.length > 0 ? hs.map((x) => valueOf(x.root, field)) : null;
		}
		const hs = holders.get(rec);
		return hs ? hs.map((h) => valueOf(h.obj, field)) : null;
	};
	const lost = (w: { rec: string; field: string; value: string; dev: string; step: number }, anc: Set<string>, finals: readonly string[]): boolean => {
		if (w.value === ABSENT) return finals.every((f) => f !== ABSENT && anc.has(f));
		const removals = oracle.removals.get(`${w.rec}|${w.field}`) ?? [];
		const removedAfter = removals.some((rm) => rm.saw === null || !anc.has(rm.saw));
		return finals.every((f) => (f === ABSENT ? anc.has(ABSENT) && !removedAfter : anc.has(f)));
	};
	// An edge with an endpoint a user deleted that no canvas but a conflict copy holds is dangling in its doc: kept in
	// the CRDT with its fields and dropped from the projection (DESIGN §j.2), so its writes are not on any disk.
	const dangling = (rec: string): boolean => rec.startsWith("e:") && [...(oracle.record(rec)?.endpoints ?? [])].some(deletedNode)
		&& !(holders.get(rec) ?? []).some((h) => !isConflictCopy(h.path));
	const all = [...oracle.writes.values(), ...[...oracle.removals.values()].flat()];
	for (const w of all) {
		if (w.rec !== "root" && oracle.record(w.rec)?.deleted) continue;
		if (dangling(w.rec)) continue;
		if (oracle.discarded.has(`${w.rec}|${w.field}|${w.value}`)) continue;
		const finals = finalsOf(w.rec, w.field, w.lineage, w.value === ABSENT);
		if (!finals) continue;
		const anc = oracle.ancestors(w);
		if (anc.size === 0) continue;
		if (lost(w, anc, finals)) bad(`lost write ${w.rec}.${w.field}=${w.value === ABSENT ? "(removed)" : w.value} on ${w.dev} at step ${w.step} (${w.path}); final ${finals.map((f) => (f === ABSENT ? "(absent)" : f)).join(" | ")}`);
	}

	// order
	const inCopy = (id: string) => (holders.get(`n:${id}`) ?? []).some((h) => isConflictCopy(h.path));
	for (const r of oracle.reorders) {
		if (deletedNode(r.node) || oracle.sorted.has(r.node) || inCopy(r.node)) continue;
		const group = new Set([r.node, ...r.siblings]);
		if (oracle.reorders.some((x) => x.dev !== r.dev && group.has(x.node))) continue;
		if (oracle.reorders.some((x) => x.dev === r.dev && x.node === r.node && x.atMs > r.atMs)) continue;
		const where = r.doc !== null ? order.get(r.doc) : undefined;
		if (where) {
			const { path, ids } = where;
			const at = ids.indexOf(r.node);
			if (at < 0) continue;
			for (const m of r.siblings) {
				const mi = ids.indexOf(m);
				if (mi < 0 || deletedNode(m) || oracle.sorted.has(m) || inCopy(m)) continue;
				if (oracle.reorders.some((x) => x.dev === r.dev && x.node === m && x.atMs > r.atMs)) continue;
				if (r.front ? at < mi : at > mi) bad(`reorder of ${r.node} to the ${r.front ? "front" : "back"} on ${r.dev} at step ${r.step} lost against ${m} in ${path}`);
			}
		}
	}
	return out;
}
