/**
 * YAOS settings tab, declarative (Obsidian 1.13 getSettingDefinitions). Every persisted change goes
 * through host.updateData. Live rows (connection, engine status, held changes) repaint in place on
 * host.onChange, throttled; visibility/disabled predicates are re-evaluated with refreshDomState(),
 * so typing in a text field is never interrupted by a full re-render.
 * Ported in spirit from legacy-src/settings/settingsTab.ts.
 */

import {
	Notice, PluginSettingTab,
	type App, type Plugin, type Setting, type SettingDefinitionItem, type SettingDefinitionRender, type SettingGroupItem,
} from "obsidian";
import { MAX_KEEP_DAILY, pendingBrake, type YaosUiHost } from "./api";
import { brakeHeadline } from "./brake";
import { confirmAction } from "./confirmModal";
import { errorMessage } from "./format";
import { clearIdentity } from "./pairFlow";
import {
	applyControl, connectionRows, engineAcceptsCommands, engineRows, isControlKey, isPaused, MAX_ATTACHMENT_MB, readControl,
	TEXT_CONTROL_KEYS, TRASH_MODE_OPTIONS, validateControl,
	type ControlKey,
} from "./settingsModel";
import type { UserCommand } from "../../protocol/messages";

export interface SettingsTabActions {
	openPair(): void;
	openPairAnother(): void;
	openBrake(): void;
	exportDiagnostics(): void;
	/** Called after a change the status bar cares about (showStatusBar). */
	onDataChanged(): void;
}

const TEXT_DEBOUNCE_MS = 600;
const LIVE_MIN_INTERVAL_MS = 250;

function linesFragment(lines: readonly string[]): DocumentFragment {
	const frag = document.createDocumentFragment();
	lines.forEach((line, i) => {
		if (i > 0) frag.appendChild(document.createElement("br"));
		frag.appendChild(document.createTextNode(line));
	});
	return frag;
}

export class YaosSettingTab extends PluginSettingTab {
	private readonly pendingText = new Map<ControlKey, string>();
	private textTimer: number | null = null;
	private readonly live = new Set<() => void>();
	private liveTimer: number | null = null;
	private lastLiveAt = 0;
	private lastStructure = "";
	private unsubscribe: (() => void) | null;

	constructor(app: App, plugin: Plugin, private readonly host: YaosUiHost, private readonly actions: SettingsTabActions) {
		super(app, plugin);
		this.icon = "refresh-cw";
		this.unsubscribe = host.onChange(() => this.scheduleLive());
	}

	// -------------------------------------------------------------------------
	// Definitions
	// -------------------------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		const paired = (): boolean => this.host.data().identity !== null;
		const commandsOff = (): boolean => !engineAcceptsCommands(this.host.runState());

		const connectionItems: SettingGroupItem[] = [
			this.liveRow("Status", () => connectionRows(null)[0]?.value ?? "", { visible: () => !paired() }),
			...(["Server", "Vault ID", "Device name", "Device token"] as const).map((name) =>
				this.liveRow(name, () => connectionRows(this.host.data().identity).find((r) => r.name === name)?.value ?? "", { visible: paired }),
			),
			{
				name: "Pair this device",
				desc: "Join this device to a vault with a server URL and a one-time pairing code.",
				action: () => this.actions.openPair(),
			},
			{
				name: "Pair another device",
				desc: "Create a one-time code and setup link for your other device.",
				visible: paired,
				action: () => this.actions.openPairAnother(),
			},
			{
				name: "Unpair this device",
				desc: "Stop syncing and forget this device's credentials. Notes on disk are kept.",
				visible: paired,
				action: () => { void this.unpair(); },
			},
		];

		const statusItems: SettingGroupItem[] = [
			this.liveRow("Sync engine", () => linesFragment(
				engineRows(this.host.runState(), this.host.status(), Date.now()).map((r) => (r.name === "Engine" ? r.value : `${r.name}: ${r.value}`)),
			)),
			{
				name: "Held changes",
				visible: () => pendingBrake(this.host) !== null,
				render: (setting: Setting) => {
					setting.setName("Held changes");
					setting.addButton((b) => b.setButtonText("Review").setCta().onClick(() => this.actions.openBrake()));
					const paint = (): void => {
						const brake = pendingBrake(this.host);
						setting.setDesc(brake ? brakeHeadline(brake) : "");
					};
					paint();
					this.live.add(paint);
					return () => { this.live.delete(paint); };
				},
			},
		];

		const deviceItems: SettingGroupItem[] = [
			{
				name: "Device label",
				desc: "Used in conflict copy names on this device, e.g. \"note (conflict Laptop 2026-10-05 1200).md\".",
				control: {
					type: "text",
					key: "deviceLabel",
					placeholder: "My laptop",
					validate: (v: string) => validateControl("deviceLabel", v) ?? undefined,
				},
			},
		];

		const syncItems: SettingGroupItem[] = [
			{
				name: "Excluded paths",
				desc: "One path prefix per line, for example templates/ or private/. Files whose path starts with a listed prefix are not synced. The config folder and .trash are always excluded.",
				control: {
					type: "textarea",
					key: "excludePatterns",
					placeholder: "templates/\nprivate/",
					rows: 5,
					validate: (v: string) => validateControl("excludePatterns", v) ?? undefined,
				},
			},
			{
				name: "Sync attachments",
				desc: "Sync images, PDFs and other non-note files.",
				control: { type: "toggle", key: "syncAttachments" },
			},
			{
				name: "Maximum attachment size (MB)",
				desc: "Larger attachments stay on this device.",
				visible: () => this.host.data().engine.syncAttachments,
				control: {
					type: "number",
					key: "maxAttachmentMb",
					min: 1,
					max: MAX_ATTACHMENT_MB,
					step: 1,
					validate: (v: number) => validateControl("maxAttachmentMb", v) ?? undefined,
				},
			},
			{
				name: "Sync Obsidian settings",
				desc: "Sync app options, appearance, hotkeys, core plugin options (graph, bookmarks, daily notes, templates, saved workspaces), core and community plugin lists, plugin settings, snippets and themes. Plugin code and the open-pane layout are never synced.",
				control: { type: "toggle", key: "syncSettings" },
			},
			{
				name: "Deleted files go to",
				desc: "Where files deleted by sync are moved. YAOS never deletes a file permanently.",
				control: { type: "dropdown", key: "trashMode", options: { ...TRASH_MODE_OPTIONS } },
			},
			{
				name: "Live edits from other devices",
				desc: "Show other devices' typing in open notes right away, before the server confirms it.",
				control: { type: "toggle", key: "provisionalBroadcast" },
			},
			{
				name: "Daily recovery snapshots",
				desc: "Keep a daily zip of your notes in the plugin folder. A snapshot is also taken before held changes are approved.",
				control: { type: "toggle", key: "snapshotsEnabled" },
			},
			{
				name: "Daily snapshots to keep",
				visible: () => this.host.data().engine.snapshots.enabled,
				control: {
					type: "number",
					key: "snapshotsKeepDaily",
					min: 1,
					max: MAX_KEEP_DAILY,
					step: 1,
					validate: (v: number) => validateControl("snapshotsKeepDaily", v) ?? undefined,
				},
			},
		];

		const actionItems: SettingGroupItem[] = [
			{
				name: "Pause sync",
				desc: "Stop sending and receiving changes. Local edits are kept.",
				visible: () => !isPaused(this.host.status()),
				disabled: commandsOff,
				action: () => { void this.send({ t: "pause" }, "Sync paused."); },
			},
			{
				name: "Resume sync",
				visible: () => isPaused(this.host.status()),
				disabled: commandsOff,
				action: () => { void this.send({ t: "resume" }, "Sync resumed."); },
			},
			{
				name: "Sync now",
				desc: "Rescan this vault and fetch from the server now.",
				disabled: commandsOff,
				action: () => { void this.send({ t: "reconcileNow" }, "Full sync started."); },
			},
			{
				name: "Create snapshot",
				desc: "Save a recovery snapshot of your notes now.",
				disabled: commandsOff,
				action: () => { void this.send({ t: "createSnapshot" }, "Snapshot created."); },
			},
			{
				name: "Export diagnostics",
				desc: "Save a diagnostics file (no note contents or credentials) and copy it to the clipboard.",
				disabled: commandsOff,
				action: () => this.actions.exportDiagnostics(),
			},
			{
				name: "Rebuild local cache",
				desc: "Discard this device's sync database and rebuild it from your files and the server. Use it if sync seems stuck.",
				disabled: commandsOff,
				action: () => { void this.rebuildCache(); },
			},
			{
				name: "Restart sync engine",
				visible: paired,
				action: () => { void this.restartEngine(); },
			},
		];

		const interfaceItems: SettingGroupItem[] = [
			{
				name: "Show status in the status bar",
				control: { type: "toggle", key: "showStatusBar" },
			},
		];

		return [
			{ type: "group", heading: "Connection", items: connectionItems },
			{ type: "group", heading: "Status", items: statusItems },
			{ type: "group", heading: "This device", items: deviceItems },
			{ type: "group", heading: "Sync", items: syncItems },
			{ type: "group", heading: "Actions", items: actionItems },
			{ type: "group", heading: "Interface", items: interfaceItems },
		];
	}

	private liveRow(
		name: string,
		compute: () => string | DocumentFragment,
		extra: { visible?: () => boolean } = {},
	): SettingDefinitionRender {
		return {
			name,
			...extra,
			render: (setting: Setting) => {
				setting.setName(name);
				let last: string | null = null;
				const paint = (): void => {
					const value = compute();
					const key = typeof value === "string" ? value : value.textContent ?? "";
					if (key === last) return;
					last = key;
					setting.setDesc(value);
				};
				paint();
				this.live.add(paint);
				return () => { this.live.delete(paint); };
			},
		};
	}

	// -------------------------------------------------------------------------
	// Controls
	// -------------------------------------------------------------------------

	getControlValue(key: string): unknown {
		if (!isControlKey(key)) return undefined;
		const pending = this.pendingText.get(key);
		if (pending !== undefined) return pending;
		return readControl(this.host.data(), key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isControlKey(key)) return;
		if (TEXT_CONTROL_KEYS.has(key)) {
			if (typeof value !== "string") return;
			this.pendingText.set(key, value);
			if (this.textTimer !== null) window.clearTimeout(this.textTimer);
			this.textTimer = window.setTimeout(() => { void this.flushText(); }, TEXT_DEBOUNCE_MS);
			return;
		}
		await this.persist(key, value);
	}

	private async flushText(): Promise<void> {
		if (this.textTimer !== null) window.clearTimeout(this.textTimer);
		this.textTimer = null;
		const entries = [...this.pendingText.entries()];
		this.pendingText.clear();
		for (const [key, value] of entries) {
			// Invalid drafts (e.g. an empty label mid-edit) are simply not saved.
			if (validateControl(key, value) !== null) continue;
			await this.persist(key, value);
		}
	}

	private async persist(key: ControlKey, value: unknown): Promise<void> {
		const problem = validateControl(key, value);
		if (problem) {
			new Notice(`YAOS: ${problem}`);
			return;
		}
		try {
			await this.host.updateData((d) => applyControl(d, key, value));
		} catch (err) {
			new Notice(`YAOS: could not save the setting: ${errorMessage(err)}`, 8000);
		}
		if (key === "syncAttachments" || key === "snapshotsEnabled") this.refreshDomState();
		if (key === "showStatusBar") this.actions.onDataChanged();
	}

	// -------------------------------------------------------------------------
	// Actions
	// -------------------------------------------------------------------------

	private async send(command: UserCommand, done: string): Promise<void> {
		try {
			await this.host.command(command);
			new Notice(`YAOS: ${done}`);
		} catch (err) {
			new Notice(`YAOS: ${errorMessage(err)}`, 8000);
		}
		this.refreshLiveNow();
	}

	private async unpair(): Promise<void> {
		const identity = this.host.data().identity;
		if (!identity) return;
		const ok = await confirmAction(this.app, {
			title: "Unpair this device?",
			message: `This device stops syncing with ${identity.host} and forgets its credentials. Notes on disk stay where they are.\n\nThe server still lists this device; remove it in your server console if you will not use it again. To sync again you need a new pairing code.`,
			confirmText: "Unpair",
		});
		if (!ok) return;
		try {
			await this.host.updateData(clearIdentity);
			new Notice("YAOS: this device is unpaired.");
		} catch (err) {
			new Notice(`YAOS: could not unpair: ${errorMessage(err)}`, 8000);
		}
		this.refreshLiveNow();
	}

	private async rebuildCache(): Promise<void> {
		const ok = await confirmAction(this.app, {
			title: "Rebuild local cache?",
			message: "YAOS discards this device's sync database and rebuilds it from the files in this vault and the server. Unsent edits are kept. Files that differ from the server get conflict copies; nothing is deleted.\n\nThis can take a while on large vaults.",
			confirmText: "Rebuild",
		});
		if (!ok) return;
		await this.send({ t: "rebuildLocalCache" }, "rebuilding the local cache.");
	}

	private async restartEngine(): Promise<void> {
		try {
			await this.host.restartEngine();
			new Notice("YAOS: sync engine restarted.");
		} catch (err) {
			new Notice(`YAOS: could not restart the sync engine: ${errorMessage(err)}`, 8000);
		}
		this.refreshLiveNow();
	}

	// -------------------------------------------------------------------------
	// Live updates
	// -------------------------------------------------------------------------

	private structureKey(): string {
		const run = this.host.runState();
		return [
			this.host.data().identity !== null,
			isPaused(this.host.status()),
			pendingBrake(this.host)?.id ?? "",
			engineAcceptsCommands(run),
			this.host.data().engine.syncAttachments,
			this.host.data().engine.snapshots.enabled,
		].join("|");
	}

	private scheduleLive(): void {
		if (this.live.size === 0 || this.liveTimer !== null) return;
		const wait = Math.max(0, this.lastLiveAt + LIVE_MIN_INTERVAL_MS - Date.now());
		this.liveTimer = window.setTimeout(() => {
			this.liveTimer = null;
			this.refreshLiveNow();
		}, wait);
	}

	/** Repaint live rows and re-apply visibility predicates when they may have changed. */
	refreshLiveNow(): void {
		this.lastLiveAt = Date.now();
		if (this.live.size === 0) return;
		for (const paint of [...this.live]) {
			try {
				paint();
			} catch {
				// A row torn down mid-tick; ignore.
			}
		}
		const structure = this.structureKey();
		if (structure !== this.lastStructure) {
			this.lastStructure = structure;
			this.refreshDomState();
		}
	}

	hide(): void {
		void this.flushText();
		super.hide();
		// Rows normally unregister through their render cleanup; this covers hosts that skip it.
		this.live.clear();
		this.lastStructure = "";
	}

	dispose(): void {
		void this.flushText();
		if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
		this.liveTimer = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.live.clear();
	}
}
