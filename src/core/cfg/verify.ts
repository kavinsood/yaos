/**
 * cfg checkpoint verification (DESIGN §b.5 "Verification is V1 + V2").
 *
 * V2 (decided by WP-A, wp-a-notes.md):
 * - formatVersion 1, coversSeq a count, rings as in ns (1..64 unique valid ids).
 * - json keys are file + "\0" + key with a valid config path; values canonical JSON.
 * - files keys are valid config paths; contents valid; pluginVersion null or non-empty.
 * - plugin ids valid.
 * - every version: 1 <= seq <= coversSeq, 0 <= index < MAX_FRAME_OPS, deviceId
 *   non-empty; versions are unique across all registers (one op writes one
 *   register) and all registers with the same seq share one deviceId.
 * - Checkpoint content: encoding cfgFoldV1, foldRulesVersion ===
 *   CFG_FOLD_RULES_VERSION, coversSeq equal to the relay's and the state's.
 */

import type { CfgFoldState, CfgRegister, CfgVersion } from "../types";
import { CheckpointEncoding, type CheckpointContent } from "../envelope";
import { MAX_NS_OPS_PER_FRAME, NS_DEDUPE_RING } from "../limits";
import { bytesEqual } from "../codec/lib0";
import { isClientFrameId } from "../codec/ids";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "../codec/cfgFoldV1";
import { CFG_FOLD_RULES_VERSION, isCfgFileContent, isConfigRelPath, isPluginId, splitJsonRegisterKey } from "./fold";
import { isCanonicalJson } from "./json";

/** cfg frames share the ns op-count bound (DESIGN §b.3: opCount 1..512). */
const MAX_FRAME_OPS = MAX_NS_OPS_PER_FRAME;

export type CfgVerifyResult =
	| { readonly ok: true; readonly state: CfgFoldState }
	| { readonly ok: false; readonly reason: "malformed" | "non-canonical" | "invariant" | "covers-seq" | "rules-version"; readonly detail: string };

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** V2. Returns the first violation or null. */
export function checkCfgInvariants(state: CfgFoldState): string | null {
	if (state.formatVersion !== 1) return "formatVersion != 1";
	if (!isCount(state.coversSeq)) return "bad coversSeq";
	for (const [device, ring] of state.recentFrames) {
		if (typeof device !== "string" || device.length === 0) return "empty deviceId in rings";
		if (ring.length < 1 || ring.length > NS_DEDUPE_RING) return `ring ${device} size ${ring.length}`;
		if (new Set(ring).size !== ring.length) return `ring ${device} has duplicates`;
		for (const f of ring) if (!isClientFrameId(f)) return `ring ${device} has invalid id`;
	}
	const versions = new Set<string>();
	const seqDevice = new Map<number, string>();
	const checkVersion = (where: string, v: CfgVersion): string | null => {
		if (!isCount(v.seq) || v.seq < 1 || v.seq > state.coversSeq) return `${where}: version seq ${v.seq} out of 1..${state.coversSeq}`;
		if (!isCount(v.index) || v.index >= MAX_FRAME_OPS) return `${where}: version index ${v.index}`;
		if (typeof v.deviceId !== "string" || v.deviceId.length === 0) return `${where}: empty version deviceId`;
		const id = `${v.seq}:${v.index}`;
		if (versions.has(id)) return `${where}: version ${id} used twice`;
		versions.add(id);
		const d = seqDevice.get(v.seq);
		if (d !== undefined && d !== v.deviceId) return `${where}: seq ${v.seq} written by ${d} and ${v.deviceId}`;
		seqDevice.set(v.seq, v.deviceId);
		return null;
	};
	const section = <T>(name: string, m: ReadonlyMap<string, CfgRegister<T>>, keyOk: (k: string) => boolean, valueOk: (v: T) => boolean): string | null => {
		for (const [k, reg] of m) {
			const where = `${name}[${JSON.stringify(k)}]`;
			if (!keyOk(k)) return `${where}: invalid key`;
			if (reg.value !== null && !valueOk(reg.value)) return `${where}: invalid value`;
			const e = checkVersion(where, reg.version);
			if (e !== null) return e;
		}
		return null;
	};
	return (
		section("json", state.json, (k) => {
			const s = splitJsonRegisterKey(k);
			return s !== null && isConfigRelPath(s.file);
		}, (v) => isCanonicalJson(v))
		?? section("files", state.files, isConfigRelPath, (v) => isCfgFileContent(v.content) && (v.pluginVersion === null || (typeof v.pluginVersion === "string" && v.pluginVersion.length > 0)))
		?? section("plugins", state.plugins, isPluginId, (v) => typeof v === "boolean")
	);
}

/** V1 + V2 over cfgFoldV1 bytes. */
export function verifyCfgFoldBytes(bytes: Uint8Array, expectedCoversSeq: number): CfgVerifyResult {
	const state = decodeCfgFoldV1(bytes);
	if (!state) return { ok: false, reason: "malformed", detail: "cfgFoldV1 decode failed" };
	if (!bytesEqual(encodeCfgFoldV1(state), bytes)) return { ok: false, reason: "non-canonical", detail: "re-encode differs" };
	if (state.coversSeq !== expectedCoversSeq) return { ok: false, reason: "covers-seq", detail: `state ${state.coversSeq} != relay ${expectedCoversSeq}` };
	const err = checkCfgInvariants(state);
	if (err !== null) return { ok: false, reason: "invariant", detail: err };
	return { ok: true, state };
}

/** Full check of a decoded cfg checkpoint content. */
export function verifyCfgCheckpoint(content: CheckpointContent, relayCoversSeq: number): CfgVerifyResult {
	if (content.encoding !== CheckpointEncoding.cfgFoldV1) return { ok: false, reason: "malformed", detail: `encoding ${content.encoding}` };
	if (content.foldRulesVersion !== CFG_FOLD_RULES_VERSION) return { ok: false, reason: "rules-version", detail: `foldRulesVersion ${content.foldRulesVersion}` };
	if (content.coversSeq !== relayCoversSeq) return { ok: false, reason: "covers-seq", detail: `content ${content.coversSeq} != relay ${relayCoversSeq}` };
	return verifyCfgFoldBytes(content.state, relayCoversSeq);
}
