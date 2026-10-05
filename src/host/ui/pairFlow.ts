/**
 * Pure state behind the pair modals: one in-memory enrollment attempt reused across retries of
 * the same input (idempotent on the server), single-flight submits, and applying the result to
 * plugin data. No obsidian runtime import.
 *
 * SECRETS: the attempt holds the pairing code and the new device token in memory only. clear()
 * drops it; nothing here logs or persists it (persisting the identity is the caller's job, via
 * host.updateData).
 */

import { sanitizeDeviceLabel, type PairedIdentity, type YaosPluginData } from "./api";
import {
	attemptMatches, pairDevice, prepareEnrollment, PairingError,
	type EnrollInput, type EnrollmentAttempt, type PairingDeps,
} from "./pairing";

export class PairingSession {
	private attempt: EnrollmentAttempt | null = null;
	private inFlight = false;

	constructor(private readonly deps: PairingDeps) {}

	get busy(): boolean {
		return this.inFlight;
	}

	/**
	 * Validates the input, reuses the previous attempt when the input is unchanged, checks the
	 * server, and enrolls. Rejects with a PairingError (message safe to show) on failure.
	 */
	async submit(input: EnrollInput): Promise<PairedIdentity> {
		if (this.inFlight) throw new PairingError("Pairing is already in progress.", "busy");
		this.inFlight = true;
		try {
			if (!attemptMatches(this.attempt, input)) this.attempt = prepareEnrollment(input, this.deps.randomBytes);
			const identity = await pairDevice(this.attempt, this.deps);
			this.attempt = null;
			return identity;
		} finally {
			this.inFlight = false;
		}
	}

	/** Forget the in-memory attempt (pairing code and unused token). */
	clear(): void {
		this.attempt = null;
	}

	/** For tests: whether an attempt is being kept for a retry. */
	get hasPendingAttempt(): boolean {
		return this.attempt !== null;
	}
}

/** Stores a fresh identity and adopts its device name as the local label. */
export function applyPairedIdentity(data: YaosPluginData, identity: PairedIdentity): YaosPluginData {
	return { ...data, identity, deviceLabel: sanitizeDeviceLabel(identity.deviceName, data.deviceLabel) };
}

/** Removes the identity (unpair). Engine settings and the label are kept. */
export function clearIdentity(data: YaosPluginData): YaosPluginData {
	return data.identity === null ? data : { ...data, identity: null };
}

/** "14:05" style countdown for pairing code expiry; "0:00" once expired. */
export function formatCountdown(remainingMs: number): string {
	const total = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
