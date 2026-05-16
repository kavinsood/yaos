/**
 * Analyzer rule: cross-device-hash-mismatch (Requirement 16)
 *
 * Hard finding when two devices emit device.witness.settled with different
 * stateHash values for the same pathId under the shared qaTraceSecret.
 *
 * B9: conflict-artifact paths are NOT flagged ONLY when the original pathId
 * is settled with a single agreed stateHash across all devices. If the original
 * path is not agreed, the artifact mismatch is still flagged.
 *
 * Pure function — no side effects, no Obsidian API.
 */

import type { FlightEvent } from "../flight-event";
import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface CrossDeviceHashSpec {
	traceId: string;
	/** If provided, only check these pathIds. Otherwise check all. */
	pathIds?: string[];
	/**
	 * Map from conflict-artifact pathId → original pathId.
	 * A conflict-artifact mismatch is suppressed ONLY when the original pathId
	 * has a single agreed stateHash across all devices (B9).
	 */
	conflictArtifacts?: Map<string, string>; // artifactPathId → originalPathId
}

/**
 * analyzeCrossDeviceHashesEqual — pure function.
 *
 * Per-device seq values are included in evidence for traceability but are
 * NEVER compared across devices for correctness (Requirement 3.2).
 */
export function analyzeCrossDeviceHashesEqual(
	events: FlightEvent[],
	spec: CrossDeviceHashSpec,
): AnalyzerResult {
	const settled = events.filter(
		(e) => e.kind === "device.witness.settled" && e.traceId === spec.traceId,
	);

	// Group by pathId → deviceId → most recent settled event
	const byPath = new Map<string, Map<string, FlightEvent>>();
	for (const e of settled) {
		if (!e.pathId || !e.deviceId) continue;
		if (spec.pathIds && !spec.pathIds.includes(e.pathId)) continue;
		const byDevice = byPath.get(e.pathId) ?? new Map<string, FlightEvent>();
		const existing = byDevice.get(e.deviceId);
		if (!existing || e.seq > existing.seq) {
			byDevice.set(e.deviceId, e);
		}
		byPath.set(e.pathId, byDevice);
	}

	// Pre-compute agreed hashes for all paths (needed for B9 artifact check)
	const agreedHash = new Map<string, string | null>(); // pathId → agreed hash or null if mismatch
	for (const [pathId, byDevice] of byPath) {
		const hashes = new Set([...byDevice.values()].map((e) => String((e.data as Record<string, unknown> | undefined)?.stateHash ?? "")));
		agreedHash.set(pathId, hashes.size === 1 ? [...hashes][0]! : null);
	}

	const findings: Evidence[] = [];
	const allOk: Evidence[] = [];

	for (const [pathId, byDevice] of byPath) {
		const hashes = new Map<string, string>();
		for (const [deviceId, e] of byDevice) {
			hashes.set(deviceId, String((e.data as Record<string, unknown> | undefined)?.stateHash ?? ""));
		}

		const uniqueHashes = new Set(hashes.values());
		if (uniqueHashes.size > 1) {
			// B9: check if this is a conflict artifact whose original path is agreed
			const originalPathId = spec.conflictArtifacts?.get(pathId);
			if (originalPathId) {
				const originalAgreed = agreedHash.get(originalPathId);
				if (originalAgreed !== null && originalAgreed !== undefined) {
					// Original path is agreed — suppress artifact mismatch per Requirement 16.5
					allOk.push({ kind: "artifact_suppressed", pathId, note: `Conflict artifact mismatch suppressed: original pathId=${originalPathId} is agreed on hash ${originalAgreed}` });
					continue;
				}
				// Original path is NOT agreed — still flag the artifact mismatch
			}

			const records: Evidence[] = [];
			for (const [deviceId, e] of byDevice) {
				records.push({
					kind: "settled",
					deviceId,
					pathId,
					seq: e.seq,
					stateHash: hashes.get(deviceId),
					note: `traceId=${spec.traceId}`,
					severity: "sync-correctness",
				});
			}
			findings.push(...records);
		} else {
			for (const [deviceId, e] of byDevice) {
				allOk.push({ kind: "settled", deviceId, pathId, seq: e.seq, stateHash: hashes.get(deviceId) });
			}
		}
	}

	if (findings.length > 0) {
		return {
			ok: false,
			reason: "cross_device_hash_mismatch",
			evidence: findings,
			summary: `Cross-device hash mismatch detected`,
		};
	}

	return {
		ok: true,
		evidence: allOk,
		summary: `All devices agree on stateHash for ${byPath.size} path(s)`,
	};
}
