import { App, Modal, Notice } from "obsidian";
import type { SnapshotDiff, SnapshotIndex } from "../sync/snapshotClient";

/**
 * Modal that lists available snapshots and lets the user pick one.
 */
export class SnapshotListModal extends Modal {
	constructor(
		app: App,
		private snapshots: SnapshotIndex[],
		private onSelect: (snapshot: SnapshotIndex) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("snapshot-list-modal");

		contentEl.createEl("h3", { text: "Available snapshots" });
		contentEl.createEl("p", {
			text: `${this.snapshots.length} snapshot(s) found. Select one to see a diff and restore files.`,
			cls: "setting-item-description",
		});

		const list = contentEl.createDiv({ cls: "snapshot-list" });

		for (const snap of this.snapshots) {
			const item = list.createDiv({ cls: "snapshot-list-item" });

			const date = new Date(snap.createdAt);
			const dateStr = date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});

			const title = item.createEl("div");
			title.createEl("strong", { text: dateStr });
			if (snap.triggeredBy) {
				title.createEl("span", {
					text: ` (${snap.triggeredBy})`,
					cls: "setting-item-description",
				});
			}

			item.createEl("div", {
				text: `${snap.markdownFileCount} notes, ${snap.blobFileCount} attachments ` +
					`(${Math.round(snap.crdtSizeBytes / 1024)} KB)`,
				cls: "setting-item-description",
			});

			item.addEventListener("click", () => {
				this.close();
				void this.onSelect(snap);
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Modal that shows a diff between a snapshot and the current CRDT state.
 * Lets the user select files to restore.
 */
export class SnapshotDiffModal extends Modal {
	private selectedMd = new Set<string>();
	private selectedBlobs = new Set<string>();
	/** Set to true when restore is initiated — prevents cleanup from running twice. */
	private didRestore = false;

	constructor(
		app: App,
		private snapshot: SnapshotIndex,
		private diff: SnapshotDiff,
		private onRestore: (markdownPaths: string[], blobPaths: string[]) => void | Promise<void>,
		private cleanup: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("snapshot-diff-modal");

		const date = new Date(this.snapshot.createdAt);
		const dateStr = date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		contentEl.createEl("h3", { text: `Snapshot: ${dateStr}` });

		const { diff } = this;
		const totalChanges = diff.deletedSinceSnapshot.length +
			diff.contentChanged.length +
			diff.blobsDeletedSinceSnapshot.length +
			diff.blobsChanged.length;

		if (totalChanges === 0 && diff.createdSinceSnapshot.length === 0) {
			contentEl.createEl("p", { text: "No differences found between the snapshot and current state." });
			return;
		}

		contentEl.createEl("p", {
			text: "Select files to restore from the snapshot. " +
				"Created-since-snapshot files are shown for reference but cannot be \"restored\" (they didn't exist yet).",
			cls: "setting-item-description",
		});

		// --- Deleted since snapshot (can restore = undelete) ---
		if (diff.deletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Deleted since snapshot (can undelete)",
				diff.deletedSinceSnapshot.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Content changed (can restore to snapshot version) ---
		if (diff.contentChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Content changed since snapshot",
				diff.contentChanged.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Created since snapshot (informational only) ---
		if (diff.createdSinceSnapshot.length > 0) {
			const section = contentEl.createDiv();
			section.createEl("h4", { text: `Created since snapshot (${diff.createdSinceSnapshot.length})` });
			const listEl = section.createEl("ul");
			for (const path of diff.createdSinceSnapshot) {
				listEl.createEl("li", { text: path, cls: "setting-item-description" });
			}
		}

		// --- Blob changes ---
		if (diff.blobsDeletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments deleted since snapshot",
				diff.blobsDeletedSinceSnapshot.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		if (diff.blobsChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments changed since snapshot",
				diff.blobsChanged.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		// --- Unchanged summary ---
		if (diff.unchanged.length > 0) {
			contentEl.createEl("p", {
				text: `${diff.unchanged.length} file(s) unchanged.`,
				cls: "setting-item-description",
			});
		}

		// --- Restore button ---
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container snapshot-diff-actions" });

		buttonRow
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());

		const restoreBtn = buttonRow.createEl("button", {
			text: "Restore selected",
			cls: "mod-cta",
		});
		restoreBtn.addEventListener("click", () => {
			const mdPaths = Array.from(this.selectedMd);
			const blobPaths = Array.from(this.selectedBlobs);

			if (mdPaths.length === 0 && blobPaths.length === 0) {
				new Notice("No files selected for restore.");
				return;
			}

			this.didRestore = true;
			this.close();
			void this.onRestore(mdPaths, blobPaths);
		});
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		paths: string[],
		selectedSet: Set<string>,
	): void {
		const section = container.createDiv({ cls: "snapshot-diff-section" });
		section.createEl("h4", { text: `${title} (${paths.length})` });

		// Select all toggle
		const toggleRow = section.createDiv({ cls: "snapshot-diff-select-all-row" });
		const selectAll = toggleRow.createEl("a", { text: "Select all", href: "#" });
		selectAll.addEventListener("click", (e) => {
			e.preventDefault();
			for (const p of paths) selectedSet.add(p);
			// Re-check all checkboxes in this section
			section.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(
				(cb) => { cb.checked = true; },
			);
		});

		for (const path of paths) {
			const row = section.createDiv({ cls: "snapshot-diff-path-row" });
			const label = row.createEl("label", { cls: "snapshot-diff-path-label" });
			const cb = label.createEl("input", {
				type: "checkbox",
				cls: "snapshot-diff-path-checkbox",
			});
			label.appendText(path);

			cb.addEventListener("change", () => {
				if (cb.checked) {
					selectedSet.add(path);
				} else {
					selectedSet.delete(path);
				}
			});
		}
	}

	onClose() {
		this.contentEl.empty();
		// Always clean up the snapshot doc unless restore already handled it.
		if (!this.didRestore) {
			this.cleanup();
		}
	}
}
