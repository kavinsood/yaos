/**
 * Snapshot dialogs (DESIGN §j.4): the list (create, browse, restore all, delete) and the file
 * browser (filter, select, restore selected). Copy, sorting, filtering and selection live in
 * snapshotsModel.ts; these shells only render and send commands.
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type { VaultPath } from "../../core/types";
import type { EngineResultValue, SnapshotFileEntry } from "../../protocol/messages";
import type { YaosUiHost } from "./api";
import { confirmAction } from "./confirmModal";
import { errorMessage, formatBytes } from "./format";
import {
	deleteCopy, fileView, restoreAllCopy, restoreSelectedCopy, restoreSummary, selectedPaths, selectionText, skippedText,
	loadingText, snapshotRows, withAll, withPath,
	type SnapshotRow,
} from "./snapshotsModel";

type Host = Pick<YaosUiHost, "command">;

function expect<T extends EngineResultValue["t"]>(r: EngineResultValue, t: T): Extract<EngineResultValue, { t: T }> {
	if (r.t !== t) throw new Error("unexpected answer from the sync engine");
	return r as Extract<EngineResultValue, { t: T }>;
}

/** Restores `paths` (null = all) and reports the result in a Notice. False when it failed. */
async function runRestore(host: Host, snapshotId: string, paths: readonly VaultPath[] | null): Promise<boolean> {
	try {
		const r = expect(await host.command({ t: "restoreSnapshot", snapshotId, paths }), "restored");
		new Notice(`YAOS: ${restoreSummary(r)}`, 10_000);
		return true;
	} catch (err) {
		new Notice(`YAOS: could not restore the snapshot: ${errorMessage(err)}`, 8000);
		return false;
	}
}

export class SnapshotsModal extends Modal {
	private busy = false;
	private closed = false;
	private createButton: ButtonComponent | null = null;
	private rowButtons: ButtonComponent[] = [];
	private listEl: HTMLElement | null = null;

	/** `openChild` opens (and tracks) the file browser modal. */
	constructor(app: App, private readonly host: Host, private readonly openChild: (modal: Modal) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.closed = false;
		this.setTitle("Recovery snapshots");
		contentEl.createEl("p", {
			text: "Snapshots are zips of your notes kept in this device's plugin folder. Restoring writes files back into the vault; they then sync to your other devices like ordinary edits.",
		});
		new Setting(contentEl)
			.setName("Create snapshot now")
			.setDesc("Save a snapshot of the vault as it is now.")
			.addButton((b) => {
				this.createButton = b;
				b.setButtonText("Create").setCta().onClick(() => { void this.guard(() => this.create()); });
			});
		this.listEl = contentEl.createDiv();
		void this.reload();
	}

	private async reload(): Promise<void> {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		list.createEl("p", { text: "Loading snapshots…" });
		let rows: SnapshotRow[];
		try {
			rows = snapshotRows(expect(await this.host.command({ t: "listSnapshots" }), "snapshots").snapshots);
		} catch (err) {
			if (this.closed) return;
			list.empty();
			list.createEl("p", { text: `Could not list snapshots: ${errorMessage(err)}` });
			return;
		}
		if (this.closed) return;
		list.empty();
		this.rowButtons = [];
		if (rows.length === 0) list.createEl("p", { text: "No snapshots yet." });
		for (const row of rows) {
			new Setting(list)
				.setName(row.title)
				.setDesc(row.detail)
				.addButton((b) => this.rowButton(b, "Browse files…", () => this.browse(row)))
				.addButton((b) => this.rowButton(b, "Restore all…", () => this.restoreAll(row)))
				.addButton((b) => this.rowButton(b.setWarning(), "Delete…", () => this.remove(row)));
		}
	}

	private rowButton(b: ButtonComponent, text: string, run: () => Promise<void> | void): void {
		this.rowButtons.push(b);
		b.setButtonText(text).setDisabled(this.busy).onClick(() => { void this.guard(run); });
	}

	/** One operation at a time; every button is disabled meanwhile. */
	private async guard(run: () => Promise<void> | void): Promise<void> {
		if (this.busy) return;
		this.setBusy(true);
		try {
			await run();
		} finally {
			this.setBusy(false);
		}
	}

	private setBusy(on: boolean): void {
		this.busy = on;
		this.createButton?.setDisabled(on);
		for (const b of this.rowButtons) b.setDisabled(on);
	}

	private async create(): Promise<void> {
		try {
			await this.host.command({ t: "createSnapshot" });
			new Notice("YAOS: snapshot created.");
		} catch (err) {
			new Notice(`YAOS: could not create a snapshot: ${errorMessage(err)}`, 8000);
			return;
		}
		await this.reload();
	}

	private async restoreAll(row: SnapshotRow): Promise<void> {
		if (!(await confirmAction(this.app, restoreAllCopy(row)))) return;
		if (await runRestore(this.host, row.id, null)) await this.reload();
	}

	private async remove(row: SnapshotRow): Promise<void> {
		if (!(await confirmAction(this.app, deleteCopy(row)))) return;
		try {
			await this.host.command({ t: "deleteSnapshot", snapshotId: row.id });
			new Notice("YAOS: snapshot deleted.");
		} catch (err) {
			new Notice(`YAOS: could not delete the snapshot: ${errorMessage(err)}`, 8000);
		}
		await this.reload();
	}

	private browse(row: SnapshotRow): void {
		this.openChild(new SnapshotFilesModal(this.app, this.host, row, () => { if (!this.closed) void this.reload(); }));
	}

	onClose(): void {
		this.closed = true;
		this.createButton = null;
		this.rowButtons = [];
		this.listEl = null;
		this.contentEl.empty();
	}
}

export class SnapshotFilesModal extends Modal {
	private files: readonly SnapshotFileEntry[] = [];
	private selection: Set<VaultPath> = new Set();
	private query = "";
	private busy = false;
	private closed = false;
	private buttons: ButtonComponent[] = [];
	private restoreButton: ButtonComponent | null = null;
	private statusEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private moreEl: HTMLElement | null = null;

	constructor(app: App, private readonly host: Host, readonly row: SnapshotRow, private readonly onRestored: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.closed = false;
		this.setTitle("Snapshot files");
		contentEl.createEl("p", { text: `${this.row.title} (${this.row.detail})` });
		const body = contentEl.createDiv();
		body.createEl("p", { text: loadingText(this.row) });
		void this.load(body);
	}

	private async load(body: HTMLElement): Promise<void> {
		let res: Extract<EngineResultValue, { t: "snapshotFiles" }>;
		try {
			res = expect(await this.host.command({ t: "snapshotFiles", snapshotId: this.row.id }), "snapshotFiles");
		} catch (err) {
			if (this.closed) return;
			body.empty();
			body.createEl("p", { text: `Could not read the snapshot: ${errorMessage(err)}` });
			return;
		}
		if (this.closed) return;
		this.files = res.files;
		body.empty();
		const skipped = skippedText(res.skipped);
		if (skipped) {
			const warn = body.createDiv();
			const head = warn.createEl("p");
			head.createEl("strong", { text: "Warning: " });
			head.appendText(skipped.heading);
			const ul = warn.createEl("ul");
			for (const line of skipped.lines) ul.createEl("li", { text: line });
			if (skipped.moreText) warn.createEl("p", { text: skipped.moreText });
		}
		if (this.files.length === 0) {
			body.createEl("p", { text: "This snapshot has no files." });
			return;
		}
		new Setting(body)
			.setName("Filter")
			.addText((t) => t.setPlaceholder("Part of a file path").onChange((v) => { this.query = v; this.renderList(); }));
		new Setting(body)
			.addButton((b) => {
				this.buttons.push(b);
				b.setButtonText("Select all matching").onClick(() => {
					this.selection = withAll(this.selection, fileView(this.files, this.query).matching);
					this.renderList();
				});
			})
			.addButton((b) => {
				this.buttons.push(b);
				b.setButtonText("Clear selection").onClick(() => { this.selection = new Set(); this.renderList(); });
			})
			.addButton((b) => {
				this.restoreButton = b;
				b.setButtonText("Restore selected…").setCta().onClick(() => { void this.restoreSelected(); });
			});
		this.statusEl = body.createEl("p");
		this.listEl = body.createDiv();
		this.moreEl = body.createEl("p");
		this.renderList();
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		const view = fileView(this.files, this.query);
		list.empty();
		for (const f of view.shown) {
			const label = list.createDiv().createEl("label");
			const box = label.createEl("input", { type: "checkbox" });
			box.checked = this.selection.has(f.path);
			box.disabled = this.busy;
			box.addEventListener("change", () => {
				this.selection = withPath(this.selection, f.path, box.checked);
				this.paintStatus();
			});
			label.appendText(` ${f.path} (${formatBytes(f.size)})`);
		}
		if (view.matching.length === 0) list.createEl("p", { text: "No files match the filter." });
		this.moreEl?.setText(view.moreText ?? "");
		this.paintStatus();
	}

	private paintStatus(): void {
		const n = selectedPaths(this.files, this.selection).length;
		this.statusEl?.setText(selectionText(n, this.files.length));
		this.restoreButton?.setDisabled(this.busy || n === 0);
	}

	private async restoreSelected(): Promise<void> {
		const paths = selectedPaths(this.files, this.selection);
		if (this.busy || paths.length === 0) return;
		if (!(await confirmAction(this.app, restoreSelectedCopy(this.row, paths.length)))) return;
		this.setBusy(true);
		const ok = await runRestore(this.host, this.row.id, paths);
		if (this.closed) return;
		this.setBusy(false);
		if (ok) {
			this.onRestored();
			this.close();
		}
	}

	private setBusy(on: boolean): void {
		this.busy = on;
		for (const b of this.buttons) b.setDisabled(on);
		this.renderList();
	}

	onClose(): void {
		this.closed = true;
		this.buttons = [];
		this.restoreButton = null;
		this.statusEl = this.listEl = this.moreEl = null;
		this.contentEl.empty();
	}
}
