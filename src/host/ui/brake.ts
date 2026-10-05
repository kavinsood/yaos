/**
 * Safety brake copy and the "open once per brake id" tracker (DESIGN §f.5). Pure.
 */

import type { BrakeReport } from "../../core/types";
import { plural } from "./format";

export const MAX_SAMPLE_PATHS_SHOWN = 10;

/** One-line summary, e.g. for the status bar tooltip. */
export function brakeHeadline(report: BrakeReport): string {
	return `YAOS is holding ${plural(report.heldCount, "change")} for your approval (${brakeReasonShort(report.reason)}).`;
}

export function brakeReasonShort(reason: BrakeReport["reason"]): string {
	switch (reason) {
		case "mass-delete-local": return "many files deleted on this device";
		case "mass-delete-remote": return "many files deleted on another device";
		case "mass-overwrite": return "many files would shrink a lot";
		case "listing-shrank": return "far fewer files than expected";
		case "conflict-flood": return "many conflicts at once";
		case "ns-divergence": return "file list disagrees with the server";
	}
}

/** Plain-language explanation of why the brake held the changes. */
export function brakeReasonText(reason: BrakeReport["reason"]): string {
	switch (reason) {
		case "mass-delete-local":
			return "Many files were deleted on this device. YAOS paused before deleting them on the server and your other devices.";
		case "mass-delete-remote":
			return "Another device deleted many files. YAOS paused before deleting them from this device.";
		case "mass-overwrite":
			return "Many files would be replaced by much shorter versions. YAOS paused before overwriting them.";
		case "listing-shrank":
			return "This vault folder has far fewer files than YAOS expected. The folder may be missing, moved or not mounted. YAOS paused every delete until you confirm.";
		case "conflict-flood":
			return "An unusually large number of conflict copies would be created at once. YAOS paused before creating them.";
		case "ns-divergence":
			return "This device's view of the file list does not match the server's. YAOS paused destructive changes until you decide.";
	}
}

export interface BrakeCopy {
	readonly title: string;
	readonly reason: string;
	readonly counts: string;
	readonly samplePaths: readonly string[];
	readonly moreCount: number;
	readonly approveHint: string;
	readonly rejectHint: string;
}

export function brakeCopy(report: BrakeReport): BrakeCopy {
	const shown = report.samplePaths.slice(0, MAX_SAMPLE_PATHS_SHOWN);
	return {
		title: "YAOS paused a risky change",
		reason: brakeReasonText(report.reason),
		counts: `${plural(report.heldCount, "change")} held; ${plural(report.syncedCount, "file")} currently in sync.`,
		samplePaths: shown,
		moreCount: Math.max(0, report.heldCount - shown.length),
		approveHint: "Approve applies the held changes. YAOS saves a recovery snapshot of the affected files first.",
		rejectHint: "Reject keeps files: deletes from other devices are skipped here, and files deleted on this device are restored from the server.",
	};
}

/** Remembers which brake ids were already shown so each id pops up at most once. */
export class BrakeTracker {
	private readonly seen = new Set<string>();

	/** True the first time `report` (by id) is seen; false for null or repeats. */
	shouldOpen(report: BrakeReport | null): report is BrakeReport {
		if (!report || this.seen.has(report.id)) return false;
		this.seen.add(report.id);
		if (this.seen.size > 64) {
			const first = this.seen.values().next();
			if (!first.done) this.seen.delete(first.value);
		}
		return true;
	}
}
