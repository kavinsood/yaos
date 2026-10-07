/**
 * Safety brake (DESIGN §f.5). Pure.
 *
 * The planner emits *units*: the ops of one decision that must run or be held
 * together (a held diskTrash must keep its syncedDrop, otherwise the next pass
 * would re-create the file as new). The brake holds whole units.
 *
 * Decisions:
 * - A brake stands for the sorted canonical *brake keys* of the held units
 *   (`kind|docId|path|expectHash`, brakeIdentity), not the raw ops: raw ops of
 *   keep-both units contain fresh docIds and minute-stamped conflict names,
 *   which would change it on every re-plan and make approval impossible.
 *   Approval names the identity itself; `BrakeReport.id` is its sha256, taken
 *   by the engine through HashPort (brakeId): the identity grows with the
 *   vault, and this module stays synchronous.
 * - Rolling 10-minute window counts are state, so the engine passes them in
 *   (`BrakeWindow`); the planner adds them to the per-plan counts.
 * - listing-shrank is evaluated only against a complete listing count, and
 *   only when at least LISTING_SHRANK_MIN_MISSING synced files are missing
 *   (deviation: the bare ratio rule braked "delete 1 of a 1-file vault"; an
 *   unmounted vault of >= 10 files is still caught, smaller ones are below
 *   every other threshold anyway and recoverable from trash/snapshots).
 * - Several tripped reasons: all their units are held; the report names the
 *   first in priority order ns-divergence, listing-shrank, mass-delete-local,
 *   mass-delete-remote, mass-overwrite, conflict-flood.
 */

import type { HashPort } from "../../ports/crypto";
import type { BrakeConfig, BrakeReport, PlannedBrake, PlannerOp, VaultPath } from "../types";
import {
	BRAKE_LISTING_FLOOR_RATIO, BRAKE_MAX_CONFLICT_COPIES, BRAKE_MIN_COUNT, BRAKE_OVERWRITE_MIN_BYTES,
	BRAKE_OVERWRITE_SHRINK_RATIO, BRAKE_RATIO,
} from "../limits";
import { digestHex } from "../hash/digest";
import { utf8Encode } from "../hash/utf8";

export const DEFAULT_BRAKE: BrakeConfig = {
	minCount: BRAKE_MIN_COUNT,
	ratio: BRAKE_RATIO,
	listingFloorRatio: BRAKE_LISTING_FLOOR_RATIO,
	maxConflictCopies: BRAKE_MAX_CONFLICT_COPIES,
	overwriteMinBytes: BRAKE_OVERWRITE_MIN_BYTES,
	overwriteShrinkRatio: BRAKE_OVERWRITE_SHRINK_RATIO,
};

export type DestructiveKind = "nsDelete" | "diskTrash" | "overwrite" | "conflict";

export interface PlanUnit {
	readonly ops: readonly PlannerOp[];
	readonly destructive: DestructiveKind | null;
	/** Stable identity for the brake id (independent of fresh ids and wall time). */
	readonly brakeKey: string;
	readonly path: VaultPath;
}

/** Destructive ops executed in the last 10 minutes (engine state). */
export interface BrakeWindow {
	readonly nsDelete: number;
	readonly diskTrash: number;
	readonly overwrite: number;
	readonly conflict: number;
}

export const EMPTY_WINDOW: BrakeWindow = { nsDelete: 0, diskTrash: 0, overwrite: 0, conflict: 0 };

export interface BrakeInput {
	readonly config: BrakeConfig;
	readonly syncedCount: number;
	/** Live (non-excluded) local files of a COMPLETE listing; null = listing incomplete, skip listing-shrank. */
	readonly liveLocalCount: number | null;
	readonly divergence: boolean;
	readonly window: BrakeWindow;
	/** The brakeIdentity the user approved. */
	readonly approval: string | null;
}

export interface BrakeOutcome {
	readonly released: PlanUnit[];
	readonly held: PlanUnit[];
	readonly report: PlannedBrake | null;
}

export function brakeKey(kind: DestructiveKind, docId: string, path: string, expect: string): string {
	return `${kind}|${docId}|${path}|${expect}`;
}

/** What a brake stands for: the sorted brake keys of its held units, one per line (approval compares it). */
export function brakeIdentity(units: readonly { readonly brakeKey: string }[]): string {
	return units.map((u) => u.brakeKey).sort().join("\n");
}

/** BrakeReport.id of a brakeIdentity: its sha256, through HashPort. */
export async function brakeId(hash: HashPort, identity: string): Promise<string> {
	return digestHex(hash, utf8Encode(identity));
}

/** True when a write replacing `oldSize` bytes with `newSize` counts as destructive. */
export function isShrinkingOverwrite(config: BrakeConfig, oldSize: number, newSize: number): boolean {
	return oldSize >= config.overwriteMinBytes && newSize < config.overwriteShrinkRatio * oldSize;
}

export const LISTING_SHRANK_MIN_MISSING = 10;

const DESTRUCTIVE: readonly DestructiveKind[] = ["nsDelete", "diskTrash", "overwrite"];

export function applyBrake(units: readonly PlanUnit[], input: BrakeInput): BrakeOutcome {
	const { config } = input;
	const threshold = Math.max(config.minCount, config.ratio * input.syncedCount);
	const count = (kind: DestructiveKind) => units.filter((u) => u.destructive === kind).length;
	const tripped: { reason: BrakeReport["reason"]; kinds: readonly DestructiveKind[] }[] = [];
	if (input.divergence) tripped.push({ reason: "ns-divergence", kinds: DESTRUCTIVE });
	if (
		input.liveLocalCount !== null &&
		input.syncedCount - input.liveLocalCount >= LISTING_SHRANK_MIN_MISSING &&
		input.liveLocalCount < config.listingFloorRatio * input.syncedCount
	) {
		tripped.push({ reason: "listing-shrank", kinds: DESTRUCTIVE });
	}
	if (count("nsDelete") > 0 && count("nsDelete") + input.window.nsDelete > threshold) tripped.push({ reason: "mass-delete-local", kinds: ["nsDelete"] });
	if (count("diskTrash") > 0 && count("diskTrash") + input.window.diskTrash > threshold) tripped.push({ reason: "mass-delete-remote", kinds: ["diskTrash"] });
	if (count("overwrite") > 0 && count("overwrite") + input.window.overwrite > threshold) tripped.push({ reason: "mass-overwrite", kinds: ["overwrite"] });
	if (count("conflict") > 0 && count("conflict") + input.window.conflict > config.maxConflictCopies) tripped.push({ reason: "conflict-flood", kinds: ["conflict"] });

	const heldKinds = new Set<DestructiveKind>();
	for (const t of tripped) for (const k of t.kinds) heldKinds.add(k);
	const held = units.filter((u) => u.destructive !== null && heldKinds.has(u.destructive));
	if (held.length === 0) return { released: [...units], held: [], report: null };
	const identity = brakeIdentity(held);
	if (input.approval === identity) return { released: [...units], held: [], report: null };
	const heldSet = new Set(held);
	return {
		released: units.filter((u) => !heldSet.has(u)),
		held,
		report: {
			identity,
			reason: tripped[0]!.reason,
			heldCount: held.length,
			syncedCount: input.syncedCount,
			samplePaths: held.map((u) => u.path).sort().slice(0, 10),
		},
	};
}

/**
 * rejectBrake (§f.5): held remote deletes become nothing (the file stays, its
 * synced record is dropped so the next pass re-creates it as a new doc), held
 * local deletes become re-materialization of the remote doc. Other held ops
 * are dropped.
 */
export function rejectHeld(held: readonly PlannerOp[], remotePath: (docId: string) => VaultPath | null): PlannerOp[] {
	const out: PlannerOp[] = [];
	for (const op of held) {
		if (op.op === "diskTrash" && op.docId !== null) out.push({ op: "syncedDrop", docId: op.docId });
		// A held fileGone mark is the decision of a local delete (planner liveMissing): re-create too.
		const del = op.op === "nsDelete" ? op.docId : op.op === "syncedPut" && op.entry.fileGone ? op.entry.docId : null;
		if (del !== null) {
			const path = remotePath(del);
			if (path !== null) out.push({ op: "diskMaterialize", docId: del, path, expect: { t: "absent" } });
		}
	}
	return out;
}
