/**
 * One warn for local files sync leaves out where the user would not expect it (DESIGN §f.6): a
 * file over its size limit, or a name some systems cannot store (§c.2). The old client only
 * logged these (adfa7a7:src/runtime/reconciliationController.ts, "syncFileFromDisk: skipping").
 *
 * Deliberate skips stay silent: exclude patterns, attachments turned off, attachments without a
 * blob store (no server-metadata UI), and every path with a dot segment (the config dir, .trash,
 * hidden files; Obsidian does not index them, §c.2).
 *
 * The gate notifies when a path joins the skip set: an unchanged or shrinking set says nothing,
 * a file that leaves and comes back is news again. It lives with the Reconciler, so an unchanged
 * set is reported once per engine start.
 */

import { FORBIDDEN_PATH_CHARS } from "../../core/limits";
import type { LocalEntry, PathKey, VaultPath } from "../../core/types";
import { pathInvalidReason, type PathInvalidReason } from "../../core/plan/pathRules";
import type { Classified } from "./localState";

export interface Skipped {
	readonly path: VaultPath;
	readonly pathKey: PathKey;
	readonly why: "too-large" | "name";
	/** Why, as the tail of a sentence ("larger than the 24 MiB limit"). */
	readonly detail: string;
}

const MIB = 1024 * 1024;

/** A limit as text, rounded down: never more than the limit (98,566,143 bytes is "93.9 MiB", not "94 MiB"). */
export function sizeText(bytes: number): string {
	if (bytes >= MIB) return `${Math.floor((bytes / MIB) * 10) / 10} MiB`;
	return bytes >= 1024 ? `${Math.floor(bytes / 1024)} KiB` : `${bytes} B`;
}

function nameProblem(reason: PathInvalidReason | null): string {
	switch (reason) {
		case "forbidden-char": return `contains one of ${FORBIDDEN_PATH_CHARS.split("").join(" ")}`;
		case "control-char": return "contains a control character";
		case "lone-surrogate": return "contains an invalid character";
		case "reserved-stem": return "is reserved on Windows (CON, NUL, COM1, ...)";
		case "trailing-dot-or-space": return "ends in a dot or a space";
		case "segment-too-long":
		case "path-too-long": return "is too long";
		default: return "is not valid on every system";
	}
}

const hidden = (path: string): boolean => path.split("/").some((s) => s.startsWith("."));

/** Excluded entries that are too large or badly named, sorted by path. `classify` is Ctx.classify. */
export function unexpectedSkips(entries: Iterable<LocalEntry>, classify: (diskPath: string, size: number) => Classified): Skipped[] {
	const out: Skipped[] = [];
	for (const e of entries) {
		if (!e.excluded) continue;
		const c = classify(e.diskPath, e.size);
		if (hidden(c.path) || c.reason === "pattern" || c.reason === "attachments-off" || c.reason === "no-blob-store") continue;
		// reason null: the read found more bytes than the stat said (scan.ts hashPending, "too-large").
		if (c.reason === "invalid-path") {
			out.push({ path: c.path, pathKey: c.pathKey, why: "name", detail: `the name ${nameProblem(pathInvalidReason(c.path))}` });
		} else {
			out.push({ path: c.path, pathKey: c.pathKey, why: "too-large", detail: `larger than the ${sizeText(c.maxBytes)} limit` });
		}
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function skipNotice(skips: readonly Skipped[]): string {
	const first = skips[0]!;
	if (skips.length === 1) return `YAOS is not syncing “${first.path}”: ${first.detail}.`;
	const big = skips.filter((s) => s.why === "too-large").length;
	const tallies = [big > 0 ? `${big} too large` : "", big < skips.length ? `${skips.length - big} with an unsupported name` : ""];
	return `YAOS is not syncing ${skips.length} files (${tallies.filter((t) => t !== "").join(", ")}); first: “${first.path}”, ${first.detail}.`;
}

export class SkipNoticeGate {
	private known = new Set<PathKey>();

	/** The notice text when `skips` holds a path the last call did not; else null. */
	next(skips: readonly Skipped[]): string | null {
		const fresh = skips.some((s) => !this.known.has(s.pathKey));
		this.known = new Set(skips.map((s) => s.pathKey));
		return fresh ? skipNotice(skips) : null;
	}
}
