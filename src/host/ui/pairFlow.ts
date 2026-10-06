/**
 * Pure state behind the pair modals: one in-memory enrollment attempt reused across retries of
 * the same input (idempotent on the server), single-flight submits, and applying the result to
 * plugin data. No obsidian runtime import.
 *
 * SECRETS: the attempt holds the pairing code and the new device token. clear() drops the
 * in-memory copy; deps.persist stores it in plugin data while /enroll is unanswered (so a later
 * load can retry it once) and removes it on a definitive refusal. Nothing here logs it.
 */

import { sameIdentity, sanitizeDeviceLabel, type PairedIdentity, type YaosPluginData, type YaosUiHost } from "./api";
import {
	attemptMatches, pairDevice, prepareEnrollment, PairingError, runEnrollment,
	type EnrollInput, type EnrollmentAttempt, type PairingDeps,
} from "./pairing";

export interface PairingSessionDeps extends PairingDeps {
	/** Store the attempt in plugin data before it is sent; null removes it. */
	readonly persist?: (attempt: EnrollmentAttempt | null) => Promise<void>;
}

/**
 * True when retrying the same /enroll cannot succeed (a 4xx refusal, a bad address or a broken
 * response); false for an unreachable server, 408/429, 5xx and a pending authorization fence.
 */
export function enrollmentFailureIsFinal(err: unknown): boolean {
	if (!(err instanceof PairingError)) return false;
	if (err.code === "network" || err.code === "authorization_fence_pending") return false;
	const s = err.status;
	return s === null || !(s === 408 || s === 429 || s >= 500);
}

export class PairingSession {
	private attempt: EnrollmentAttempt | null = null;
	private inFlight = false;

	constructor(private readonly deps: PairingSessionDeps) {}

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
			const attempt = this.attempt;
			await this.deps.persist?.(attempt);
			try {
				const identity = await pairDevice(attempt, this.deps);
				this.attempt = null;
				return identity;
			} catch (err) {
				if (enrollmentFailureIsFinal(err)) await this.deps.persist?.(null).catch(() => undefined);
				throw err;
			}
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

/** Records the attempt about to be sent as the pending enrollment. */
export function setPendingEnrollment(data: YaosPluginData, attempt: EnrollmentAttempt): YaosPluginData {
	return { ...data, pendingEnrollment: attempt };
}

/** Drops the pending enrollment (only the one with `requestId` when given). */
export function withoutPendingEnrollment(data: YaosPluginData, requestId?: string): YaosPluginData {
	const p = data.pendingEnrollment;
	if (!p || (requestId !== undefined && p.enrollmentRequestId !== requestId)) return data;
	const { pendingEnrollment: _dropped, ...rest } = data;
	return rest;
}

/** Stores a fresh identity, adopts its device name as the local label and drops its pending attempt. */
export function applyPairedIdentity(data: YaosPluginData, identity: PairedIdentity): YaosPluginData {
	const rest = data.pendingEnrollment?.deviceId === identity.deviceId ? withoutPendingEnrollment(data) : data;
	return { ...rest, identity, deviceLabel: sanitizeDeviceLabel(identity.deviceName, data.deviceLabel) };
}

/** Removes the identity (unpair) and any pending enrollment. Engine settings and the label are kept. */
export function clearIdentity(data: YaosPluginData): YaosPluginData {
	const rest = withoutPendingEnrollment(data);
	return rest.identity === null ? rest : { ...rest, identity: null };
}

export type ResumedEnrollment =
	/** `replaced`: the identity this one replaced (to revoke on its server), else null. */
	| { readonly ok: true; readonly identity: PairedIdentity; readonly replaced: PairedIdentity | null }
	| { readonly ok: false; readonly error: unknown; readonly final: boolean };

/**
 * On load: one more try of the enrollment a previous session sent without seeing the answer.
 * Success stores the identity; a definitive refusal drops the attempt; anything else keeps it for
 * the next load. Returns null when nothing was pending. The caller revokes `replaced` on its server
 * (retireDeviceEnrollment), as PairModal does when a pairing replaces another.
 */
export async function resumePendingEnrollment(host: Pick<YaosUiHost, "data" | "updateData">, deps: PairingDeps): Promise<ResumedEnrollment | null> {
	const { pendingEnrollment: pending, identity: previous } = host.data();
	if (!pending) return null;
	try {
		const identity = await runEnrollment(pending, deps);
		await host.updateData((d) => applyPairedIdentity(d, identity));
		return { ok: true, identity, replaced: previous && !sameIdentity(previous, identity) ? previous : null };
	} catch (error) {
		const final = enrollmentFailureIsFinal(error);
		if (final) await host.updateData((d) => withoutPendingEnrollment(d, pending.enrollmentRequestId));
		return { ok: false, error, final };
	}
}

/** "14:05" style countdown for pairing code expiry; "0:00" once expired. */
export function formatCountdown(remainingMs: number): string {
	const total = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
