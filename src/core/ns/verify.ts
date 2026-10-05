/**
 * ns checkpoint verification (DESIGN §b.5): V1 canonical form, V2 structural
 * invariants. V3 (digests at candidates) is in ./candidate.ts.
 *
 * Decisions (wp-a-notes.md):
 * - deleted entries must have deletedSeq === lastTouchSeq and merged entries
 *   createdSeq === lastTouchSeq (both hold for every state the v1 fold reaches).
 * - merged entries must have the same kind as their aliasOf target.
 * - deleteBaseBodySeq is a body-stream seq and is not bounded by coversSeq.
 * - Checkpoint content: foldRulesVersion in the content header must equal the
 *   state's; content coversSeq and state coversSeq must equal the relay's.
 */

import type { DocId, NsEntry, NsFoldIndex, NsFoldState, PathKey, VaultPath } from "../types";
import { kindOfPath } from "../types";
import { CheckpointEncoding, type CheckpointContent } from "../envelope";
import { FOLD_RULES_VERSION, NS_DEDUPE_RING, TOMBSTONE_CAP } from "../limits";
import { bytesEqual } from "../codec/lib0";
import { isClientFrameId, isContentHash, isDocId } from "../codec/ids";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../codec/nsFoldV1";
import { pathKey } from "../paths/pathKey";
import { isValidPath } from "../paths/validate";
import { buildIndex, folderPrefixes, indexesEqual } from "./index";

export interface NsInvariantOptions {
	readonly tombstoneCap?: number;
	readonly knownRulesVersion?: number;
}

export type NsVerifyResult =
	| { readonly ok: true; readonly state: NsFoldState; readonly index: NsFoldIndex }
	| { readonly ok: false; readonly reason: "malformed" | "non-canonical" | "invariant" | "upgrade-required" | "covers-seq"; readonly detail: string };

interface EntryCheck {
	readonly err: string | null;
	readonly maxSeq: number;
}

// Entry objects are immutable, so their self-contained checks are cached (fuzz performance).
const entryCache = new WeakMap<NsEntry, EntryCheck>();

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

function checkEntrySelf(e: NsEntry): EntryCheck {
	const hit = entryCache.get(e);
	if (hit) return hit;
	const r = computeEntrySelf(e);
	entryCache.set(e, r);
	return r;
}

function computeEntrySelf(e: NsEntry): EntryCheck {
	const fail = (m: string): EntryCheck => ({ err: `${e.docId}: ${m}`, maxSeq: 0 });
	if (!isDocId(e.docId)) return fail("invalid docId");
	if (!isValidPath(e.path)) return fail(`invalid path ${JSON.stringify(e.path)}`);
	if (e.pathKey !== pathKey(e.path)) return fail("pathKey does not match path");
	if (e.kind !== "markdown" && e.kind !== "canvas" && e.kind !== "blob") return fail("unknown kind");
	if (e.state !== "merged" && e.kind !== kindOfPath(e.path)) return fail("kind != kindOfPath(path)");
	for (const n of [e.createdSeq, e.lastTouchSeq, e.deletedSeq, e.deleteBaseBodySeq, e.createSize]) if (!isCount(n)) return fail("bad integer");
	if (!isContentHash(e.createHash)) return fail("bad createHash");
	if (e.createdSeq < 1 || e.createdSeq > e.lastTouchSeq) return fail("createdSeq out of range");
	switch (e.state) {
		case "live":
			if (e.deletedSeq !== 0 || e.deleteBaseBodySeq !== 0 || e.aliasOf !== null) return fail("live with delete/alias fields");
			break;
		case "deleted":
			if (e.deletedSeq < 1 || e.deletedSeq !== e.lastTouchSeq || e.aliasOf !== null) return fail("deleted fields inconsistent");
			break;
		case "merged":
			if (e.aliasOf === null || e.aliasOf === e.docId || e.deletedSeq !== 0 || e.deleteBaseBodySeq !== 0) return fail("merged fields inconsistent");
			if (e.createdSeq !== e.lastTouchSeq) return fail("merged entry touched after create");
			break;
		default:
			return fail("unknown state");
	}
	const wantBlob = e.kind === "blob" && e.state !== "merged";
	if (wantBlob !== (e.blob !== null)) return fail("blob presence");
	if (e.blob) {
		if (!isContentHash(e.blob.hash) || !isCount(e.blob.size) || !isCount(e.blob.rev)) return fail("bad blob");
		if (e.blob.rev < e.createdSeq || e.blob.rev > e.lastTouchSeq) return fail("blob.rev out of range");
	}
	return { err: null, maxSeq: Math.max(e.createdSeq, e.lastTouchSeq, e.deletedSeq) };
}

/**
 * V2 except foldRulesVersion (see verifyNsFoldState). Returns the first
 * violation or null. If `index` is given it must equal the rebuilt index.
 */
export function checkNsInvariants(state: NsFoldState, index?: NsFoldIndex, opts: NsInvariantOptions = {}): string | null {
	if (state.formatVersion !== 1) return "formatVersion != 1";
	if (!isCount(state.coversSeq)) return "bad coversSeq";
	const cap = opts.tombstoneCap ?? TOMBSTONE_CAP;
	const byPathKey = new Map<PathKey, DocId>();
	const folders = new Map<PathKey, { path: VaultPath; count: number }>();
	let tombstones = 0;
	for (const [id, e] of state.entries) {
		if (id !== e.docId) return `${id}: map key != docId`;
		const c = checkEntrySelf(e);
		if (c.err !== null) return c.err;
		if (c.maxSeq > state.coversSeq) return `${id}: seq ${c.maxSeq} > coversSeq ${state.coversSeq}`;
		if (e.state === "merged") {
			tombstones++;
			const t = state.entries.get(e.aliasOf!);
			if (!t) return `${id}: aliasOf ${e.aliasOf} missing`;
			if (t.state === "merged") return `${id}: aliasOf ${e.aliasOf} is merged`;
			if (t.kind !== e.kind) return `${id}: kind differs from aliasOf`;
			continue;
		}
		if (e.state === "deleted") {
			tombstones++;
			continue;
		}
		const holder = byPathKey.get(e.pathKey);
		if (holder !== undefined) return `live pathKey ${e.pathKey} held by ${holder} and ${id}`;
		byPathKey.set(e.pathKey, id);
		for (const [k, display] of folderPrefixes(e.path, e.pathKey)) {
			const cur = folders.get(k);
			if (!cur) folders.set(k, { path: display, count: 1 });
			else if (cur.path !== display) return `folder ${k} casing ${JSON.stringify(cur.path)} vs ${JSON.stringify(display)} (${id})`;
			else folders.set(k, { path: cur.path, count: cur.count + 1 });
		}
	}
	for (const k of byPathKey.keys()) if (folders.has(k)) return `live file key ${k} is also a folder key`;
	if (tombstones > cap) return `tombstones ${tombstones} > cap ${cap}`;
	for (const [device, ring] of state.recentFrames) {
		if (typeof device !== "string" || device.length === 0) return "empty deviceId in rings";
		if (ring.length < 1 || ring.length > NS_DEDUPE_RING) return `ring ${device} size ${ring.length}`;
		if (new Set(ring).size !== ring.length) return `ring ${device} has duplicates`;
		for (const f of ring) if (!isClientFrameId(f)) return `ring ${device} has invalid id`;
	}
	if (index) {
		const d = indexesEqual(index, { byPathKey, folderRefs: folders, tombstones });
		if (d !== null) return `index differs from rebuilt: ${d}`;
	}
	return null;
}

/** V2 including foldRulesVersion. */
export function verifyNsFoldState(state: NsFoldState, opts: NsInvariantOptions = {}): NsVerifyResult {
	const known = opts.knownRulesVersion ?? FOLD_RULES_VERSION;
	if (!Number.isSafeInteger(state.foldRulesVersion) || state.foldRulesVersion < 1) return { ok: false, reason: "invariant", detail: "foldRulesVersion < 1" };
	if (state.foldRulesVersion > known) return { ok: false, reason: "upgrade-required", detail: `foldRulesVersion ${state.foldRulesVersion}` };
	const err = checkNsInvariants(state, undefined, opts);
	if (err !== null) return { ok: false, reason: "invariant", detail: err };
	return { ok: true, state, index: buildIndex(state) };
}

/** V1 + V2 over nsFoldV1 state bytes. `expectedCoversSeq` is the relay's checkpoint coversSeq. */
export function verifyNsFoldBytes(bytes: Uint8Array, expectedCoversSeq: number, opts: NsInvariantOptions = {}): NsVerifyResult {
	const state = decodeNsFoldV1(bytes);
	if (!state) return { ok: false, reason: "malformed", detail: "nsFoldV1 decode failed" };
	if (!bytesEqual(encodeNsFoldV1(state), bytes)) return { ok: false, reason: "non-canonical", detail: "re-encode differs" };
	if (state.coversSeq !== expectedCoversSeq) return { ok: false, reason: "covers-seq", detail: `state ${state.coversSeq} != relay ${expectedCoversSeq}` };
	return verifyNsFoldState(state, opts);
}

/** Full check of a decoded ns checkpoint content (encoding, header, V1, V2). */
export function verifyNsCheckpoint(content: CheckpointContent, relayCoversSeq: number, opts: NsInvariantOptions = {}): NsVerifyResult {
	if (content.encoding !== CheckpointEncoding.nsFoldV1) return { ok: false, reason: "malformed", detail: `encoding ${content.encoding}` };
	if (content.coversSeq !== relayCoversSeq) return { ok: false, reason: "covers-seq", detail: `content ${content.coversSeq} != relay ${relayCoversSeq}` };
	const r = verifyNsFoldBytes(content.state, relayCoversSeq, opts);
	if (r.ok && r.state.foldRulesVersion !== content.foldRulesVersion) {
		return { ok: false, reason: "invariant", detail: "content foldRulesVersion != state foldRulesVersion" };
	}
	return r;
}
