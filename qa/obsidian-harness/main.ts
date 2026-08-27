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
import { getPluginRegistry, type ObsidianPluginInstance } from "../harness/ports/obsidianInternalsPort";
import type { TelemetryRuntimeHandle } from "../../src/telemetry/installTelemetryRuntime";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { ConnectionController } from "../../src/runtime/connectionController";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { EngineControlPort } from "../../src/runtime/engineControlPort";

/**
 * The private surface of the product plugin that this harness reaches for.
 *
 * None of it is exported API: these are instance fields and prototype methods
 * read out of Obsidian's plugin registry. Declaring the shape in one place
 * means the reads below are typed, and a member that changes type in the
 * product is a compile error under tsconfig.qa.json rather than an `undefined`
 * surfacing mid-scenario.
 *
 * It does NOT make a *rename* a compile error — the assertion that produces
 * this type is unchecked by construction. Guard 2 in mountYaosDebugApi() probes
 * every member at startup for exactly that reason. Keep the two in step.
 *
 * getEngineControlPort and setQaNetworkHold exist only in the QA product build
 * (`__YAOS_QA_HARNESS_ENABLED__`); src/main.ts attaches them as instance
 * properties so their names never reach the production bundle.
 */
interface ProductInternals {
	readonly vaultSync: VaultSync | null;
	readonly reconciliationController: ReconciliationController | undefined;
	readonly connectionController: ConnectionController | null;
	readonly editorBindings: EditorBindingManager | null;
	readonly lab: TelemetryRuntimeHandle | null | undefined;
	sha256Hex(text: string): Promise<string>;
	getEngineControlPort(): EngineControlPort;
	setQaNetworkHold(mode: "offline" | "online"): void;
}

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
import { s06cClosedOnlyOpenBoundDeferral } from "./scenarios/s06c-closed-only-open-bound-deferral";
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
	s07hLargeBurst,
} from "./scenarios/s07-plugin-writes";
import {
	s07iFolderThenFile,
	s07jAttachmentRefBeforeBlob,
	s07kBlobArrivesAfterReference,
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
	s06cClosedOnlyOpenBoundDeferral,
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

	async onload(): Promise<void> {
		// Register all scenarios
		for (const scenario of ALL_SCENARIOS) {
			this.scenarioRegistry.set(scenario.id, scenario);
		}

		// Mount window.__YAOS_QA__ (harness console API)
		const api = buildQaConsoleApi(this.app, this.scenarioRegistry);
		window.__YAOS_QA__ = api;

		// Mount window.__YAOS_DEBUG__ (product QA debug API).
		// The product plugin ships as a passive black box — it never mounts
		// __YAOS_DEBUG__ itself. The harness owns this mount for the raw CDP
		// automation controllers.
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
				if (window.__YAOS_QA__) api.help();
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
		delete window.__YAOS_QA__;
		delete window.__YAOS_DEBUG__;
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
	 *
	 * If guards fail, a loud error is logged and no __YAOS_DEBUG__ is mounted.
	 * waitForQaReady() will never resolve, making the failure visible immediately
	 * rather than letting it surface as a mysterious mid-scenario crash.
	 *
	 * The product plugin ID is "yaos".  Enforce load order: "yaos" must appear
	 * before "yaos-qa-harness" in the vault's community-plugins.json.
	 *
	 * The product's private surface is read through a single declared shape,
	 * ProductInternals, rather than scattered casts — see the note on that type.
	 */
	private mountYaosDebugApi(): void {
		// Obsidian's plugin registry is a private API absent from obsidian.d.ts.
		// getPluginRegistry() declares and checks that surface once (see
		// qa/harness/ports/obsidianInternalsPort.ts); every consumer below
		// re-guards what it touches.
		const registry = getPluginRegistry(this.app);
		const productRecord = registry?.plugins["yaos"];

		// Guard 1: product plugin must be loaded
		if (!productRecord) {
			console.error(
				"[YAOS QA] FATAL: product plugin 'yaos' not found. " +
				"window.__YAOS_DEBUG__ will NOT be mounted. " +
				"Ensure 'yaos' appears before 'yaos-qa-harness' in community-plugins.json.",
			);
			new Notice("YAOS QA FATAL: product plugin not found — __YAOS_DEBUG__ unavailable. " +
				"Check plugin load order.", 15000);
			return;
		}

		// Guard 2: every product member this harness reaches for must exist.
		//
		// The cast that produces ProductInternals is unchecked, so a renamed field
		// is invisible to both compilers and surfaces as `undefined` in the middle
		// of a scenario — usually while debugging something else. Probing the
		// whole set up front turns that into one loud failure before any
		// scenario runs. Keep this table in step with the accessors passed to
		// buildQaDebugApi below.
		//
		// `method` members live on the prototype; `field` members are declared
		// with a `= null` initialiser so the property exists from construction
		// even before the subsystem is built. `reconciliationController` is
		// deliberately absent — it uses definite assignment (`!`) and so has no
		// property until the product assigns it, which makes it indistinguishable
		// here from a rename. It is probed at its accessor instead.
		const probes: ReadonlyArray<readonly [string, "method" | "field", string]> = [
			["getEngineControlPort", "method", "The vault is loading the production main.js instead of the QA product build. Run: npm run build:qa-product, then re-run qa:prepare."],
			["setQaNetworkHold", "method", "Same cause as getEngineControlPort — this is the other QA-only accessor attached under __YAOS_QA_HARNESS_ENABLED__."],
			["sha256Hex", "method", "Renamed or removed from the product plugin class."],
			["vaultSync", "field", "Renamed or removed from the product plugin class."],
			["connectionController", "field", "Renamed or removed from the product plugin class."],
			["editorBindings", "field", "Renamed or removed from the product plugin class."],
		];
		const missing = probes.filter(([name, kind]) =>
			kind === "method"
				? typeof productRecord[name] !== "function"
				: !(name in productRecord),
		);
		if (missing.length > 0) {
			for (const [name, kind, hint] of missing) {
				console.error(`[YAOS QA] FATAL: product plugin is missing ${kind} '${name}'. ${hint}`);
			}
			new Notice(
				`YAOS QA FATAL: product is missing ${missing.length} member(s) the harness needs — ` +
				`${missing.map(([n]) => n).join(", ")}. See the developer console.`,
				15000,
			);
			return;
		}

		// The private surface of the product plugin that this harness reaches
		// for. These members are not exported API — they are instance fields and
		// prototype methods read through the plugin registry, which types them
		// as `unknown` — so this shape is asserted, not inferred. Guard 2 above
		// proves every one of them exists before we get here, and the accessors
		// below are the only readers.
		const product: ProductInternals = productRecord as ObsidianPluginInstance & ProductInternals;

		// Guard 3: product.lab must exist (confirms qaDebugMode=true and the
		// debug runtime installed). Typed as the real handle so a member that
		// disappears from the product is a compile error here, not a silent
		// undefined at scenario runtime.
		const lab = product.lab;
		if (!lab) {
			console.error(
				"[YAOS QA] FATAL: product.lab (TelemetryRuntimeHandle) is null. " +
				"The product vault settings must have qaDebugMode: true. " +
				"Check qa/scripts/prepare-vault.ts — it must write qaDebugMode into the YAOS settings.",
			);
			new Notice("YAOS QA FATAL: product.lab missing — set qaDebugMode: true in YAOS settings.", 15000);
			return;
		}

		const debugApi = buildQaDebugApi({
			app: this.app,
			getVaultSync: () => product.vaultSync ?? null,
			// Declared with definite assignment (`!`) on the product, so unlike its
			// siblings it has no property at all until the product assigns it —
			// which is why Guard 2 cannot probe it. Callers ask this for
			// `isReconciled`, so answering "not yet built" as `false` would be a
			// lie a scenario could pass on. Name the real problem instead.
			getReconciliationController: () => {
				const rc = product.reconciliationController;
				if (!rc) {
					throw new Error(
						"[YAOS QA] product.reconciliationController is not assigned. " +
						"Either the product has not finished starting, or the field was renamed.",
					);
				}
				return rc;
			},
			getConnectionController: () => product.connectionController ?? null,
			getFlightTraceController: () => lab.getFlightTraceController?.() ?? null,
			getEditorBindings: () => product.editorBindings ?? null,
			getDiagnosticsDir: () => undefined,
			sha256Hex: (text: string) => product.sha256Hex(text),
			// No start/stop bridge: the recorder follows the product's
			// settings.debug, which qa/scripts/prepare-vault-lib.ts sets to true.
			//
			// exportFlightTrace must return the written file path or null, and
			// buildQaDebugApi throws if path is null/falsy, so we drive the
			// FlightTraceController directly rather than the handle's
			// exportDebugTrace (which only shows a Notice).
			exportFlightTrace: async (privacy: "safe" | "full") => {
				const ftc = lab.getFlightTraceController?.() ?? null;
				if (!ftc) return null;
				const diagDir = await lab.diagnosticsService.ensureDiagnosticsDir().catch(() => null);
				if (!diagDir) return null;
				// "full" only widens the export header; event lines are identical.
				const result = await ftc.exportTrace({ diagDir, includeFilenames: privacy === "full" });
				return result.ok ? result.path : null;
			},
			runReconciliation: async () => {
				const rc = product.reconciliationController;
				await rc?.runReconciliation("conservative");
			},
			// setQaNetworkHold("offline") holds the provider offline and blocks reconnects.
			// setQaNetworkHold("online") releases the hold and triggers reconnect.
			disconnectProvider: () =>
				void product.setQaNetworkHold("offline"),
			connectProvider: () =>
				void product.setQaNetworkHold("online"),
			getPathSaltFingerprint: () => lab.getPathSaltFingerprint(),
			getEngineControlPort: () => product.getEngineControlPort(),
		});

		window.__YAOS_DEBUG__ = debugApi;
		console.log("[YAOS QA] window.__YAOS_DEBUG__ mounted successfully.");
		new Notice("YAOS QA: window.__YAOS_DEBUG__ is available.", 4000);
	}
}
