/**
 * Wires the host UI into the plugin: settings tab, status bar, commands, the obsidian://yaos setup
 * and re-key link handler, the encryption modals and the safety brake prompt. Returns a disposer; the plugin also cleans up the
 * commands, tab, status bar item and protocol handler itself on unload.
 *
 * Usage in plugin.ts (onload): `this.register(registerUi(this, host));`
 */

import { Notice, type Modal, type Plugin } from "obsidian";
import type { BrakeReport } from "../../core/types";
import type { UserCommand } from "../../protocol/messages";
import type { DeviceCheckMode } from "../../protocol/status";
import { pendingBrake, type YaosUiHost } from "./api";
import { cleanUpAttachments } from "./attachmentsCleanup";
import { BrakeTracker } from "./brake";
import { BrakeModal } from "./brakeModal";
import { UI_COMMANDS, type UiCommandId } from "./commands";
import { confirmAction } from "./confirmModal";
import { largeCheckConfirm, runDeviceCheck } from "./deviceCheck";
import { DeviceCheckModal } from "./deviceCheckModal";
import { DIAGNOSTICS_WITH_PATHS_CONFIRM, exportDiagnostics } from "./diagnostics";
import { confirmAndRebuildCache, restartSyncEngine } from "./engineActions";
import { errorMessage } from "./format";
import { copyText, obsidianRequest, openPluginSettings } from "./obsidianEnv";
import { CreateVaultModal } from "./createVaultModal";
import { applyLinkE2ee, PendingQrKeys, routeSetupLink } from "./keyActions";
import { EnterRecoveryKeyModal, KeyMissingModal, RekeyAfterRevokeModal, RekeyQrModal } from "./keyModals";
import { PairingCodeModal, PairModal, type PairPrefill } from "./pairModal";
import { parseSetupLink, type LinkE2ee, type RequestFn } from "./pairing";
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

	// Keys from a QR or link waiting for a matching key record (§12.4 (i)); memory only.
	const pendingKeys = new PendingQrKeys();

	const openKeyMissing = (): void => {
		if (disposed) return;
		track(new KeyMissingModal(app, host, pendingKeys, () => { if (!disposed) track(new EnterRecoveryKeyModal(app, host)); }));
	};

	/** A link's key or `suite=0`, for the vault this device is enrolled in (§12.4: never a re-enroll). Owns the key. */
	const applyLink = (vaultId: string, e2ee: LinkE2ee): void => {
		const working = new Notice(e2ee.suite === 1 ? "YAOS: checking the vault key from the link…" : "YAOS: applying the link's encryption setting…", 0);
		applyLinkE2ee(host, vaultId, e2ee).then(
			(outcome) => {
				working.hide();
				if (outcome === "verified") {
					pendingKeys.clear(vaultId);
					new Notice("YAOS: the vault key matches. This device syncs the vault.", 8000);
				} else if (outcome === "suite0") {
					new Notice("YAOS: this device syncs the vault without end-to-end encryption, as the link says.", 8000);
				} else {
					pendingKeys.mark(vaultId);
					openKeyMissing();
				}
			},
			(err: unknown) => {
				working.hide();
				new Notice(`YAOS: ${errorMessage(err)}`, 10000);
			},
		);
	};

	const openPair = (prefill: PairPrefill = {}): void => {
		if (disposed) {
			if (prefill.e2ee?.suite === 1) prefill.e2ee.key.k.fill(0);
			return;
		}
		track(new PairModal(app, host, prefill, applyLink, request));
	};

	const openCreateVault = (resume: boolean): void => {
		if (disposed) return;
		track(new CreateVaultModal(app, host, { resume, request }));
	};

	const openRekeyQr = (afterRevoke: boolean): void => {
		if (disposed) return;
		track(new RekeyQrModal(app, host, afterRevoke));
	};

	const openRevokeRekey = (): void => {
		if (disposed) return;
		track(new RekeyAfterRevokeModal(app, host, () => openRekeyQr(true)));
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

	const runExport = (includePaths: boolean): void => {
		void exportDiagnostics(host, {
			notify: (message, level) => { new Notice(`YAOS: ${message}`, level === "error" ? 8000 : 6000); },
			copyText,
		}, { includePaths });
	};

	// The device check runs in the engine; main shows a notice while it runs, then the results. One at a time.
	let deviceChecking = false;
	const runCheck = (mode: DeviceCheckMode): void => {
		if (deviceChecking) {
			new Notice("YAOS: a device check is already running.");
			return;
		}
		deviceChecking = true;
		const working = new Notice(mode === "quick" ? "YAOS: running the device check (about 10–30 s)…" : "YAOS: running the large attachment check. This can take a few minutes…", 0);
		runDeviceCheck(host, mode).then(
			(run) => {
				working.hide();
				if (!disposed) track(new DeviceCheckModal(app, run, { copy: copyText, save: (name, text) => host.writeDiagnosticsFile(name, text) }));
			},
			(err: unknown) => {
				working.hide();
				new Notice(`YAOS: the device check did not finish: ${errorMessage(err)}`, 10000);
			},
		).finally(() => { deviceChecking = false; });
	};

	const send = (command: UserCommand, done: string): void => {
		host.command(command).then(
			() => { new Notice(`YAOS: ${done}`); },
			(err: unknown) => { new Notice(`YAOS: ${errorMessage(err)}`, 8000); },
		);
	};

	// Status bar.
	const statusBar = new StatusBarController(plugin.addStatusBarItem(), host, { openBrake, openSettings, openKeyMissing });

	// Settings tab.
	const tab = new YaosSettingTab(app, plugin, host, {
		openPair: () => openPair(),
		openPairAnother,
		openCreateVault: () => openCreateVault(false),
		openResumeCreation: () => openCreateVault(true),
		openKeyMissing,
		openRekeyQr: () => openRekeyQr(false),
		openRevokeRekey,
		openBrake,
		openSnapshots,
		exportDiagnostics: () => runExport(false),
		onDataChanged: () => statusBar.renderNow(),
	});
	plugin.addSettingTab(tab);

	// Commands.
	const actions: Record<UiCommandId, () => void> = {
		"yaos-pause": () => send({ t: "pause" }, "sync paused."),
		"yaos-resume": () => send({ t: "resume" }, "sync resumed."),
		"yaos-reconcile-now": () => send({ t: "reconcileNow" }, "full sync started."),
		"yaos-export-diagnostics": () => runExport(false),
		"yaos-export-diagnostics-with-paths": () => {
			void confirmAction(app, DIAGNOSTICS_WITH_PATHS_CONFIRM).then((ok) => { if (ok && !disposed) runExport(true); });
		},
		"yaos-show-brake": openBrake,
		"yaos-pair-device": () => openPair(),
		"yaos-pair-another-device": openPairAnother,
		"yaos-create-snapshot": () => send({ t: "createSnapshot" }, "snapshot created."),
		"yaos-browse-snapshots": openSnapshots,
		"yaos-rebuild-local-cache": () => { void confirmAndRebuildCache(app, host); },
		"yaos-clean-up-attachments": () => {
			void cleanUpAttachments(host, (message, level) => { new Notice(`YAOS: ${message}`, level === "error" ? 10000 : 6000); });
		},
		"yaos-restart-engine": () => { void restartSyncEngine(host); },
		"yaos-create-vault": () => openCreateVault(false),
		"yaos-finish-creating-vault": () => openCreateVault(true),
		"yaos-unlock": openKeyMissing,
		"yaos-show-rekey-qr": () => openRekeyQr(false),
		"yaos-rekey-after-revoke": openRevokeRekey,
		"yaos-device-check": () => runCheck("quick"),
		"yaos-device-check-large": () => {
			void confirmAction(app, largeCheckConfirm(host.status()?.maxBlobBytes ?? null)).then((ok) => { if (ok && !disposed) runCheck("large"); });
		},
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

	// obsidian://yaos?action=setup&host=...&pairingCode=...[&key=...|&suite=0] opens the pair modal prefilled, or, for
	// the vault this device is already in (and for action=rekey), takes only the key or suite=0 (§12.4). A link never
	// leads anywhere else. The link itself is never logged or shown.
	plugin.registerObsidianProtocolHandler("yaos", (params) => {
		const route = routeSetupLink(parseSetupLink(params), host.data(), host.status());
		if (route.kind === "ignore") new Notice(`YAOS: ${route.message}`, 9000);
		else if (route.kind === "pair") openPair({ host: route.host, pairingCode: route.pairingCode, e2ee: route.e2ee, fromLink: true });
		else applyLink(host.data().identity?.vaultId ?? "", route.e2ee);
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
