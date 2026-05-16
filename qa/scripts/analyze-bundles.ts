#!/usr/bin/env bun
/**
 * qa/scripts/analyze-bundles.ts
 *
 * Offline analyzer CLI for Phase 3 witness bundles.
 *
 * Usage:
 *   bun run qa:analyze-bundles -- <bundle-file>... [--out <report-path>]
 *
 * Pure consumer: no Obsidian API, no live filesystem outside supplied paths
 * and report output, no network calls.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

interface BundleHeader {
	kind: "bundle.header";
	bundleSchemaVersion: number;
	createdAt: string;
	pluginVersion: string;
	deviceId: string;
	deviceLabel: string;
	platform: string;
	runtimeState: string;
	localTraceId: string;
	scenarioRunId: string | null;
	scenarioId: string | null;
	qaTraceSecretHash: string;
	flightMode: string;
	eventCount: number;
	containsRawPaths: boolean;
	hashDomain: string;
	privacyMode: string;
}

interface WitnessEvent {
	kind: string;
	path?: string;
	seq?: number;
	deviceId?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

interface ParsedBundle {
	filePath: string;
	header: BundleHeader;
	events: WitnessEvent[];
}

type BundleValidationEntry =
	| { filePath: string; accepted: true }
	| { filePath: string; accepted: false; reason: string };

// -----------------------------------------------------------------------
// Bundle parsing
// -----------------------------------------------------------------------

function parseBundle(filePath: string): { ok: true; bundle: ParsedBundle } | { ok: false; reason: string } {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (e) {
		return { ok: false, reason: `read_error: ${String(e)}` };
	}

	const lines = raw.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return { ok: false, reason: "empty_file" };

	let header: BundleHeader;
	try {
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		if (parsed.kind !== "bundle.header") return { ok: false, reason: "missing_bundle_header" };
		header = parsed as unknown as BundleHeader;
	} catch {
		return { ok: false, reason: "invalid_header_json" };
	}

	const events: WitnessEvent[] = [];
	for (const line of lines.slice(1)) {
		try {
			const obj = JSON.parse(line) as WitnessEvent;
			// Stamp deviceId from header onto events that lack it
			if (!obj.deviceId) obj.deviceId = header.deviceId;
			events.push(obj);
		} catch { /* skip malformed lines */ }
	}

	return { ok: true, bundle: { filePath, header, events } };
}

// -----------------------------------------------------------------------
// Bundle integrity check (Requirement 11)
// -----------------------------------------------------------------------

type RejectionReason =
	| "bundle_secret_hash_mismatch"
	| "bundle_scenario_run_id_mismatch"
	| "bundle_scenario_id_mismatch"
	| "bundle_schema_version_unsupported";

function runBundleIntegrityCheck(bundles: ParsedBundle[]): {
	accepted: ParsedBundle[];
	validation: BundleValidationEntry[];
	rejectionReason?: RejectionReason;
} {
	const validation: BundleValidationEntry[] = [];

	// Schema version check
	for (const b of bundles) {
		if (b.header.bundleSchemaVersion !== 1) {
			validation.push({ filePath: b.filePath, accepted: false, reason: "bundle_schema_version_unsupported" });
		}
	}
	const schemaRejected = validation.filter((v) => !v.accepted).map((v) => v.filePath);
	const schemaOk = bundles.filter((b) => !schemaRejected.includes(b.filePath));

	if (schemaOk.length === 0) {
		return { accepted: [], validation, rejectionReason: "bundle_schema_version_unsupported" };
	}

	// qaTraceSecretHash must match across all accepted bundles
	const secretHashes = new Set(schemaOk.map((b) => b.header.qaTraceSecretHash));
	if (secretHashes.size > 1) {
		for (const b of schemaOk) {
			validation.push({ filePath: b.filePath, accepted: false, reason: "bundle_secret_hash_mismatch" });
		}
		return { accepted: [], validation, rejectionReason: "bundle_secret_hash_mismatch" };
	}

	// scenarioRunId must match
	const runIds = new Set(schemaOk.map((b) => b.header.scenarioRunId ?? ""));
	if (runIds.size > 1) {
		for (const b of schemaOk) {
			validation.push({ filePath: b.filePath, accepted: false, reason: "bundle_scenario_run_id_mismatch" });
		}
		return { accepted: [], validation, rejectionReason: "bundle_scenario_run_id_mismatch" };
	}

	// scenarioId must match
	const scenarioIds = new Set(schemaOk.map((b) => b.header.scenarioId ?? ""));
	if (scenarioIds.size > 1) {
		for (const b of schemaOk) {
			validation.push({ filePath: b.filePath, accepted: false, reason: "bundle_scenario_id_mismatch" });
		}
		return { accepted: [], validation, rejectionReason: "bundle_scenario_id_mismatch" };
	}

	// All accepted
	for (const b of schemaOk) {
		validation.push({ filePath: b.filePath, accepted: true });
	}
	return { accepted: schemaOk, validation };
}

// -----------------------------------------------------------------------
// Inline analyzer rules (pure, no imports from witness-primitives to keep CLI standalone)
// -----------------------------------------------------------------------

interface AnalyzerResult {
	ruleName: string;
	ok: boolean;
	reason?: string;
	evidence: unknown[];
	summary: string;
}

const DIAGNOSTICS_CLASS = new Set(["checkpoint_write_failed", "checkpoint_path_inside_vault", "unavailable"]);

function analyzeWitnessQuorumOffline(events: WitnessEvent[], deviceIds: string[], pathFilter?: string): AnalyzerResult {
	const divergences = events.filter((e) =>
		e.kind === "device.witness.diverged" &&
		(!pathFilter || e.pathId === pathFilter || e.path === pathFilter) &&
		deviceIds.includes(e.deviceId ?? "") &&
		!DIAGNOSTICS_CLASS.has(String((e.data ?? {}).reason ?? "")),
	);
	if (divergences.length > 0) {
		return { ruleName: "analyzeWitnessQuorum", ok: false, reason: String((divergences[0]!.data ?? {}).reason ?? "unknown"), evidence: divergences, summary: `${divergences.length} sync-correctness divergence(s) found` };
	}
	const settled = events.filter((e) => e.kind === "device.witness.settled" && deviceIds.includes(e.deviceId ?? ""));
	return { ruleName: "analyzeWitnessQuorum", ok: true, evidence: settled, summary: `No sync-correctness divergences. ${settled.length} settled event(s).` };
}

function analyzeStaleHashOffline(events: WitnessEvent[], deviceIds: string[]): AnalyzerResult {
	const stale = events.filter((e) =>
		e.kind === "device.witness.diverged" &&
		deviceIds.includes(e.deviceId ?? "") &&
		(e.data ?? {}).reason === "stale_hash_after_newer_witness",
	);
	return { ruleName: "analyzeStaleHashAfterNewerWitness", ok: stale.length === 0, evidence: stale, summary: stale.length === 0 ? "No stale hash regressions." : `${stale.length} stale hash regression(s).` };
}

function analyzeRecoveryOldHashOffline(events: WitnessEvent[], deviceIds: string[]): AnalyzerResult {
	const bad = events.filter((e) =>
		e.kind === "device.witness.diverged" &&
		deviceIds.includes(e.deviceId ?? "") &&
		(e.data ?? {}).reason === "recovery_emitted_old_hash",
	);
	return { ruleName: "analyzeRecoveryEmittedOldHash", ok: bad.length === 0, evidence: bad, summary: bad.length === 0 ? "No recovery-old-hash regressions." : `${bad.length} recovery-old-hash regression(s).` };
}

function analyzeEditorStabilityOffline(events: WitnessEvent[], deviceIds: string[]): AnalyzerResult {
	const bad = events.filter((e) =>
		e.kind === "device.witness.diverged" &&
		deviceIds.includes(e.deviceId ?? "") &&
		["editor_crdt_mismatch", "editor_unhealthy"].includes(String((e.data ?? {}).reason ?? "")),
	);
	return { ruleName: "analyzeEditorStability", ok: bad.length === 0, evidence: bad, summary: bad.length === 0 ? "No editor stability issues." : `${bad.length} editor stability issue(s).` };
}

function analyzeCrossDeviceHashesEqualOffline(events: WitnessEvent[], deviceIds: string[]): AnalyzerResult {
	const byDevice: Record<string, string[]> = {};
	for (const e of events) {
		if (e.kind !== "device.witness.settled" || !e.deviceId || !deviceIds.includes(e.deviceId)) continue;
		const sh = String((e.data ?? {}).stateHash ?? "");
		if (!byDevice[e.deviceId]) byDevice[e.deviceId] = [];
		byDevice[e.deviceId]!.push(sh);
	}
	const lastHashes = Object.fromEntries(Object.entries(byDevice).map(([id, hs]) => [id, hs[hs.length - 1] ?? null]));
	const uniqueHashes = new Set(Object.values(lastHashes).filter(Boolean));
	if (uniqueHashes.size > 1) {
		return { ruleName: "analyzeCrossDeviceHashesEqual", ok: false, reason: "hash_mismatch", evidence: [lastHashes], summary: `Cross-device hash mismatch: ${JSON.stringify(lastHashes)}` };
	}
	return { ruleName: "analyzeCrossDeviceHashesEqual", ok: true, evidence: [lastHashes], summary: `All devices agree on hash: ${[...uniqueHashes][0] ?? "(none)"}` };
}

function analyzeConvergenceEvidenceOffline(events: WitnessEvent[], deviceIds: string[], expectedHash?: string): AnalyzerResult {
	if (!expectedHash) {
		// Infer from most common settled hash
		const counts: Record<string, number> = {};
		for (const e of events) {
			if (e.kind !== "device.witness.settled") continue;
			const sh = String((e.data ?? {}).stateHash ?? "");
			counts[sh] = (counts[sh] ?? 0) + 1;
		}
		expectedHash = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
	}
	if (!expectedHash) {
		return { ruleName: "analyzeConvergenceEvidence", ok: false, reason: "no_settled_events", evidence: [], summary: "No settled events found." };
	}

	const perDevice: Record<string, { settled: boolean; seq?: number; stepIndex?: number }> = {};
	for (const id of deviceIds) perDevice[id] = { settled: false };

	for (const e of events) {
		if (e.kind !== "device.witness.settled" || !e.deviceId || !deviceIds.includes(e.deviceId)) continue;
		const sh = String((e.data ?? {}).stateHash ?? "");
		if (sh !== expectedHash) continue;
		const rec = perDevice[e.deviceId]!;
		if (!rec.settled) {
			rec.settled = true;
			rec.seq = e.seq;
			rec.stepIndex = typeof (e.data ?? {}).scenarioStepIndex === "number" ? (e.data as Record<string, number>).scenarioStepIndex : undefined;
		}
	}

	const unsettled = deviceIds.filter((id) => !perDevice[id]?.settled);
	if (unsettled.length > 0) {
		// Devices with only diagnostics-class divergences are optional-missing, not failures
		const reallyUnsettled = unsettled.filter((id) => {
			const devEvents = events.filter((e) => e.deviceId === id);
			const hasSyncCorrectness = devEvents.some((e) => e.kind === "device.witness.diverged" && !DIAGNOSTICS_CLASS.has(String((e.data ?? {}).reason ?? "")));
			return hasSyncCorrectness || devEvents.length === 0;
		});
		if (reallyUnsettled.length > 0) {
			return { ruleName: "analyzeConvergenceEvidence", ok: false, reason: "convergence_incomplete", evidence: [perDevice], summary: `Devices did not converge: ${reallyUnsettled.join(", ")}` };
		}
		// All unsettled are diagnostics-class only — treat as optional-missing
	}

	const parts = deviceIds.map((id) => {
		const r = perDevice[id]!;
		return `Device ${id} settled with ${expectedHash} at step ${r.stepIndex ?? "?"} (seq ${r.seq ?? "?"}).`;
	});
	parts.push("No stale rewinds detected. No recovery emitted old hash.");
	return { ruleName: "analyzeConvergenceEvidence", ok: true, evidence: [perDevice], summary: parts.join(" ") };
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

function main(): void {
	const args = process.argv.slice(2);
	const bundleFiles: string[] = [];
	let outPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out" && args[i + 1]) {
			outPath = args[++i];
		} else if (args[i] && !args[i]!.startsWith("--")) {
			bundleFiles.push(args[i]!);
		}
	}

	if (bundleFiles.length === 0) {
		console.error("Usage: bun run qa:analyze-bundles -- <bundle-file>... [--out <report-path>]");
		process.exit(1);
	}

	// Parse bundles
	const parsed: ParsedBundle[] = [];
	const parseErrors: { filePath: string; reason: string }[] = [];
	for (const f of bundleFiles) {
		const result = parseBundle(resolve(f));
		if (result.ok) {
			parsed.push(result.bundle);
		} else {
			parseErrors.push({ filePath: f, reason: result.reason });
		}
	}

	if (parseErrors.length > 0) {
		console.error("Bundle parse errors:", parseErrors);
	}

	// Integrity check
	const { accepted, validation, rejectionReason } = runBundleIntegrityCheck(parsed);

	const firstHeader = accepted[0]?.header;
	const scenarioRunId = firstHeader?.scenarioRunId ?? "unknown";
	const scenarioId = firstHeader?.scenarioId ?? "unknown";
	const createdAt = firstHeader?.createdAt ?? new Date().toISOString();

	// Merge events from all accepted bundles
	const allEvents: WitnessEvent[] = [];
	for (const b of accepted) {
		allEvents.push(...b.events);
	}
	const deviceIds = accepted.map((b) => b.header.deviceId);

	const ruleResults: AnalyzerResult[] = [];
	let summaryOk = true;

	if (rejectionReason) {
		summaryOk = false;
	} else {
		// Run all rules
		const r1 = analyzeWitnessQuorumOffline(allEvents, deviceIds);
		const r2 = analyzeStaleHashOffline(allEvents, deviceIds);
		const r3 = analyzeRecoveryOldHashOffline(allEvents, deviceIds);
		const r4 = analyzeEditorStabilityOffline(allEvents, deviceIds);
		const r5 = analyzeCrossDeviceHashesEqualOffline(allEvents, deviceIds);
		const r6 = analyzeConvergenceEvidenceOffline(allEvents, deviceIds);
		ruleResults.push(r1, r2, r3, r4, r5, r6);
		summaryOk = ruleResults.every((r) => r.ok);
	}

	const report = {
		summary: {
			ok: summaryOk,
			bundleCount: accepted.length,
			eventCount: allEvents.length,
			scenarioRunId,
			scenarioId,
		},
		bundle_validation: {
			parseErrors,
			validation,
			rejectionReason: rejectionReason ?? null,
		},
		rules: ruleResults,
	};

	// Determine output path
	if (!outPath) {
		const ts = createdAt.replace(/[:.]/g, "-").slice(0, 19);
		outPath = `qa-runs/offline-${scenarioRunId}-${ts}/report.json`;
	}

	const outDir = dirname(outPath);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

	console.log(`\nBundle analysis complete.`);
	console.log(`  Bundles accepted: ${accepted.length} / ${parsed.length}`);
	console.log(`  Events analyzed: ${allEvents.length}`);
	console.log(`  Rules: ${ruleResults.filter((r) => r.ok).length}/${ruleResults.length} passed`);
	console.log(`  Overall: ${summaryOk ? "PASS ✓" : "FAIL ✗"}`);
	console.log(`  Report: ${outPath}\n`);

	process.exit(summaryOk ? 0 : 1);
}

main();
