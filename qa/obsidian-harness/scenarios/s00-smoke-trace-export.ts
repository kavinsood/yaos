/**
 * S00 — Smoke: harness readiness + flight trace machinery.
 *
 * This is the required harness liveness gate.
 * Run it before any other scenario. If this fails, nothing else is meaningful.
 *
 * What it proves:
 *   - window.__YAOS_DEBUG__ is mounted (harness reached the product plugin)
 *   - window.__YAOS_QA__ is mounted (harness plugin itself is running)
 *   - waitForQaReady() passed (both globals exist)
 *   - QA product build is loaded (getEngineControlPort guard passed during mount)
 *   - Harness plugin is loaded (QA console API is registered)
 *   - getConnectionState() returns a sensible string (debug API is callable)
 *   - The harness runner can start a trace, export it, and return a non-null path
 *     (proven by the harness runner's own trace lifecycle around this scenario)
 *
 * Intentionally stateless:
 *   - No files created, modified, or deleted.
 *   - No server state required or assumed.
 *   - No CRDT convergence assertions.
 *
 * Trace lifecycle is managed by the harness runner:
 *   startTrace → setup → run → assert → exportTraceWithAnalyzer → cleanup
 * This scenario does NOT call startFlightTrace/exportFlightTrace/stopFlightTrace.
 * The controller checks result.tracePath after qa.run() returns.
 */

import type { QaScenario, QaContext } from "../types";

export const s00SmokeTraceExport: QaScenario = {
	id: "smoke-trace-export",
	title: "Smoke: harness ready + trace machinery (required liveness gate)",
	tags: ["smoke", "harness", "trace", "layer0", "release-gate"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		// Wait for local persistence loaded + reconciliation attempted.
		// This is the structural readiness gate — it times out if the plugin
		// is not making progress, which is a hard failure for the smoke.
		await ctx.waitForIdle(15_000);
	},

	async run(ctx: QaContext): Promise<void> {
		// Status ping: getConnectionState() is a synchronous, non-mutating read
		// of the provider state. It proves __YAOS_DEBUG__ is callable and that
		// the internal provider state machine is reachable.
		const connectionState = ctx.yaos.getConnectionState();
		if (typeof connectionState !== "string" || connectionState.length === 0) {
			throw new Error(
				`s00: getConnectionState() returned unexpected value: ${JSON.stringify(connectionState)}`,
			);
		}
		// connectionState is intentionally not asserted for a specific value —
		// the vault may be online, offline, or connecting. Any non-empty string is valid.
	},

	async assert(_ctx: QaContext): Promise<void> {
		// No vault assertions. The trace path check is done by the controller
		// (run-smoke-ready.mjs) after qa.run() returns, via result.tracePath.
	},

	async cleanup(_ctx: QaContext): Promise<void> {
		// Nothing to clean up.
	},
};
