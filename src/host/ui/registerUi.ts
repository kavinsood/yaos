/**
 * Wires the host UI into the plugin: settings tab, status bar, commands, the obsidian://yaos setup
 * link handler and the safety brake prompt. Returns a disposer; the plugin also cleans up the
 * commands, tab, status bar item and protocol handler itself on unload.
 *
 * Usage in plugin.ts (onload): `this.register(registerUi(this, host));`
 */

import { Notice, type Modal, type Plugin } from "obsidian";
import type { BrakeReport } from "../../core/types";
import type { UserCommand } from "../../protocol/messages";
import { pendingBrake, type YaosUiHost } from "./api";
import { BrakeTracker } from "./brake";
import { BrakeModal } from "./brakeModal";
import { UI_COMMANDS, type UiCommandId } from "./commands";
import { exportDiagnostics } from "./diagnostics";
import { confirmAndRebuildCache, restartSyncEngine } from "./engineActions";
import { errorMessage } from "./format";
import { copyText, obsidianRequest, openPluginSettings } from "./obsidianEnv";
import { PairingCodeModal, PairModal, type PairPrefill } from "./pairModal";
import { parseSetupLink, type RequestFn } from "./pairing";
import { SnapshotsModal } from "./snapshotsModal";
import { YaosSettingTab } from "./settingsTab";
import { StatusBarController } from "./statusBar";

export interface RegisterUiOptions {
	/** HTTP for pairing calls (default: Obsidian requestUrl). */
	readonly request?: RequestFn;
}

export function registerUi(plugin: Plugin, host: YaosUiHost, options: RegisterUiOptions = {}): () => void {
	const app = plugin.app;
	const request = options.request ?? obsidianRequest;
	const modals = new Set<Modal>();
	const tracker = new BrakeTracker();
	let brakeModal: BrakeModal | null = null;
	let disposed = false;

	/** Opens `modal` and remembers it until it closes, so the disposer can close it. */
	const track = <M extends Modal>(modal: M): M => {
		const onClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			modals.delete(modal);
			onClose();
		};
		modals.add(modal);
		modal.open();
		return modal;
	};

	const openSettings = (): void => {
		if (!openPluginSettings(app, plugin.manifest.id)) new Notice("Open Settings, then YAOS.");
	};

	const openBrakeFor = (report: BrakeReport): void => {
		if (disposed) return;
		if (brakeModal) {
			if (brakeModal.report.id === report.id) return;
			brakeModal.close();
		}
		const modal: BrakeModal = new BrakeModal(app, host, report, () => {
			if (brakeModal === modal) brakeModal = null;
		});
		brakeModal = modal;
		track(modal);
	};

	const openBrake = (): void => {
		const report = pendingBrake(host);
		if (report) openBrakeFor(report);
		else new Notice("YAOS: no changes are waiting for approval.");
	};

	const openPair = (prefill: PairPrefill = {}): void => {
		if (disposed) return;
		track(new PairModal(app, host, prefill, request));
	};

	const openPairAnother = (): void => {
		if (disposed) return;
		if (!host.data().identity) {
			new Notice("YAOS: pair this device first.");
			return;
		}
		track(new PairingCodeModal(app, host, request));
	};

	const openSnapshots = (): void => {
		if (disposed) return;
		track(new SnapshotsModal(app, host, (child) => { if (!disposed) track(child); }));
	};

	const runExport = (): void => {
		void exportDiagnostics(host, {
			notify: (message, level) => { new Notice(`YAOS: ${message}`, level === "error" ? 8000 : 6000); },
			copyText,
		});
	};

	const send = (command: UserCommand, done: string): void => {
		host.command(command).then(
			() => { new Notice(`YAOS: ${done}`); },
			(err: unknown) => { new Notice(`YAOS: ${errorMessage(err)}`, 8000); },
		);
	};

	// Status bar.
	const statusBar = new StatusBarController(plugin.addStatusBarItem(), host, { openBrake, openSettings });

	// Settings tab.
	const tab = new YaosSettingTab(app, plugin, host, {
		openPair: () => openPair(),
		openPairAnother,
		openBrake,
		openSnapshots,
		exportDiagnostics: runExport,
		onDataChanged: () => statusBar.renderNow(),
	});
	plugin.addSettingTab(tab);

	// Commands.
	const actions: Record<UiCommandId, () => void> = {
		"yaos-pause": () => send({ t: "pause" }, "sync paused."),
		"yaos-resume": () => send({ t: "resume" }, "sync resumed."),
		"yaos-reconcile-now": () => send({ t: "reconcileNow" }, "full sync started."),
		"yaos-export-diagnostics": runExport,
		"yaos-show-brake": openBrake,
		"yaos-pair-device": () => openPair(),
		"yaos-pair-another-device": openPairAnother,
		"yaos-create-snapshot": () => send({ t: "createSnapshot" }, "snapshot created."),
		"yaos-browse-snapshots": openSnapshots,
		"yaos-rebuild-local-cache": () => { void confirmAndRebuildCache(app, host); },
		"yaos-restart-engine": () => { void restartSyncEngine(host); },
	};
	for (const spec of UI_COMMANDS) {
		plugin.addCommand({
			id: spec.id,
			name: spec.name,
			checkCallback: (checking: boolean) => {
				if (!spec.available(host)) return false;
				if (!checking) actions[spec.id]();
				return true;
			},
		});
	}

	// obsidian://yaos?action=setup&host=...&pairingCode=... opens the pair modal prefilled.
	plugin.registerObsidianProtocolHandler("yaos", (params) => {
		const parsed = parseSetupLink(params);
		if (!parsed.ok) {
			new Notice(`YAOS: ${parsed.reason}`, 8000);
			return;
		}
		openPair({ host: parsed.host, pairingCode: parsed.pairingCode });
	});

	// Safety brake: prompt once per new brake id, including one already pending at startup.
	const checkBrake = (): void => {
		if (disposed) return;
		const report = pendingBrake(host);
		if (tracker.shouldOpen(report)) openBrakeFor(report);
	};
	const unsubscribeBrake = host.onChange(checkBrake);
	app.workspace.onLayoutReady(checkBrake);

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribeBrake();
		statusBar.dispose();
		tab.dispose();
		for (const modal of [...modals]) modal.close();
		modals.clear();
		brakeModal = null;
	};
}
