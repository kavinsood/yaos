/**
 * Pure model behind the snapshot dialogs (DESIGN §j.4): list rows, the file filter and selection,
 * confirm copy and the restore summary. No obsidian runtime import.
 */

import type { VaultPath } from "../../core/types";
import type { EngineResultValue, SnapshotFileEntry, SnapshotReason, SnapshotSkippedEntry, SnapshotSummary } from "../../protocol/messages";
import { formatBytes, plural } from "./format";

/** The files dialog renders at most this many matching rows; the filter narrows the rest. */
export const MAX_FILE_ROWS = 500;
/** Skipped entries and failed paths listed by name before "…and N more". */
export const MAX_LISTED_PATHS = 10;

export type RestoreResult = Extract<EngineResultValue, { t: "restored" }>;

export function snapshotReasonLabel(reason: SnapshotReason): string {
	switch (reason) {
		case "daily": return "Daily";
		case "manual": return "Created by you";
		case "restore": return "Before a restore";
		case "brake": return "Before approving held changes";
		case "epoch": return "Before re-syncing after a server reset";
		case "idb": return "Before recovering the local sync database";
	}
}

/** Local time, "2026-10-05 14:03". */
export function formatSnapshotTime(atMs: number): string {
	const d = new Date(atMs);
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export interface SnapshotRow {
	readonly id: string;
	/** "2026-10-05 14:03 · Daily" */
	readonly title: string;
	/** "12 files, 3.4 MiB" */
	readonly detail: string;
}

export function snapshotRow(s: SnapshotSummary): SnapshotRow {
	return {
		id: s.id,
		title: `${formatSnapshotTime(s.createdAtMs)} · ${snapshotReasonLabel(s.reason)}`,
		detail: `${plural(s.files, "file")}, ${formatBytes(s.bytes)}`,
	};
}

/** Rows newest first (the engine lists oldest first). */
export function snapshotRows(list: readonly SnapshotSummary[]): SnapshotRow[] {
	return [...list]
		.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
		.map(snapshotRow);
}

// ---------------------------------------------------------------------------
// Files: filter and selection
// ---------------------------------------------------------------------------

/**
 * Files whose path contains every whitespace-separated term of `query` (case-insensitive),
 * sorted by path. An empty query matches everything.
 */
export function filterFiles(files: readonly SnapshotFileEntry[], query: string): SnapshotFileEntry[] {
	const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
	return files
		.filter((f) => { const p = f.path.toLowerCase(); return terms.every((t) => p.includes(t)); })
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface FileView {
	/** Every match, for "Select all matching". */
	readonly matching: readonly SnapshotFileEntry[];
	/** The rows to render (the first MAX_FILE_ROWS matches). */
	readonly shown: readonly SnapshotFileEntry[];
	/** Shown under the list when matches were cut, else null. */
	readonly moreText: string | null;
}

export function fileView(files: readonly SnapshotFileEntry[], query: string): FileView {
	const matching = filterFiles(files, query);
	const shown = matching.slice(0, MAX_FILE_ROWS);
	const hidden = matching.length - shown.length;
	return {
		matching,
		shown,
		moreText: hidden > 0 ? `Showing the first ${shown.length} of ${plural(matching.length, "matching file")}. Type in the filter to narrow the list; "Select all matching" includes the hidden ones.` : null,
	};
}

export function withPath(selection: ReadonlySet<VaultPath>, path: VaultPath, on: boolean): Set<VaultPath> {
	const next = new Set(selection);
	if (on) next.add(path);
	else next.delete(path);
	return next;
}

export function withAll(selection: ReadonlySet<VaultPath>, files: readonly SnapshotFileEntry[]): Set<VaultPath> {
	const next = new Set(selection);
	for (const f of files) next.add(f.path);
	return next;
}

/** Selected paths that are in the snapshot, in snapshot order (the restore command's `paths`). */
export function selectedPaths(files: readonly SnapshotFileEntry[], selection: ReadonlySet<VaultPath>): VaultPath[] {
	return files.filter((f) => selection.has(f.path)).map((f) => f.path);
}

export function selectionText(selected: number, total: number): string {
	return selected === 0 ? `No files selected (${plural(total, "file")} in this snapshot).` : `${selected} of ${plural(total, "file")} selected.`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
	readonly title: string;
	readonly message: string;
	readonly confirmText: string;
}

const RESTORE_HOW =
	"Current files that differ from the snapshot are kept as conflict copies next to the restored file, so nothing is lost. Files that match are left alone, and files created since the snapshot are not touched.\n\n" +
	"YAOS first saves a safety snapshot of the vault as it is now. The restored files then sync to your other devices like ordinary edits.";

export function restoreAllCopy(row: SnapshotRow): ConfirmCopy {
	return { title: "Restore all files from this snapshot?", message: `Snapshot: ${row.title} (${row.detail}).\n\n${RESTORE_HOW}`, confirmText: "Restore all" };
}

export function restoreSelectedCopy(row: SnapshotRow, count: number): ConfirmCopy {
	return { title: `Restore ${plural(count, "file")}?`, message: `Snapshot: ${row.title}.\n\n${RESTORE_HOW}`, confirmText: "Restore" };
}

export function deleteCopy(row: SnapshotRow): ConfirmCopy {
	return {
		title: "Delete this snapshot?",
		message: `Snapshot: ${row.title} (${row.detail}).\n\nThe snapshot file is removed from this device. Your notes are not changed.`,
		confirmText: "Delete",
	};
}

function listed(paths: readonly string[]): string {
	const shown = paths.slice(0, MAX_LISTED_PATHS);
	return paths.length > shown.length ? `${shown.join(", ")} and ${paths.length - shown.length} more` : shown.join(", ");
}

/** Warning for files the snapshot left out, or null when nothing was skipped. */
export function skippedText(skipped: readonly SnapshotSkippedEntry[]): { readonly heading: string; readonly lines: readonly string[]; readonly moreText: string | null } | null {
	if (skipped.length === 0) return null;
	const shown = skipped.slice(0, MAX_LISTED_PATHS);
	return {
		heading: `${plural(skipped.length, "file was", "files were")} not saved in this snapshot and cannot be restored from it:`,
		lines: shown.map((s) => `${s.path} (${s.reason === "too-large" ? "attachment over 1 MiB" : "could not be read"})`),
		moreText: skipped.length > shown.length ? `…and ${skipped.length - shown.length} more.` : null,
	};
}

/** One-line Notice after a restore. */
export function restoreSummary(r: RestoreResult): string {
	const parts = [`restored ${plural(r.restored, "file")}`];
	if (r.unchanged > 0) parts.push(`${plural(r.unchanged, "file")} already matched`);
	let text = `${parts.join("; ")}.`;
	if (r.copies.length > 0) text += ` Your differing versions were kept as ${plural(r.copies.length, "conflict copy", "conflict copies")}.`;
	if (r.failed.length > 0) text += ` ${plural(r.failed.length, "file")} could not be restored: ${listed(r.failed)}.`;
	return text;
}
