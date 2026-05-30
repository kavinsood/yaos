/**
 * Phase 2 cross-device witness primitives.
 *
 * These primitives aggregate per-device witness buffers under a shared
 * qaTraceSecret. They do NOT introduce a new wire protocol — they only
 * read per-device flight-recorder buffers through each device's QA debug API.
 *
 * Clock discipline (Requirement 3):
 *   - Wall-clock timestamps are NEVER used for correctness decisions.
 *   - Per-device seq is local-only; NEVER compared across devices.
 *   - Same-device duration checks use per-event monotonicMs deltas.
 *   - Controller-side wait timeouts use performance.now() (monotonic).
 *   - Cross-device ordering uses scenario command order or server receipt IDs.
 *
 * Device identity (Requirement 2):
 *   - All primitives key on deviceId (stable local UUID), never deviceName.
 */

import type { YaosQaDebugApi } from "../harness/qaDebugApi";
import type { WitnessBufferEntry } from "../../src/telemetry/diagnostics/deviceWitnessTracker";

export type DeviceId = string;

export type QuorumPolicy =
	| { kind: "all" }
	| { kind: "required"; required: DeviceId[]; optional?: DeviceId[] }
	| { kind: "atLeast"; count: number; devices: DeviceId[] };

export interface Evidence {
	kind: string;
	deviceId?: DeviceId;
	pathId?: string;
	seq?: number;
	stateHash?: string;
	stateKind?: string;
	data?: Record<string, unknown>;
	note?: string;
	severity?: "sync-correctness" | "diagnostics";
}

export interface QuorumSuccess {
	ok: true;
	witnesses: Record<DeviceId, WitnessBufferEntry>;
	evidence: Evidence[];
	warnings?: Evidence[];
}

export interface QuorumFailure {
	ok: false;
	reason: string;
	offendingDeviceId?: DeviceId;
	offendingEventSeq?: number;
	evidence: Evidence[];
	summary: string;
	perDevice?: Record<DeviceId, { lastObserved: WitnessBufferEntry | null; runtimeState?: string }>;
}

export type QuorumResult = QuorumSuccess | QuorumFailure;

export interface AnalyzerResult {
	ok: boolean;
	reason?: string;
	offendingDeviceId?: DeviceId;
	offendingEventSeq?: number;
	evidence: Evidence[];
	summary: string;
}

/** Device handle: deviceId + QA debug API */
export interface DeviceHandle {
	deviceId: DeviceId;
	api: YaosQaDebugApi;
}

// -----------------------------------------------------------------------
// Diagnostics-class reasons (Requirement 25.7)
// -----------------------------------------------------------------------

const DIAGNOSTICS_CLASS_REASONS = new Set([
	"checkpoint_write_failed",
	"checkpoint_path_inside_vault",
	"unavailable",
]);

export function evidenceSeverity(reason: string): "sync-correctness" | "diagnostics" {
	return DIAGNOSTICS_CLASS_REASONS.has(reason) ? "diagnostics" : "sync-correctness";
}

// -----------------------------------------------------------------------
// witnessQuorum (Requirement 6)
// -----------------------------------------------------------------------

export interface WitnessQuorumOptions {
	pathId: string;
	stateKind: "present" | "deleted";
	expectedStateHash: string;
	timeoutMs: number;
	minStableAfterMs: number;
	policy?: QuorumPolicy;
	requireEditorIfOpen?: boolean;
	/**
	 * Override the start seq per device for seq-anchoring.
	 * If provided, only events with seq > startSeqOverride[deviceId] are considered.
	 * Defaults to currentWitnessSeq() at call time.
	 */
	startSeqOverride?: Record<DeviceId, number>;
}

/**
 * Assert cross-device convergence by hash equality across a declared device set.
 * STRICT mode: fails immediately on any unexpected settled hash.
 * Use for pre-burst baseline where no intermediate states are expected.
 * For post-burst convergence where intermediate states are expected, use witnessQuorumEventually.
 *
 * Only considers witness events emitted AFTER the call begins (seq-anchored).
 * Uses controller-side monotonic timer (performance.now()) for timeout.
 * Never compares seq values across devices.
 */
export async function witnessQuorum(
	devices: DeviceHandle[],
	path: string,
	options: WitnessQuorumOptions,
): Promise<QuorumResult> {
	const { stateKind, expectedStateHash, timeoutMs, minStableAfterMs } = options;
	const policy: QuorumPolicy = options.policy ?? { kind: "all" };

	// Fix 3: verify all devices share the same active trace (traceId + SHA-256 qaTraceSecretHash)
	const traceInfos = new Map<DeviceId, { traceId: string; qaTraceSecretHash: string; hasQaTraceSecret: boolean }>();
	for (const d of devices) {
		const buf = d.api.getWitnessBuffer?.();
		if (buf === undefined) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], summary: `Device ${d.deviceId} has no active trace` };
		}
		const traceInfo = d.api.getActiveTraceInfo?.();
		if (!traceInfo) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], summary: `Device ${d.deviceId} does not expose trace info — cannot verify shared trace` };
		}
		// Fix 3: reject missing qaTraceSecret for cross-device quorum (multi-device requires shared secret)
		if (devices.length > 1 && !traceInfo.hasQaTraceSecret) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], summary: `Device ${d.deviceId} has no qaTraceSecret — cross-device quorum requires a shared trace secret` };
		}
		traceInfos.set(d.deviceId, traceInfo);
		const rt = d.api.getRuntimeState?.();
		if (rt && rt !== "foreground") {
			return { ok: false, reason: "mobile_background_unsupported", offendingDeviceId: d.deviceId, evidence: [{ kind: "mobile_background", deviceId: d.deviceId, data: { runtimeState: rt } }], summary: `Device ${d.deviceId} is in ${rt} state` };
		}
	}
	// Verify all devices share the same qaTraceSecretHash (traceId is per-device, not shared)
	const secretHashes = new Set([...traceInfos.values()].map((t) => t.qaTraceSecretHash));
	if (secretHashes.size > 1) {
		return { ok: false, reason: "device_trace_inactive", evidence: [], summary: `Devices have different qaTraceSecretHash — mismatched trace secrets` };
	}

	// Anchor: record start seq per device
	const startSeqs = new Map<DeviceId, number>();
	for (const d of devices) {
		startSeqs.set(d.deviceId, options.startSeqOverride?.[d.deviceId] ?? d.api.currentWitnessSeq?.() ?? 0);
	}

	const startMono = performance.now();
	const settled = new Map<DeviceId, WitnessBufferEntry>();
	// B5.2: track all post-start settled witnesses including wrong-hash ones
	const observedSettled = new Map<DeviceId, WitnessBufferEntry>();
	const evidence: Evidence[] = [];
	const warnings: Evidence[] = [];

	return new Promise((resolve) => {
		const check = () => {
			const elapsed = performance.now() - startMono;

			// B6: check mobile background on each poll
			for (const d of devices) {
				const rt = d.api.getRuntimeState?.();
				if (rt && rt !== "foreground") {
					resolve({
						ok: false,
						reason: "mobile_background_unsupported",
						offendingDeviceId: d.deviceId,
						evidence: [{ kind: "mobile_background", deviceId: d.deviceId, data: { runtimeState: rt } }],
						summary: `Device ${d.deviceId} became ${rt} during quorum wait`,
					});
					return;
				}
			}

			for (const d of devices) {
				if (settled.has(d.deviceId)) continue;
				const startSeq = startSeqs.get(d.deviceId) ?? 0;
				const buf = d.api.getWitnessBuffer?.() ?? [];

				for (const e of buf) {
					if (e.seq <= startSeq) continue;
					if (e.path !== path) continue;

					if (e.kind === "diverged") {
						const data = e.data as Record<string, unknown>;
						const reason = String(data.reason ?? "unknown");
						// Ignore diagnostics-class divergences (unavailable, checkpoint_*) — don't fail quorum
						if (evidenceSeverity(reason) === "diagnostics") continue;
						resolve({
							ok: false,
							reason,
							offendingDeviceId: d.deviceId,
							offendingEventSeq: e.seq,
							evidence: [{ kind: "diverged", deviceId: d.deviceId, seq: e.seq, data, severity: "sync-correctness" }],
							summary: `Device ${d.deviceId} diverged: ${reason}`,
						});
						return;
					}

					if (e.kind === "settled") {
						const data = e.data as Record<string, unknown>;
						const sh = String(data.stateHash ?? "");
						const sk = String(data.stateKind ?? "");
						const sams = Number(data.stableAfterMs ?? 0);

						if (sk !== stateKind) continue;

						// B5.2: track all post-start settled witnesses
						const prev = observedSettled.get(d.deviceId);
						if (!prev || e.seq > prev.seq) observedSettled.set(d.deviceId, e);

						if (sh !== expectedStateHash) {
							// Wrong hash — skip and wait for the correct one.
							// Device may settle with intermediate hashes during convergence.
							continue;
						}
						if (sams < minStableAfterMs) continue;

						// requireEditorIfOpen check
						if (options.requireEditorIfOpen && data.fileOpen) {
							const esk = String(data.editorSampleKind ?? "");
							if (esk !== "healthy_sampled") {
								resolve({
									ok: false,
									reason: "editor_required_but_not_healthy",
									offendingDeviceId: d.deviceId,
									offendingEventSeq: e.seq,
									evidence: [{ kind: "settled", deviceId: d.deviceId, seq: e.seq, data }],
									summary: `Device ${d.deviceId} editor not healthy: ${esk}`,
								});
								return;
							}
						}

						settled.set(d.deviceId, e);
						evidence.push({ kind: "settled", deviceId: d.deviceId, seq: e.seq, stateHash: sh, stateKind: sk });
					}
				}
			}

			// Check policy
			const policyResult = checkPolicy(policy, devices, settled);
			if (policyResult.satisfied) {
				if (policyResult.optionalMissing.length > 0) {
					for (const id of policyResult.optionalMissing) {
						warnings.push({ kind: "partial_optional_missing", deviceId: id, note: "optional device did not settle" });
					}
				}
				const witnesses: Record<DeviceId, WitnessBufferEntry> = {};
				for (const [id, e] of settled) witnesses[id] = e;
				resolve({ ok: true, witnesses, evidence, warnings: warnings.length > 0 ? warnings : undefined });
				return;
			}

			if (elapsed >= timeoutMs) {
				const perDevice: Record<DeviceId, { lastObserved: WitnessBufferEntry | null }> = {};
				for (const d of devices) {
					perDevice[d.deviceId] = { lastObserved: observedSettled.get(d.deviceId) ?? null };
				}
				const reason = policy.kind === "atLeast" && settled.size < policy.count
					? "atLeast_unsatisfied"
					: "quorum_timeout";
				resolve({
					ok: false,
					reason,
					evidence,
					summary: `Quorum timeout after ${timeoutMs}ms`,
					perDevice,
				});
				return;
			}

			setTimeout(check, 250);
		};
		check();
	});
}

function checkPolicy(
	policy: QuorumPolicy,
	devices: DeviceHandle[],
	settled: Map<DeviceId, WitnessBufferEntry>,
): { satisfied: boolean; optionalMissing: DeviceId[] } {
	if (policy.kind === "all") {
		const missing = devices.filter((d) => !settled.has(d.deviceId));
		return { satisfied: missing.length === 0, optionalMissing: [] };
	}
	if (policy.kind === "required") {
		const missingRequired = policy.required.filter((id) => !settled.has(id));
		if (missingRequired.length > 0) return { satisfied: false, optionalMissing: [] };
		const optionalMissing = (policy.optional ?? []).filter((id) => !settled.has(id));
		return { satisfied: true, optionalMissing };
	}
	// atLeast
	return { satisfied: settled.size >= policy.count, optionalMissing: [] };
}

// -----------------------------------------------------------------------
// witnessQuorumEventually — eventual convergence mode
//
// `witnessQuorum` is STRICT: it fails immediately on any unexpected settled hash.
// `witnessQuorumEventually` is EVENTUAL: it records unexpected settled hashes as
// intermediate evidence and waits for the expected hash. Only fails on
// sync-correctness divergence events (stale_hash, recovery_emitted_old_hash, etc.).
//
// Use `witnessQuorum` for pre-burst baseline (no intermediate states expected).
// Use `witnessQuorumEventually` for post-burst convergence (intermediate states
// during active propagation are expected and should be recorded, not failed on).
// -----------------------------------------------------------------------

export interface WitnessQuorumEventuallyResult {
	ok: boolean;
	reason?: string;
	offendingDeviceId?: DeviceId;
	offendingEventSeq?: number;
	evidence: Evidence[];
	/** Intermediate wrong-hash settled events observed per device before final convergence. */
	intermediateHashes: Record<DeviceId, Array<{ seq: number; stateHash: string }>>;
	summary: string;
	perDevice?: Record<DeviceId, { lastObserved: WitnessBufferEntry | null; settledCount: number; divergedCount: number }>;
}

/**
 * Wait for all devices to eventually settle with expectedStateHash.
 *
 * Records intermediate wrong-hash settled events as evidence (not failures).
 * Only fails on sync-correctness divergence events.
 * Uses controller-side monotonic timer. Never uses wall-clock.
 */
export async function witnessQuorumEventually(
	devices: DeviceHandle[],
	path: string,
	options: WitnessQuorumOptions,
): Promise<WitnessQuorumEventuallyResult> {
	const { stateKind, expectedStateHash, timeoutMs, minStableAfterMs } = options;
	const policy: QuorumPolicy = options.policy ?? { kind: "all" };

	// Trace identity check (same as witnessQuorum)
	const traceInfos = new Map<DeviceId, { traceId: string; qaTraceSecretHash: string; hasQaTraceSecret: boolean }>();
	for (const d of devices) {
		const buf = d.api.getWitnessBuffer?.();
		if (buf === undefined) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], intermediateHashes: {}, summary: `Device ${d.deviceId} has no active trace` };
		}
		const traceInfo = d.api.getActiveTraceInfo?.();
		if (!traceInfo) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], intermediateHashes: {}, summary: `Device ${d.deviceId} does not expose trace info` };
		}
		if (devices.length > 1 && !traceInfo.hasQaTraceSecret) {
			return { ok: false, reason: "device_trace_inactive", offendingDeviceId: d.deviceId, evidence: [], intermediateHashes: {}, summary: `Device ${d.deviceId} has no qaTraceSecret` };
		}
		traceInfos.set(d.deviceId, traceInfo);
		const rt = d.api.getRuntimeState?.();
		if (rt && rt !== "foreground") {
			return { ok: false, reason: "mobile_background_unsupported", offendingDeviceId: d.deviceId, evidence: [{ kind: "mobile_background", deviceId: d.deviceId, data: { runtimeState: rt } }], intermediateHashes: {}, summary: `Device ${d.deviceId} is in ${rt} state` };
		}
	}
	const secretHashes = new Set([...traceInfos.values()].map((t) => t.qaTraceSecretHash));
	if (secretHashes.size > 1) {
		return { ok: false, reason: "device_trace_inactive", evidence: [], intermediateHashes: {}, summary: `Devices have different qaTraceSecretHash` };
	}

	const startSeqs = new Map<DeviceId, number>();
	for (const d of devices) {
		startSeqs.set(d.deviceId, options.startSeqOverride?.[d.deviceId] ?? d.api.currentWitnessSeq?.() ?? 0);
	}

	const startMono = performance.now();
	const settled = new Map<DeviceId, WitnessBufferEntry>();
	const lastObserved = new Map<DeviceId, WitnessBufferEntry>();
	const intermediateHashes: Record<DeviceId, Array<{ seq: number; stateHash: string }>> = {};
	const settledCount: Record<DeviceId, number> = {};
	const divergedCount: Record<DeviceId, number> = {};
	/** Track highest processed seq per device to avoid double-counting across poll cycles. */
	const processedUpToSeq = new Map<DeviceId, number>();
	for (const d of devices) {
		intermediateHashes[d.deviceId] = [];
		settledCount[d.deviceId] = 0;
		divergedCount[d.deviceId] = 0;
		processedUpToSeq.set(d.deviceId, startSeqs.get(d.deviceId) ?? 0);
	}
	const evidence: Evidence[] = [];

	return new Promise((resolve) => {
		const check = () => {
			const elapsed = performance.now() - startMono;

			for (const d of devices) {
				const rt = d.api.getRuntimeState?.();
				if (rt && rt !== "foreground") {
					resolve({ ok: false, reason: "mobile_background_unsupported", offendingDeviceId: d.deviceId, evidence: [], intermediateHashes, summary: `Device ${d.deviceId} became ${rt}` });
					return;
				}
			}

			for (const d of devices) {
				if (settled.has(d.deviceId)) continue;
				const startSeq = startSeqs.get(d.deviceId) ?? 0;
				const buf = d.api.getWitnessBuffer?.() ?? [];

				for (const e of buf) {
					if (e.seq <= startSeq) continue;
					if (e.path !== path) continue;

					const prev = lastObserved.get(d.deviceId);
					if (!prev || e.seq > prev.seq) lastObserved.set(d.deviceId, e);

					// Only process each seq once across poll cycles
					const processedSeq = processedUpToSeq.get(d.deviceId) ?? 0;
					if (e.seq <= processedSeq) continue;

					if (e.kind === "diverged") {
						const data = e.data as Record<string, unknown>;
						const reason = String(data.reason ?? "unknown");
						divergedCount[d.deviceId] = (divergedCount[d.deviceId] ?? 0) + 1;
						processedUpToSeq.set(d.deviceId, Math.max(processedSeq, e.seq));
						// Only fail on sync-correctness divergences
						if (evidenceSeverity(reason) === "diagnostics") continue;
						resolve({
							ok: false,
							reason,
							offendingDeviceId: d.deviceId,
							offendingEventSeq: e.seq,
							evidence: [{ kind: "diverged", deviceId: d.deviceId, seq: e.seq, data, severity: "sync-correctness" }],
							intermediateHashes,
							summary: `Device ${d.deviceId} diverged: ${reason}`,
						});
						return;
					}

					if (e.kind === "settled") {
						const data = e.data as Record<string, unknown>;
						const sh = String(data.stateHash ?? "");
						const sk = String(data.stateKind ?? "");
						const sams = Number(data.stableAfterMs ?? 0);
						if (sk !== stateKind) continue;
						settledCount[d.deviceId] = (settledCount[d.deviceId] ?? 0) + 1;
						processedUpToSeq.set(d.deviceId, Math.max(processedSeq, e.seq));

						if (sh !== expectedStateHash) {
							// Record intermediate hash as evidence — NOT a failure
							intermediateHashes[d.deviceId]!.push({ seq: e.seq, stateHash: sh });
							continue;
						}
						if (sams < minStableAfterMs) continue;

						settled.set(d.deviceId, e);
						evidence.push({ kind: "settled", deviceId: d.deviceId, seq: e.seq, stateHash: sh, stateKind: sk });
					}
				}
			}

			const policyResult = checkPolicy(policy, devices, settled);
			if (policyResult.satisfied) {
				const witnesses: Record<DeviceId, WitnessBufferEntry> = {};
				for (const [id, e] of settled) witnesses[id] = e;
				resolve({ ok: true, evidence, intermediateHashes, summary: `All devices eventually settled with expected hash` });
				return;
			}

			if (elapsed >= timeoutMs) {
				const perDevice: Record<DeviceId, { lastObserved: WitnessBufferEntry | null; settledCount: number; divergedCount: number }> = {};
				for (const d of devices) {
					perDevice[d.deviceId] = {
						lastObserved: lastObserved.get(d.deviceId) ?? null,
						settledCount: settledCount[d.deviceId] ?? 0,
						divergedCount: divergedCount[d.deviceId] ?? 0,
					};
				}
				const reason = policy.kind === "atLeast" && settled.size < policy.count ? "atLeast_unsatisfied" : "quorum_timeout";
				resolve({
					ok: false,
					reason,
					evidence,
					intermediateHashes,
					summary: `Eventual quorum timeout after ${timeoutMs}ms. Intermediate hashes observed: ${Object.entries(intermediateHashes).map(([id, hs]) => `${id}:${hs.length}`).join(", ")}`,
					perDevice,
				});
				return;
			}

			setTimeout(check, 250);
		};
		check();
	});
}

// -----------------------------------------------------------------------
// noStaleHashAfterNewerWitness (Requirement 7.1-7.4)
// -----------------------------------------------------------------------

export interface NegativeWindowOptions {
	windowMs: number;
}

/**
 * Resolve at windowMs if no stale_hash_after_newer_witness divergence occurs.
 * Also detects the three-witness same-device hash regression pattern.
 * Local-edit exception: e_later.originClass === "local-edit" → pass with warning.
 *
 * Uses controller-side monotonic timer. Never uses wall-clock or cross-device seq.
 * B6: rejects immediately if device is mobile-backgrounded.
 */
export async function noStaleHashAfterNewerWitness(
	device: DeviceHandle,
	path: string,
	options: NegativeWindowOptions,
): Promise<AnalyzerResult> {
	// B6: check at start
	const rtStart = device.api.getRuntimeState?.();
	if (rtStart && rtStart !== "foreground") {
		return { ok: false, reason: "mobile_background_unsupported", evidence: [{ kind: "mobile_background", deviceId: device.deviceId, data: { runtimeState: rtStart } }], summary: `Device ${device.deviceId} is ${rtStart}` };
	}

	const startSeq = device.api.currentWitnessSeq?.() ?? 0;
	const startMono = performance.now();
	const evidence: Evidence[] = [];

	return new Promise((resolve) => {
		const check = () => {
			// B6: check on each poll
			const rt = device.api.getRuntimeState?.();
			if (rt && rt !== "foreground") {
				resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [{ kind: "mobile_background", deviceId: device.deviceId, data: { runtimeState: rt } }], summary: `Device ${device.deviceId} became ${rt}` });
				return;
			}

			const elapsed = performance.now() - startMono;
			const buf = device.api.getWitnessBuffer?.() ?? [];
			const relevant = buf.filter((e) => e.path === path && e.seq > startSeq);

			// Check for direct diverged event
			for (const e of relevant) {
				if (e.kind === "diverged") {
					const data = e.data as Record<string, unknown>;
					if (data.reason === "stale_hash_after_newer_witness") {
						resolve({
							ok: false,
							reason: "stale_hash_after_newer_witness",
							offendingEventSeq: e.seq,
							evidence: [{ kind: "diverged", deviceId: device.deviceId, seq: e.seq, data, severity: "sync-correctness" }],
							summary: `stale_hash_after_newer_witness on ${device.deviceId} for ${path}`,
						});
						return;
					}
					// B6: unavailable during window = fail
					if (data.reason === "unavailable") {
						resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [{ kind: "unavailable", deviceId: device.deviceId, seq: e.seq, data }], summary: `Device ${device.deviceId} became unavailable during window` });
						return;
					}
				}
			}

			// Three-witness regression pattern (Requirement 7.2)
			const settled = relevant.filter((e) => e.kind === "settled");
			for (let i = 0; i < settled.length; i++) {
				const e_old = settled[i]!;
				const oldHash = String((e_old.data as Record<string, unknown>).stateHash ?? "");
				const oldSk = String((e_old.data as Record<string, unknown>).stateKind ?? "");
				for (let j = i + 1; j < settled.length; j++) {
					const e_new = settled[j]!;
					const newHash = String((e_new.data as Record<string, unknown>).stateHash ?? "");
					const newSk = String((e_new.data as Record<string, unknown>).stateKind ?? "");
					if (newSk !== oldSk || newHash === oldHash) continue;
					for (let k = j + 1; k < settled.length; k++) {
						const e_later = settled[k]!;
						const laterHash = String((e_later.data as Record<string, unknown>).stateHash ?? "");
						const laterSk = String((e_later.data as Record<string, unknown>).stateKind ?? "");
						const laterOrigin = String((e_later.data as Record<string, unknown>).originClass ?? "");
						if (laterSk !== oldSk) continue;
						if (laterHash !== oldHash) continue;
						if (!(e_old.seq < e_new.seq && e_new.seq < e_later.seq)) continue;
						if (laterOrigin === "local-edit") {
							evidence.push({ kind: "local_edit_return_to_old_hash", deviceId: device.deviceId, seq: e_later.seq, note: "user undo — allowed" });
						} else {
							resolve({
								ok: false,
								reason: "stale_hash_after_newer_witness",
								offendingEventSeq: e_later.seq,
								evidence: [
									{ kind: "e_old", deviceId: device.deviceId, seq: e_old.seq, stateHash: oldHash },
									{ kind: "e_new", deviceId: device.deviceId, seq: e_new.seq, stateHash: newHash },
									{ kind: "e_later", deviceId: device.deviceId, seq: e_later.seq, stateHash: laterHash },
								],
								summary: `Three-witness stale hash regression on ${device.deviceId}`,
							});
							return;
						}
					}
				}
			}

			if (elapsed >= options.windowMs) {
				resolve({ ok: true, evidence, summary: `No stale hash after ${options.windowMs}ms` });
				return;
			}
			setTimeout(check, 250);
		};
		check();
	});
}

// -----------------------------------------------------------------------
// noRecoveryEmittedOldHash (Requirement 7.5)
// -----------------------------------------------------------------------

/**
 * Resolve at windowMs if no recovery_emitted_old_hash divergence occurs.
 * Uses controller-side monotonic timer. B6: rejects if device is backgrounded.
 */
export async function noRecoveryEmittedOldHash(
	device: DeviceHandle,
	path: string,
	options: NegativeWindowOptions,
): Promise<AnalyzerResult> {
	const rtStart = device.api.getRuntimeState?.();
	if (rtStart && rtStart !== "foreground") {
		return { ok: false, reason: "mobile_background_unsupported", evidence: [], summary: `Device ${device.deviceId} is ${rtStart}` };
	}

	const startSeq = device.api.currentWitnessSeq?.() ?? 0;
	const startMono = performance.now();

	return new Promise((resolve) => {
		const check = () => {
			const rt = device.api.getRuntimeState?.();
			if (rt && rt !== "foreground") {
				resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [], summary: `Device ${device.deviceId} became ${rt}` });
				return;
			}
			const elapsed = performance.now() - startMono;
			const buf = device.api.getWitnessBuffer?.() ?? [];
			for (const e of buf) {
				if (e.seq <= startSeq || e.path !== path) continue;
				if (e.kind === "diverged") {
					const data = e.data as Record<string, unknown>;
					if (data.reason === "recovery_emitted_old_hash") {
						resolve({ ok: false, reason: "recovery_emitted_old_hash", offendingEventSeq: e.seq, evidence: [{ kind: "diverged", deviceId: device.deviceId, seq: e.seq, data, severity: "sync-correctness" }], summary: `recovery_emitted_old_hash on ${device.deviceId} for ${path}` });
						return;
					}
					if (data.reason === "unavailable") {
						resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [{ kind: "unavailable", deviceId: device.deviceId, seq: e.seq, data }], summary: `Device ${device.deviceId} became unavailable` });
						return;
					}
				}
			}
			if (elapsed >= options.windowMs) {
				resolve({ ok: true, evidence: [], summary: `No recovery_emitted_old_hash after ${options.windowMs}ms` });
				return;
			}
			setTimeout(check, 250);
		};
		check();
	});
}

// -----------------------------------------------------------------------
// editorStableDuring (Requirement 7.6-7.7)
// -----------------------------------------------------------------------

/**
 * Resolve at durationMs if no editor_crdt_mismatch or editor_unhealthy divergence occurs.
 * Uses controller-side monotonic timer. B6: rejects if device is backgrounded.
 */
export async function editorStableDuring(
	device: DeviceHandle,
	path: string,
	durationMs: number,
): Promise<AnalyzerResult> {
	const rtStart = device.api.getRuntimeState?.();
	if (rtStart && rtStart !== "foreground") {
		return { ok: false, reason: "mobile_background_unsupported", evidence: [], summary: `Device ${device.deviceId} is ${rtStart}` };
	}

	const startSeq = device.api.currentWitnessSeq?.() ?? 0;
	const startMono = performance.now();

	return new Promise((resolve) => {
		const check = () => {
			const rt = device.api.getRuntimeState?.();
			if (rt && rt !== "foreground") {
				resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [], summary: `Device ${device.deviceId} became ${rt}` });
				return;
			}
			const elapsed = performance.now() - startMono;
			const buf = device.api.getWitnessBuffer?.() ?? [];
			for (const e of buf) {
				if (e.seq <= startSeq || e.path !== path) continue;
				if (e.kind === "diverged") {
					const data = e.data as Record<string, unknown>;
					const reason = String(data.reason ?? "");
					if (reason === "editor_crdt_mismatch" || reason === "editor_unhealthy") {
						resolve({ ok: false, reason, offendingEventSeq: e.seq, evidence: [{ kind: "diverged", deviceId: device.deviceId, seq: e.seq, data, severity: "sync-correctness" }], summary: `${reason} on ${device.deviceId} for ${path}` });
						return;
					}
					if (reason === "unavailable") {
						resolve({ ok: false, reason: "mobile_background_unsupported", evidence: [{ kind: "unavailable", deviceId: device.deviceId, seq: e.seq, data }], summary: `Device ${device.deviceId} became unavailable` });
						return;
					}
				}
			}
			if (elapsed >= durationMs) {
				resolve({ ok: true, evidence: [], summary: `Editor stable for ${durationMs}ms` });
				return;
			}
			setTimeout(check, 250);
		};
		check();
	});
}

// -----------------------------------------------------------------------
// crossDeviceHashesEqual (Requirement 8)
// -----------------------------------------------------------------------

export interface CrossDeviceHashesEqualOptions {
	stateKind?: "present" | "deleted";
}

/**
 * Non-waiting assertion: reads each device's most recent settled stateHash
 * for path and verifies byte-equality.
 *
 * Use witnessQuorum to PROVE convergence after an action.
 * Use crossDeviceHashesEqual ONLY at a known-quiet moment when convergence
 * has already been independently established (e.g., after a successful witnessQuorum).
 *
 * Does NOT wait for new events. Does NOT poll. Inspects buffers exactly once.
 * Never compares seq values across devices. Never uses wall-clock.
 * B6: rejects if any device is mobile-backgrounded.
 */
export function crossDeviceHashesEqual(
	devices: DeviceHandle[],
	path: string,
	options?: CrossDeviceHashesEqualOptions,
): AnalyzerResult {
	// B6: check mobile background
	for (const d of devices) {
		const rt = d.api.getRuntimeState?.();
		if (rt && rt !== "foreground") {
			return { ok: false, reason: "mobile_background_unsupported", offendingDeviceId: d.deviceId, evidence: [{ kind: "mobile_background", deviceId: d.deviceId, data: { runtimeState: rt } }], summary: `Device ${d.deviceId} is ${rt}` };
		}
	}

	const reads: Array<{ deviceId: DeviceId; stateHash: string; stateKind: string; seq: number }> = [];

	for (const d of devices) {
		const buf = d.api.getWitnessBuffer?.() ?? [];
		// Find most recent settled event for path
		let best: WitnessBufferEntry | null = null;
		for (const e of buf) {
			if (e.kind !== "settled" || e.path !== path) continue;
			const data = e.data as Record<string, unknown>;
			const sk = String(data.stateKind ?? "");
			if (options?.stateKind && sk !== options.stateKind) continue;
			if (!best || e.seq > best.seq) best = e;
		}
		if (!best) {
			return {
				ok: false,
				reason: "no_settled_witness",
				offendingDeviceId: d.deviceId,
				evidence: [],
				summary: `Device ${d.deviceId} has no settled witness for ${path}`,
			};
		}
		const data = best.data as Record<string, unknown>;
		reads.push({
			deviceId: d.deviceId,
			stateHash: String(data.stateHash ?? ""),
			stateKind: String(data.stateKind ?? ""),
			seq: best.seq,
		});
	}

	// Check stateKind consistency
	const kinds = new Set(reads.map((r) => r.stateKind));
	if (kinds.size > 1) {
		return {
			ok: false,
			reason: "cross_device_state_kind_mismatch",
			evidence: reads.map((r) => ({ kind: "settled", deviceId: r.deviceId, stateKind: r.stateKind, seq: r.seq })),
			summary: `Devices have different stateKinds: ${[...kinds].join(", ")}`,
		};
	}

	// Check hash equality
	const hashes = new Set(reads.map((r) => r.stateHash));
	if (hashes.size > 1) {
		return {
			ok: false,
			reason: "cross_device_hash_mismatch",
			evidence: reads.map((r) => ({ kind: "settled", deviceId: r.deviceId, stateHash: r.stateHash, seq: r.seq, severity: "sync-correctness" as const })),
			summary: `Cross-device hash mismatch: ${reads.map((r) => `${r.deviceId}=${r.stateHash}`).join(", ")}`,
		};
	}

	return {
		ok: true,
		evidence: reads.map((r) => ({ kind: "settled", deviceId: r.deviceId, stateHash: r.stateHash, seq: r.seq })),
		summary: `All devices agree on hash ${reads[0]?.stateHash ?? "?"}`,
	};
}

// -----------------------------------------------------------------------
// witnessCheckpointReader (Requirement 26)
// -----------------------------------------------------------------------

export interface CheckpointSegmentHeader {
	kind: "checkpoint.segment.header";
	traceId: string;
	deviceId: string;
	segmentIndex: number;
	firstSeq: number;
}

export interface CheckpointReadResult {
	/** Events as FlightEvent[] so they can be fed directly to analyzer rules (S2). */
	events: import("../analyzers/flight-event").FlightEvent[];
	deviceId: string;
	segmentsRead: number;
	corruptFinalLineReported: boolean;
}

/**
 * Pull checkpoint NDJSON segments from a device through its QA debug API.
 *
 * Devices NEVER read each other's filesystem. The controller calls this
 * once per device with that device's handle and aggregates in controller memory.
 *
 * Returns FlightEvent[] in chronological order by per-device local seq,
 * so the output can be fed directly to analyzer rules (S2).
 * Tolerates a corrupt final line in the highest-index segment (Requirement 24.5).
 */
export async function witnessCheckpointReader(
	device: DeviceHandle,
	traceId: string,
): Promise<CheckpointReadResult> {
	if (!device.api.readWitnessCheckpoint) {
		throw Object.assign(
			new Error(`witnessCheckpointReader: device ${device.deviceId} does not support checkpoint reads`),
			{ reason: "checkpoint_not_found", deviceId: device.deviceId },
		);
	}

	const result = await device.api.readWitnessCheckpoint(traceId);
	if (!result || result.segments.length === 0) {
		const checkpointStatus = result?.status ?? "unknown";
		throw Object.assign(
			new Error(`witnessCheckpointReader: no witness segments for traceId=${traceId} on device ${device.deviceId} (status=${checkpointStatus})`),
			{ reason: "checkpoint_not_found", checkpointStatus, deviceId: device.deviceId },
		);
	}

	const allEvents: import("../analyzers/flight-event").FlightEvent[] = [];
	let corruptFinalLineReported = false;
	const maxSegmentIndex = Math.max(...result.segments.map((s) => s.index));

	for (const seg of result.segments.sort((a, b) => a.index - b.index)) {
		const lines = seg.content.split("\n").filter((l) => l.trim());
		if (lines.length === 0) continue;

		// First line must be a valid header
		let header: CheckpointSegmentHeader;
		try {
			header = JSON.parse(lines[0]!) as CheckpointSegmentHeader;
			if (header.kind !== "checkpoint.segment.header") throw new Error("not a header");
		} catch {
			throw Object.assign(
				new Error(`witnessCheckpointReader: segment ${seg.index} missing valid header`),
				{ reason: "checkpoint_parse_failed", segmentIndex: seg.index, lineNumber: 1 },
			);
		}

		for (let i = 1; i < lines.length; i++) {
			const line = lines[i]!;
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				const kind = String(parsed.kind ?? "");
				if (kind !== "device.witness.settled" && kind !== "device.witness.diverged") {
					throw new Error(`unexpected kind: ${kind}`);
				}
				// Convert checkpoint line to FlightEvent shape for analyzer compatibility (S2)
				const data = (parsed.data as Record<string, unknown>) ?? {};
				allEvents.push({
					ts: 0, // checkpoint lines don't carry ts; display-only anyway
					seq: Number(parsed.seq ?? 0),
					kind,
					severity: kind === "device.witness.settled" ? "info" : "warn",
					scope: "file",
					source: "deviceWitness",
					layer: "diagnostics",
					priority: "important",
					traceId,
					deviceId: result.deviceId,
					fileId: String(parsed.fileId ?? ""),
					// pathId is not in checkpoint (raw path omitted for privacy — B3)
					// Analyzer rules that need pathId must use fileId or in-memory buffer
					data,
					reason: String(data.reason ?? ""),
					decision: kind === "device.witness.settled" ? "settled" : "diverged",
				});
			} catch {
				// Corrupt final line in highest-index segment is tolerated (Requirement 24.5)
				if (seg.index === maxSegmentIndex && i === lines.length - 1) {
					corruptFinalLineReported = true;
				} else {
					throw Object.assign(
						new Error(`witnessCheckpointReader: parse error in segment ${seg.index} line ${i + 1}`),
						{ reason: "checkpoint_parse_failed", segmentIndex: seg.index, lineNumber: i + 1 },
					);
				}
			}
		}
		void header; // used for validation above
	}

	// Sort by per-device local seq (local-only ordering, never cross-device)
	allEvents.sort((a, b) => a.seq - b.seq);

	return {
		events: allEvents,
		deviceId: result.deviceId,
		segmentsRead: result.segments.length,
		corruptFinalLineReported,
	};
}
