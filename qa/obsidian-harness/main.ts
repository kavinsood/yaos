/**
 * YAOS QA Harness — Obsidian plugin entry point.
 *
 * This plugin:
 *   1. Registers window.__YAOS_QA__ with the full QaConsoleApi
 *   2. Mounts window.__YAOS_DEBUG__ by assembling a PluginHandle from the
 *      product plugin (yaos) + its TelemetryRuntimeHandle.  This is the
 *      single canonical mount point for the QA debug API — it is NOT mounted
 *      by the product plugin itself, which ships as a passive black box.
 *   3. Registers Obsidian commands for common QA operations
 *   4. Loads all known scenarios into the registry
 *
 * Install this plugin alongside YAOS in a QA vault with qaDebugMode enabled.
 * DO NOT use in production vaults.
 */

import { Plugin, Notice } from "obsidian";
import { buildQaConsoleApi } from "./api";
import type { QaScenario } from "./types";
import { buildQaDebugApi } from "../harness/qaDebugApi";
import { ScenarioStateController } from "../harness/scenarioStateController";

// Scenario imports
import { s00SmokeTraceExport } from "./scenarios/s00-smoke-trace-export";
import { s01SingleDeviceBasicEdit } from "./scenarios/s01-single-device-basic-edit";
import { s02OfflineHandoffCreate } from "./scenarios/s02-offline-handoff-create";
import { s03DeleteDoesNotResurrect } from "./scenarios/s03-delete-does-not-resurrect";
import { s04aBulkImportSmoke, s04bBulkImportStorm } from "./scenarios/s04-bulk-import-after-delete";
import { s05aFrontmatterClosedFile, s05bFrontmatterOpenEditor } from "./scenarios/s05-frontmatter-safety-loop";
import {
	s06aIssue25ForcedRecoveryCrdtOnly,
	s06aIssue25ForcedRecoveryLocalOnly,
} from "./scenarios/s06a-issue-25-forced-recovery";
import { s06bIssue25Natural } from "./scenarios/s06b-issue-25-natural";
import {
	s07gRenameAfterCreate,
	s07gRenameBeforeCrdtRegistration,
	s07gRenameToTombstonedPath,
	s07gRenameChain,
	s07gModifyThenRename,
	s07gModifyThenRenameChain,
} from "./scenarios/s07g-rename-after-create";
import {
	s09aRenameIntoExcluded,
	s09bRenameFromExcluded,
	s09cRenameToVacatedPath,
} from "./scenarios/s09-rename-boundary";
import {
	s07aCreateEmptyThenFill,
	s07bDelayedTemplateWrites,
	s07cOpenEditorTemplateMutation,
	s07eFrontmatterRace,
	s07fInvalidIntermediateValidFinal,
	s07hMultiFileBurst,
} from "./scenarios/s07-plugin-writes";
import {
	s07iFolderThenFile,
	s07jAttachmentRefBeforeBlob,
	s07kBlobArrivesAfterReference,
	s07hLargeBurst,
} from "./scenarios/s07-extra-scenarios";
import {
	s08aBulk500,
	s08bBulkUnicode,
	s08cBulkNested,
	s08dBulkMixed,
} from "./scenarios/s08-bulk-import";
import { s10aPassiveDeviceNoStaleEcho } from "./scenarios/s10a-passive-device-no-stale-echo";
import { s10bPassiveDeletionSoak } from "./scenarios/s10b-passive-deletion-soak";
import { s10cDisableReenablePreservesEdits } from "./scenarios/s10c-disable-reenable-preserves-edits";
import { s10dRecoveryAmplifierOrchestration } from "./scenarios/s10d-recovery-amplifier-orchestration";
import { s10gSuppressionDelayRace } from "./scenarios/s10g-suppression-delay-race";

const ALL_SCENARIOS: QaScenario[] = [
	s00SmokeTraceExport,
	s01SingleDeviceBasicEdit,
	s02OfflineHandoffCreate,
	s03DeleteDoesNotResurrect,
	s04aBulkImportSmoke,
	s04bBulkImportStorm,
	s05aFrontmatterClosedFile,
	s05bFrontmatterOpenEditor,
	s06aIssue25ForcedRecoveryCrdtOnly,
	s06aIssue25ForcedRecoveryLocalOnly,
	s06bIssue25Natural,
	// S07g: rename/move after create
	s07gRenameAfterCreate,
	s07gRenameBeforeCrdtRegistration,
	s07gRenameToTombstonedPath,
	s07gRenameChain,
	s07gModifyThenRename,
	s07gModifyThenRenameChain,
	// S07: plugin-generated writes (Templater class)
	s07aCreateEmptyThenFill,
	s07bDelayedTemplateWrites,
	s07cOpenEditorTemplateMutation,
	s07eFrontmatterRace,
	s07fInvalidIntermediateValidFinal,
	s07hMultiFileBurst,
	s07iFolderThenFile,
	s07jAttachmentRefBeforeBlob,
	s07kBlobArrivesAfterReference,
	s07hLargeBurst,
	// S08: bulk import stress family
	s08aBulk500,
	s08bBulkUnicode,
	s08cBulkNested,
	s08dBulkMixed,
	// S09: rename boundary (syncable ↔ excluded, vacated-path)
	s09aRenameIntoExcluded,
	s09bRenameFromExcluded,
	s09cRenameToVacatedPath,
	// S10: Issue #22 regression family
	s10aPassiveDeviceNoStaleEcho,
	s10bPassiveDeletionSoak,
	s10cDisableReenablePreservesEdits,
	s10dRecoveryAmplifierOrchestration,
	s10gSuppressionDelayRace,
];

export default class YaosQaHarnessPlugin extends Plugin {
	private scenarioRegistry = new Map<string, QaScenario>();
	private scenarioController = new ScenarioStateController();

	async onload(): Promise<void> {
		// Register all scenarios
		for (const scenario of ALL_SCENARIOS) {
			this.scenarioRegistry.set(scenario.id, scenario);
		}

		// Mount window.__YAOS_QA__ (harness console API)
		const api = buildQaConsoleApi(this.app, this.scenarioRegistry);
		(window as unknown as Record<string, unknown>).__YAOS_QA__ = api;

		// Mount window.__YAOS_DEBUG__ (product QA debug API).
		// The product plugin ships as a passive black box — it never mounts
		// __YAOS_DEBUG__ itself.  The harness is responsible for this mount
		// because it is the only in-repo Puppeteer consumer.
		this.mountYaosDebugApi();

		new Notice("YAOS QA Harness loaded. window.__YAOS_QA__ is available.", 5000);
		console.log(
			"[YAOS QA] Harness loaded. " +
			`${this.scenarioRegistry.size} scenarios registered. ` +
			"window.__YAOS_QA__ available. " +
			"Type YAOS_QA.help() in console.",
		);

		// Register command-palette commands
		this.addCommand({
			id: "qa-help",
			name: "Show QA harness help",
			callback: () => {
				(window as unknown as Record<string, unknown>).__YAOS_QA__ &&
					(api as { help: () => void }).help();
			},
		});

		this.addCommand({
			id: "qa-list-scenarios",
			name: "List QA scenarios",
			callback: () => {
				const ids = api.scenarios();
				new Notice(`QA scenarios (${ids.length}):\n${ids.join(", ")}`, 8000);
				console.log("[YAOS QA] Scenarios:", ids);
			},
		});

		this.addCommand({
			id: "qa-start-trace",
			name: "Start QA flight trace (qa-safe)",
			callback: async () => {
				await api.startTrace("qa-safe");
				new Notice("QA trace started (qa-safe).", 3000);
			},
		});

		this.addCommand({
			id: "qa-stop-trace",
			name: "Stop QA flight trace",
			callback: async () => {
				await api.stopTrace();
				new Notice("QA trace stopped.", 3000);
			},
		});

		this.addCommand({
			id: "qa-export-trace-safe",
			name: "Export QA flight trace (safe)",
			callback: async () => {
				try {
					const path = await api.exportTrace("safe");
					new Notice(`Trace exported: ${path.split("/").pop()}`, 6000);
				} catch (err) {
					new Notice(`Trace export failed: ${String(err)}`, 8000);
				}
			},
		});

		this.addCommand({
			id: "qa-vault-manifest",
			name: "Print vault manifest to console",
			callback: async () => {
				const m = await api.manifest();
				console.log("[YAOS QA] Vault manifest:", JSON.stringify(m, null, 2));
				new Notice(`Vault manifest: ${m.fileCount} files (see console).`, 5000);
			},
		});

		// Register per-scenario commands for quick manual runs
		for (const [id] of this.scenarioRegistry) {
			const scenarioId = id;
			this.addCommand({
				id: `qa-run-${scenarioId}`,
				name: `Run QA scenario: ${scenarioId}`,
				callback: async () => {
					new Notice(`Running scenario: ${scenarioId}…`, 3000);
					const result = await api.run(scenarioId);
					if (result.passed) {
						new Notice(`✓ PASS: ${scenarioId} (${result.durationMs}ms)`, 5000);
					} else {
						new Notice(
							`✗ FAIL: ${scenarioId}\n${result.errors.slice(0, 2).join("\n")}`,
							10000,
						);
					}
				},
			});
		}
	}

	onunload(): void {
		delete (window as unknown as Record<string, unknown>).__YAOS_QA__;
		delete (window as unknown as Record<string, unknown>).__YAOS_DEBUG__;
		console.log("[YAOS QA] Harness unloaded.");
	}

	/**
	 * Assembles a PluginHandle from the product plugin instance and its
	 * TelemetryRuntimeHandle, then calls buildQaDebugApi and mounts the
	 * result at window.__YAOS_DEBUG__.
	 *
	 * Guards (all must pass before mounting):
	 *   - product plugin "yaos" is loaded
	 *   - product.getEngineControlPort is present (confirms QA product build)
	 *   - product.lab (TelemetryRuntimeHandle) is present (confirms qaDebugMode)
	 *   - lab.getDeviceWitnessTracker accessor is present (confirms P4B build)
	 *
	 * If guards fail, a loud error is logged and no __YAOS_DEBUG__ is mounted.
	 * waitForQaReady() will never resolve, making the failure visible immediately
	 * rather than letting it surface as a mysterious mid-scenario crash.
	 *
	 * The product plugin ID is "yaos".  Enforce load order: "yaos" must appear
	 * before "yaos-qa-harness" in the vault's community-plugins.json.
	 *
	 * Private fields are accessed via `as any` — acceptable in a QA-only file.
	 */
	private mountYaosDebugApi(): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const product = (this.app.plugins as any).plugins?.["yaos"] as Record<string, unknown> | undefined;

		// Guard 1: product plugin must be loaded
		if (!product) {
			console.error(
				"[YAOS QA] FATAL: product plugin 'yaos' not found. " +
				"window.__YAOS_DEBUG__ will NOT be mounted. " +
				"Ensure 'yaos' appears before 'yaos-qa-harness' in community-plugins.json.",
			);
			new Notice("YAOS QA FATAL: product plugin not found — __YAOS_DEBUG__ unavailable. " +
				"Check plugin load order.", 15000);
			return;
		}

		// Guard 2: getEngineControlPort must exist (confirms QA product build, not prod main.js)
		if (typeof (product as any).getEngineControlPort !== "function") {
			console.error(
				"[YAOS QA] FATAL: product plugin is missing getEngineControlPort. " +
				"The vault is loading the production main.js instead of the QA product build. " +
				"Run: npm run build:qa-product, then re-run qa:prepare.",
			);
			new Notice("YAOS QA FATAL: wrong product build — getEngineControlPort missing. " +
				"Run npm run build:qa-product.", 15000);
			return;
		}

		// Guard 3: product.lab must exist (confirms qaDebugMode=true and telemetry loaded)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const lab = (product as any).lab as Record<string, unknown> | null | undefined;
		if (!lab) {
			console.error(
				"[YAOS QA] FATAL: product.lab (TelemetryRuntimeHandle) is null. " +
				"The product vault settings must have qaDebugMode: true. " +
				"Check qa/scripts/prepare-vault.ts — it must write qaDebugMode into the YAOS settings.",
			);
			new Notice("YAOS QA FATAL: product.lab missing — set qaDebugMode: true in YAOS settings.", 15000);
			return;
		}

		// Guard 4: new accessor must exist (confirms P4B telemetry build)
		if (typeof (lab as any).getDeviceWitnessTracker !== "function") {
			console.error(
				"[YAOS QA] FATAL: lab.getDeviceWitnessTracker is missing. " +
				"The telemetry.js bundle is stale — run: npm run build.",
			);
			new Notice("YAOS QA FATAL: stale telemetry.js — run npm run build.", 15000);
			return;
		}

		const scenarioController = this.scenarioController;

		const debugApi = buildQaDebugApi({
			app: this.app,
			getVaultSync: () => (product as any).vaultSync ?? null,
			getReconciliationController: () => (product as any).reconciliationController,
			getConnectionController: () => (product as any).connectionController ?? null,
			getFlightTraceController: () => (lab as any).getFlightTraceController?.() ?? null,
			getEditorBindings: () => (product as any).editorBindings ?? null,
			getDiagnosticsDir: () => undefined,
			sha256Hex: (text: string) => (product as any).sha256Hex(text) as Promise<string>,
			startQaFlightTrace: (mode?: string) =>
				((lab as any).startTelemetryTrace?.(mode ?? "qa-safe") ?? Promise.resolve()) as Promise<void>,
			stopQaFlightTrace: () =>
				((lab as any).stopTelemetryTrace?.() ?? Promise.resolve()) as Promise<void>,
			// exportFlightTrace must return the written file path or null.
			// buildQaDebugApi throws if path is null/falsy, so we call the
			// FlightTraceController directly to get the return value.
			exportFlightTrace: async (privacy: "safe" | "full") => {
				const ftc = (lab as any).getFlightTraceController?.() as
					import("../../src/telemetry/debug/flightTraceController").FlightTraceController | null;
				if (!ftc) return null;
				const diagService = (lab as any).diagnosticsService;
				const diagDir = await (diagService?.ensureDiagnosticsDir?.() as Promise<string> | undefined)
					?.catch(() => null) ?? null;
				if (!diagDir) return null;
				const result = await ftc.exportTrace({ requestedPrivacy: privacy, diagDir });
				return result.ok ? result.path : null;
			},
			runReconciliation: async () => {
				const rc = (product as any).reconciliationController;
				await rc?.runReconciliation("conservative");
			},
			// setQaNetworkHold("offline") holds the provider offline and blocks reconnects.
			// setQaNetworkHold("online") releases the hold and triggers reconnect.
			disconnectProvider: () =>
				void (product as any).connectionController?.setQaNetworkHold("offline"),
			connectProvider: () =>
				void (product as any).connectionController?.setQaNetworkHold("online"),
			getDeviceWitnessTracker: () =>
				(lab as any).getDeviceWitnessTracker?.() ?? null,
			getScenarioController: () => scenarioController,
			getQaTraceSecretHash: () =>
				((lab as any).getQaTraceSecretHash?.() ?? null) as string | null,
			getEngineControlPort: () => (product as any).getEngineControlPort(),
		});

		(window as unknown as Record<string, unknown>).__YAOS_DEBUG__ = debugApi;
		console.log("[YAOS QA] window.__YAOS_DEBUG__ mounted successfully.");
		new Notice("YAOS QA: window.__YAOS_DEBUG__ is available.", 4000);
	}
}
