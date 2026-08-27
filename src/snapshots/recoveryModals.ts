import { App, Modal, Notice } from "obsidian";
import type {
	CaptureStatus,
	DeletedFileManifestEntry,
	RecoverySnapshotSummary,
	RecoveryStatus,
	RestoreSelection,
	SnapshotPathEntry,
	SnapshotRootV2,
} from "./recoveryClient";
import { isRecoveryTerminal } from "./recoveryClient";

export class RecoverySnapshotListModal extends Modal {
	constructor(
		app: App,
		private readonly snapshots: RecoverySnapshotSummary[],
		private readonly onInspect: (snapshot: RecoverySnapshotSummary) => void | Promise<void>,
		private readonly onDelete: (snapshot: RecoverySnapshotSummary) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("snapshot-list-modal");
		this.contentEl.createEl("h3", { text: "Vault recovery" });
		this.contentEl.createEl("p", {
			text: `${this.snapshots.length} finalized recovery point(s). Browsing reads only bounded tree branches, never a complete manifest.`,
			cls: "setting-item-description",
		});
		const list = this.contentEl.createDiv({ cls: "snapshot-list" });
		for (const snapshot of this.snapshots) {
			const item = list.createDiv({ cls: "snapshot-list-item" });
			item.createEl("strong", { text: new Date(snapshot.completedAt).toLocaleString() });
			item.createDiv({
				text: `Sequence ${snapshot.boundarySequence} · ${snapshot.reason}${snapshot.pinned ? " · retained" : ""} · root ${snapshot.rootHash.slice(0, 12)}…`,
				cls: "setting-item-description",
			});
			const buttons = item.createDiv({ cls: "modal-button-container" });
			buttons.createEl("button", { text: "Browse" }).addEventListener("click", () => {
				this.close();
				void this.onInspect(snapshot);
			});
			buttons.createEl("button", { text: "Delete recovery point", cls: "mod-warning" }).addEventListener("click", () => {
				void this.onDelete(snapshot);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class RecoveryBrowseModal extends Modal {
	private resultEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly snapshot: SnapshotRootV2,
		private readonly lookupPath: (path: string) => Promise<SnapshotPathEntry | null>,
		private readonly lookupDeleted: (bodyId: string) => Promise<DeletedFileManifestEntry | null>,
		private readonly onRestore: (selection: RestoreSelection) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("snapshot-diff-modal");
		this.contentEl.createEl("h3", { text: `Recovery point: ${new Date(this.snapshot.completedAt).toLocaleString()}` });
		this.contentEl.createEl("p", {
			text: "Look up one canonical path or deleted body identity. Each lookup follows only its bounded hash-radix branch.",
			cls: "setting-item-description",
		});
		this.contentEl.createEl("p", {
			text: `${this.snapshot.totals.activeFiles} notes · ${this.snapshot.totals.deletedFiles} deleted identities · ${this.snapshot.totals.attachments} attachments`,
			cls: "setting-item-description",
		});
		if (this.snapshot.health === "complete_with_gaps") {
			this.contentEl.createEl("p", {
				text: `${this.snapshot.totals.unavailableFiles} item(s) are unavailable because source history or bytes could not be verified. They remain inspectable but cannot be restored.`,
				cls: "setting-item-description mod-warning",
			});
		}
		this.renderLookupRow("Active note or attachment path", "Folder/file.md", async (value) => {
			const entry = await this.lookupPath(value);
			this.renderPathResult(value, entry);
		});
		this.renderLookupRow("Deleted body identity", "body ID", async (value) => {
			const entry = await this.lookupDeleted(value);
			this.renderDeletedResult(value, entry);
		});
		this.resultEl = this.contentEl.createDiv({ cls: "snapshot-diff-section" });
		const bulk = this.contentEl.createDiv({ cls: "snapshot-diff-section" });
		bulk.createEl("h4", { text: "Bulk restore" });
		bulk.createEl("p", {
			text: "Restore all available items through bounded item pages. Missing or corrupt entries are reported by the job and never replaced with placeholders.",
			cls: "setting-item-description",
		});
		bulk.createEl("button", { text: "Back up and restore all", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			void this.onRestore({ kind: "all" });
		});
	}

	private renderLookupRow(labelText: string, placeholder: string, lookup: (value: string) => Promise<void>): void {
		const section = this.contentEl.createDiv({ cls: "snapshot-diff-section" });
		section.createEl("h4", { text: labelText });
		const input = section.createEl("input", { type: "text", placeholder });
		const button = section.createEl("button", { text: "Look up" });
		button.addEventListener("click", () => {
			const value = input.value.trim();
			if (!value) {
				new Notice(`Enter ${labelText.toLowerCase()}.`);
				return;
			}
			button.disabled = true;
			void lookup(value).catch((error: unknown) => {
				this.renderError(error instanceof Error ? error.message : String(error));
			}).finally(() => {
				button.disabled = false;
			});
		});
	}

	private renderPathResult(path: string, entry: SnapshotPathEntry | null): void {
		const result = this.prepareResult();
		if (!entry) {
			result.createEl("p", { text: `No entry exists at “${path}” in this recovery point.` });
			return;
		}
		const attachment = "hash" in entry || "expectedHash" in entry;
		result.createEl("h4", { text: attachment ? "Attachment" : "Markdown note" });
		result.createEl("p", { text: entry.path });
		if (entry.availability === "unavailable") {
			result.createEl("p", {
				text: `Unavailable: ${entry.errorCode} (reference ${entry.errorReference}). No restore is permitted.`,
				cls: "setting-item-description mod-warning",
			});
			return;
		}
		const contentHash = "hash" in entry ? entry.hash : entry.contentHash;
		result.createEl("p", {
			text: `${entry.size} bytes · ${contentHash.slice(0, 12)}…`,
			cls: "setting-item-description",
		});
		result.createEl("button", { text: "Back up and restore this item", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			if ("hash" in entry) void this.onRestore({ kind: "attachment-paths", paths: [entry.path] });
			else void this.onRestore({ kind: "markdown-paths", paths: [entry.path] });
		});
	}

	private renderDeletedResult(bodyId: string, entry: DeletedFileManifestEntry | null): void {
		const result = this.prepareResult();
		if (!entry) {
			result.createEl("p", { text: `No deleted identity “${bodyId}” exists in this recovery point.` });
			return;
		}
		result.createEl("h4", { text: "Deleted Markdown identity" });
		result.createEl("p", { text: `${entry.lastPath} · body ${entry.bodyId}` });
		if (entry.availability === "unavailable") {
			result.createEl("p", {
				text: `Unavailable: ${entry.errorCode} (reference ${entry.errorReference}). No empty replacement will be created.`,
				cls: "setting-item-description mod-warning",
			});
			return;
		}
		result.createEl("p", {
			text: `${entry.baselineSize} bytes · deleted at sequence ${entry.deletedAtSequence}${entry.bodyReaped ? " · history reaped after baseline preservation" : ""}`,
			cls: "setting-item-description",
		});
		result.createEl("button", { text: "Restore as a fresh file identity", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			void this.onRestore({ kind: "deleted-identities", bodyIds: [entry.bodyId] });
		});
	}

	private renderError(message: string): void {
		const result = this.prepareResult();
		result.createEl("p", { text: message, cls: "setting-item-description mod-warning" });
	}

	private prepareResult(): HTMLElement {
		if (!this.resultEl) this.resultEl = this.contentEl.createDiv({ cls: "snapshot-diff-section" });
		this.resultEl.empty();
		return this.resultEl;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class RecoveryCaptureStatusModal extends Modal {
	constructor(
		app: App,
		private recovery: RecoveryStatus,
		private capture: CaptureStatus | null,
		private readonly onCancelCapture: () => void | Promise<void>,
		private readonly onCancelRestore: () => void | Promise<void>,
		private readonly onRefresh: () => void | Promise<void>,
	) {
		super(app);
	}

	setRecoveryStatus(status: RecoveryStatus): void {
		this.recovery = status;
		this.render();
	}

	setCaptureStatus(status: CaptureStatus): void {
		this.capture = status;
		this.render();
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("snapshot-list-modal");
		this.contentEl.createEl("h3", { text: "Recovery status" });
		this.addFact("Sync", this.recovery.syncReady ? "Ready" : "Not ready");
		const readiness = !this.recovery.storageAvailable
			? "Unavailable"
			: this.capture?.state === "failed" || this.recovery.activeRestore?.state === "failed"
				? "Failure"
				: this.capture?.state === "retrying" || this.recovery.activeRestore?.state === "retrying" || this.recovery.projectionState === "retrying"
					? "Retrying"
					: this.capture?.state === "complete_with_gaps"
						? "Ready with gaps"
						: this.recovery.recoveryReady
							? "Ready"
							: "Preparing";
		this.addFact("Recovery", readiness);
		this.addFact("Recovery storage", this.recovery.storageAvailable ? "Available" : "Unavailable — live sync is unaffected");
		const projection = this.recovery.recoveryReady
			? "Ready"
			: this.recovery.projectionTotal === null
				? `${this.recovery.projectionState} · lag ${this.recovery.projectionLag}`
				: `${this.recovery.projectionState}: ${this.recovery.projectionProcessed} / ${this.recovery.projectionTotal} · lag ${this.recovery.projectionLag}`;
		this.addFact("Recovery preparation", projection);
		this.addFact("Oldest pin", this.recovery.oldestPinAgeMs === null ? "None" : `${Math.round(this.recovery.oldestPinAgeMs / 60_000)} minutes`);
		this.addFact("Last successful snapshot", this.recovery.lastSuccessfulSnapshot ? new Date(this.recovery.lastSuccessfulSnapshot.completedAt).toLocaleString() : "None");
		if (this.capture) {
			const total = this.capture.totalEntries;
			const percentage = total && total > 0 ? ` · ${Math.min(100, Math.floor((this.capture.processedEntries / total) * 100))}%` : "";
			this.addFact("Capture", `${this.capture.state}: ${this.capture.processedEntries}${total === null ? "" : ` / ${total}`}${percentage}`);
			this.addFact("Objects", `${this.capture.contentObjectsWritten} written · ${this.capture.contentObjectsReused} reused · ${this.capture.manifestNodesWritten} manifest nodes written`);
			if (this.capture.state === "retrying") this.addFact("Retry", `Attempt ${this.capture.retryCount + 1}${this.capture.nextAttemptAt ? ` at ${new Date(this.capture.nextAttemptAt).toLocaleTimeString()}` : ""}`);
			if (this.capture.error) this.addFact("Capture error", `${this.capture.error.code}${this.capture.error.reference ? ` · ${this.capture.error.reference}` : ""}`);
		}
		if (this.recovery.activeRestore) {
			const restore = this.recovery.activeRestore;
			const percentage = restore.totalItems && restore.totalItems > 0
				? ` · ${Math.min(100, Math.floor((restore.processedItems / restore.totalItems) * 100))}%`
				: "";
			this.addFact("Restore", `${restore.state}: ${restore.processedItems}${restore.totalItems === null ? "" : ` / ${restore.totalItems}`}${percentage}`);
			if (restore.state === "retrying") this.addFact("Restore retry", `Attempt ${restore.retryCount + 1}${restore.nextAttemptAt ? ` at ${new Date(restore.nextAttemptAt).toLocaleTimeString()}` : ""}`);
			if (restore.error) this.addFact("Restore error", `${restore.error.code}${restore.error.reference ? ` · ${restore.error.reference}` : ""}`);
		}
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Refresh" }).addEventListener("click", () => void this.onRefresh());
		if (this.capture && !isRecoveryTerminal(this.capture.state)) {
			actions.createEl("button", { text: "Cancel capture", cls: "mod-warning" }).addEventListener("click", () => void this.onCancelCapture());
		}
		if (this.recovery.activeRestore && !isRecoveryTerminal(this.recovery.activeRestore.state)) {
			actions.createEl("button", { text: "Cancel restore", cls: "mod-warning" }).addEventListener("click", () => void this.onCancelRestore());
		}
	}

	private addFact(name: string, value: string): void {
		const row = this.contentEl.createDiv({ cls: "setting-item" });
		row.createDiv({ text: name, cls: "setting-item-name" });
		row.createDiv({ text: value, cls: "setting-item-description" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
