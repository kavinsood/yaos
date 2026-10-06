/**
 * Settings fold (DESIGN §c.11). LWW registers ordered by (seq, index), with
 * the same duplicate-frame ring and coversSeq rules as the ns fold (§c.3).
 * Pure and total: never throws on a CfgFrame.
 *
 * Decisions (wp-a-notes.md):
 * - seq <= coversSeq: [] and no change (already folded).
 * - Duplicate clientFrameId (ring of NS_DEDUPE_RING per device): one
 *   frame-level event, coversSeq still advances.
 * - Then the frameNo replay window (e2ee-design §8.2, frameNo ≥ 1 only):
 *   replay-stale / replay-duplicate are frame-level events too; a frame
 *   rejected by the ring or the window changes neither.
 * - A malformed cfgOps payload folds as a frame with ops: [] (it still enters
 *   the ring and advances coversSeq).
 * - The fold has no allowlist gate (§c.11); it only rejects structurally
 *   invalid ops ("invalid-op"): bad config path / plugin id, valueJson that is
 *   not canonical JSON, a blob ref with a bad hash.
 * - Every valid op writes its register with version (seq, index, deviceId),
 *   even when the value is unchanged (outcome "same"). Deletes of absent keys
 *   create a tombstone.
 * - An op whose version is not newer than the register's is "stale" (cannot
 *   happen when frames are folded in seq order; kept as a guard).
 */

import type {
	CfgFileContent,
	CfgFoldState,
	CfgOp,
	CfgRegister,
	CfgVersion,
	ClientFrameId,
	ConfigRelPath,
	DeviceId,
	Seq,
} from "../types";
import { NS_DEDUPE_RING } from "../limits";
import { replayAccept, replayCheck } from "../replayWindow";
import { isContentHash } from "../codec/ids";
import { isCanonicalJson } from "./json";

/** cfg checkpoints carry this foldRulesVersion in the content header. cfg has no upgradeRules op. */
export const CFG_FOLD_RULES_VERSION = 1;

export interface CfgFrame {
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** Replay counter (e2ee-design §8.2); 0 = a gate-failed row, outside the window. */
	readonly frameNo: number;
	/** [] for a malformed payload. */
	readonly ops: readonly CfgOp[];
}

export type CfgRegisterRef =
	| { readonly map: "json"; readonly key: string; readonly file: ConfigRelPath; readonly jsonKey: string }
	| { readonly map: "files"; readonly key: ConfigRelPath }
	| { readonly map: "plugins"; readonly key: string };

export type CfgOpOutcome =
	/** Register value changed (including present -> tombstone and new keys). */
	| { readonly t: "applied" }
	/** Value unchanged; version updated. */
	| { readonly t: "same" }
	/** replay-*: frame-level, the frameNo window (e2ee-design §8.2); stale-epoch: frame-level, WP-E3 (§14.3). */
	| { readonly t: "ignored"; readonly reason: "duplicate-frame" | "replay-stale" | "replay-duplicate" | "stale-epoch" | "invalid-op" | "stale" };

export interface CfgFoldEvent {
	readonly seq: Seq;
	/** Op index; -1 for a frame-level event (duplicate-frame, replay-*). */
	readonly index: number;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** null for frame-level events and invalid ops. */
	readonly register: CfgRegisterRef | null;
	readonly outcome: CfgOpOutcome;
}

export interface CfgFoldRules {
	readonly dedupeRing: number;
}

export const DEFAULT_CFG_FOLD_RULES: CfgFoldRules = { dedupeRing: NS_DEDUPE_RING };

export type CfgFileValue = { readonly content: CfgFileContent; readonly pluginVersion: string | null };

export function newCfgFoldState(): CfgFoldState {
	return { formatVersion: 1, coversSeq: 0, recentFrames: new Map(), replay: new Map(), json: new Map(), files: new Map(), plugins: new Map() };
}

/** Shallow copy: maps are new, registers (immutable) are shared. */
export function cloneCfgFold(s: CfgFoldState): CfgFoldState {
	return {
		formatVersion: 1,
		coversSeq: s.coversSeq,
		recentFrames: new Map(s.recentFrames),
		replay: new Map(s.replay),
		json: new Map(s.json),
		files: new Map(s.files),
		plugins: new Map(s.plugins),
	};
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Register key of a top-level JSON key: file + "\0" + key. */
export function jsonRegisterKey(file: ConfigRelPath, key: string): string {
	return `${file}\u0000${key}`;
}

/** Inverse of jsonRegisterKey (the file part never contains "\0"); null if there is no "\0". */
export function splitJsonRegisterKey(k: string): { readonly file: ConfigRelPath; readonly key: string } | null {
	const i = k.indexOf("\u0000");
	if (i < 0) return null;
	return { file: k.slice(0, i), key: k.slice(i + 1) };
}

/**
 * Structural config-relative path check (no allowlist): non-empty, at most
 * 1024 UTF-16 units, "/"-separated segments that are non-empty and not "." or
 * "..", no "\\" and no "\0".
 */
export function isConfigRelPath(p: string): boolean {
	if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
	if (p.includes("\\") || p.includes("\u0000")) return false;
	for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") return false;
	return true;
}

/** Plugin id check: a single non-empty path segment. */
export function isPluginId(id: string): boolean {
	return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("/") && isConfigRelPath(id);
}

export function isCfgFileContent(c: CfgFileContent): boolean {
	if (c.t === "inline") return c.bytes instanceof Uint8Array;
	return c.t === "blob" && isContentHash(c.hash) && Number.isSafeInteger(c.size) && c.size >= 0;
}

/** Structural validity of one op (what the fold accepts). */
export function isValidCfgOp(op: CfgOp): boolean {
	switch (op.t) {
		case "jsonSet":
			return isConfigRelPath(op.file) && typeof op.key === "string" && isCanonicalJson(op.valueJson);
		case "jsonDel":
			return isConfigRelPath(op.file) && typeof op.key === "string";
		case "filePut":
			return isConfigRelPath(op.file) && isCfgFileContent(op.content) && (op.pluginVersion === null || (typeof op.pluginVersion === "string" && op.pluginVersion.length > 0));
		case "fileDel":
			return isConfigRelPath(op.file);
		case "pluginSet":
			return isPluginId(op.pluginId) && typeof op.enabled === "boolean";
		case "pluginDel":
			return isPluginId(op.pluginId);
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export function compareCfgVersion(a: CfgVersion, b: CfgVersion): number {
	return a.seq !== b.seq ? a.seq - b.seq : a.index - b.index;
}

function bytesSame(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function cfgFileValuesEqual(a: CfgFileValue | null, b: CfgFileValue | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.pluginVersion !== b.pluginVersion) return false;
	const x = a.content;
	const y = b.content;
	if (x.t === "inline") return y.t === "inline" && bytesSame(x.bytes, y.bytes);
	return y.t === "blob" && x.hash === y.hash && x.size === y.size;
}

function write<T>(
	m: Map<string, CfgRegister<T>>,
	key: string,
	value: T | null,
	version: CfgVersion,
	eq: (a: T | null, b: T | null) => boolean,
): CfgOpOutcome {
	const cur = m.get(key);
	if (cur && compareCfgVersion(version, cur.version) <= 0) return { t: "ignored", reason: "stale" };
	m.set(key, { value, version });
	return cur && eq(cur.value, value) ? { t: "same" } : { t: "applied" };
}

const strictEq = <T>(a: T | null, b: T | null) => a === b;

export function foldCfgFrameWith(rules: CfgFoldRules, state: CfgFoldState, frame: CfgFrame): CfgFoldEvent[] {
	if (frame.seq <= state.coversSeq) return [];
	const ev = (index: number, register: CfgRegisterRef | null, outcome: CfgOpOutcome): CfgFoldEvent => ({
		seq: frame.seq,
		index,
		deviceId: frame.deviceId,
		clientFrameId: frame.clientFrameId,
		register,
		outcome,
	});
	const ring = state.recentFrames.get(frame.deviceId);
	if (ring && ring.includes(frame.clientFrameId)) {
		state.coversSeq = frame.seq;
		return [ev(-1, null, { t: "ignored", reason: "duplicate-frame" })];
	}
	// frameNo window after the ring (e2ee-design §8.2): a rejected frame changes neither.
	if (frame.frameNo >= 1) {
		const w = state.replay.get(frame.deviceId);
		const verdict = replayCheck(w, frame.frameNo);
		if (verdict !== "accept") {
			state.coversSeq = frame.seq;
			return [ev(-1, null, { t: "ignored", reason: verdict })];
		}
		state.replay.set(frame.deviceId, replayAccept(w, frame.frameNo));
	}
	const nextRing = ring ? [...ring, frame.clientFrameId] : [frame.clientFrameId];
	state.recentFrames.set(frame.deviceId, nextRing.length > rules.dedupeRing ? nextRing.slice(-rules.dedupeRing) : nextRing);

	const events: CfgFoldEvent[] = [];
	for (let i = 0; i < frame.ops.length; i++) {
		const op = frame.ops[i]!;
		if (!isValidCfgOp(op)) {
			events.push(ev(i, null, { t: "ignored", reason: "invalid-op" }));
			continue;
		}
		const version: CfgVersion = { seq: frame.seq, index: i, deviceId: frame.deviceId };
		switch (op.t) {
			case "jsonSet":
			case "jsonDel": {
				const key = jsonRegisterKey(op.file, op.key);
				const value = op.t === "jsonSet" ? op.valueJson : null;
				events.push(ev(i, { map: "json", key, file: op.file, jsonKey: op.key }, write(state.json, key, value, version, strictEq)));
				break;
			}
			case "filePut":
			case "fileDel": {
				const value: CfgFileValue | null = op.t === "filePut" ? { content: op.content, pluginVersion: op.pluginVersion } : null;
				events.push(ev(i, { map: "files", key: op.file }, write(state.files, op.file, value, version, cfgFileValuesEqual)));
				break;
			}
			case "pluginSet":
			case "pluginDel": {
				const value = op.t === "pluginSet" ? op.enabled : null;
				events.push(ev(i, { map: "plugins", key: op.pluginId }, write(state.plugins, op.pluginId, value, version, strictEq)));
				break;
			}
		}
	}
	state.coversSeq = frame.seq;
	return events;
}

export function foldCfgFrame(state: CfgFoldState, frame: CfgFrame): CfgFoldEvent[] {
	return foldCfgFrameWith(DEFAULT_CFG_FOLD_RULES, state, frame);
}

/** Registers whose value changed in these events (deduplicated, in event order). */
export function changedRegisters(events: readonly CfgFoldEvent[]): CfgRegisterRef[] {
	const seen = new Set<string>();
	const out: CfgRegisterRef[] = [];
	for (const e of events) {
		if (e.outcome.t !== "applied" || e.register === null) continue;
		const id = `${e.register.map}:${e.register.key}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(e.register);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Overlay (own pending frames on top of the committed fold)
// ---------------------------------------------------------------------------

export interface PendingCfgFrame {
	readonly clientFrameId: ClientFrameId;
	/** Sealed frameNo (≥ 1; 0 = unknown, skips the replay window). */
	readonly frameNo: number;
	readonly ops: readonly CfgOp[];
}

/**
 * Folds own pending frames over a copy of the committed state with pseudo-seqs
 * coversSeq + 1 + i. The committed state is not modified.
 */
export function overlayPendingCfg(state: CfgFoldState, deviceId: DeviceId, frames: readonly PendingCfgFrame[]): { readonly state: CfgFoldState; readonly events: readonly CfgFoldEvent[] } {
	const s = cloneCfgFold(state);
	const events: CfgFoldEvent[] = [];
	frames.forEach((f, i) => {
		events.push(...foldCfgFrame(s, { seq: state.coversSeq + 1 + i, deviceId, clientFrameId: f.clientFrameId, frameNo: f.frameNo, ops: f.ops }));
	});
	return { state: s, events };
}
