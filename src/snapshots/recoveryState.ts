import type {
	CaptureStatus,
	RecoveryStatus,
	RestoreStatus,
} from "./recoveryClient";

export interface PendingRecoveryState {
	activeCaptureId: string | null;
	activeRestore: { restoreId: string; snapshotId: string } | null;
	lastCaptureStatus: CaptureStatus | null;
	lastRestoreStatus: RestoreStatus | null;
	lastRecoveryStatus: RecoveryStatus | null;
}

export type RecoveryReadiness =
	| "unavailable"
	| "preparing"
	| "ready"
	| "retrying"
	| "gaps"
	| "failure";

export function getRecoveryReadiness(state: PendingRecoveryState): RecoveryReadiness {
	const recovery = state.lastRecoveryStatus;
	const capture = state.lastCaptureStatus;
	const restore = state.lastRestoreStatus;
	if (recovery?.storageAvailable === false) return "unavailable";
	if (capture?.state === "failed" || restore?.state === "failed") return "failure";
	if (capture?.state === "retrying" || restore?.state === "retrying" || recovery?.projectionState === "retrying") {
		return "retrying";
	}
	if (capture?.state === "complete_with_gaps") return "gaps";
	if (recovery?.recoveryReady) return "ready";
	return "preparing";
}

export const EMPTY_PENDING_RECOVERY_STATE: PendingRecoveryState = {
	activeCaptureId: null,
	activeRestore: null,
	lastCaptureStatus: null,
	lastRestoreStatus: null,
	lastRecoveryStatus: null,
};

/** The only persisted recovery-v2 client shape; it intentionally excludes plans and content. */
export function parsePendingRecoveryState(value: unknown): PendingRecoveryState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...EMPTY_PENDING_RECOVERY_STATE };
	const candidate = value as Partial<PendingRecoveryState>;
	const activeCaptureId = candidate.activeCaptureId === null || typeof candidate.activeCaptureId === "string"
		? candidate.activeCaptureId
		: null;
	const activeRestore = candidate.activeRestore !== null
		&& typeof candidate.activeRestore === "object"
		&& typeof candidate.activeRestore.restoreId === "string"
		&& typeof candidate.activeRestore.snapshotId === "string"
		? { restoreId: candidate.activeRestore.restoreId, snapshotId: candidate.activeRestore.snapshotId }
		: null;
	const lastCaptureStatus = candidate.lastCaptureStatus !== null
		&& typeof candidate.lastCaptureStatus === "object"
		&& typeof candidate.lastCaptureStatus.captureId === "string"
		&& typeof candidate.lastCaptureStatus.state === "string"
		? candidate.lastCaptureStatus
		: null;
	const lastRestoreStatus = candidate.lastRestoreStatus !== null
		&& typeof candidate.lastRestoreStatus === "object"
		&& typeof candidate.lastRestoreStatus.restoreId === "string"
		&& typeof candidate.lastRestoreStatus.state === "string"
		? candidate.lastRestoreStatus
		: null;
	const lastRecoveryStatus = candidate.lastRecoveryStatus !== null
		&& typeof candidate.lastRecoveryStatus === "object"
		&& typeof candidate.lastRecoveryStatus.syncReady === "boolean"
		&& typeof candidate.lastRecoveryStatus.recoveryReady === "boolean"
		? candidate.lastRecoveryStatus
		: null;
	return { activeCaptureId, activeRestore, lastCaptureStatus, lastRestoreStatus, lastRecoveryStatus };
}
