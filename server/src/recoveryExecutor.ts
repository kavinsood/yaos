import type { RecoveryJobKind, RecoveryJobPhase } from "./recoveryJobState";
import { isCanonicalVaultId } from "./vaultId";
import { RECOVERY_RPC_HEADER, vaultGenerationPrefix } from "./recoveryProtocol";

export interface JobHandle {
	jobId: string;
}


export interface RecoveryJobStubPort {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RecoveryJobNamespacePort {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): RecoveryJobStubPort;
}
interface DescriptorBase {
	jobId?: string;
	vaultId: string;
	vaultGeneration: string;
	createdAt: number;
	capability: string;
	capabilityExpiresAt: number;
}

export interface CaptureStartDescriptor extends DescriptorBase {
	kind?: "capture";
	captureId: string;
	snapshotId: string;
	boundarySequence: number;
	rootGeneration: number;
	runtimeEpoch: string;
	reason: "initial" | "daily" | "manual" | "pre-bulk-operation";
	pinSoftExpiresAt: number;
	pinHardExpiresAt: number;
}

export interface ProjectionDescriptor extends DescriptorBase {
	kind?: "projection";
	leaseId: string;
}

export type RestoreSelection =
	| { kind: "all" }
	| { kind: "markdown-paths"; paths: string[] }
	| { kind: "attachment-paths"; paths: string[] }
	| { kind: "deleted-identities"; bodyIds: string[] };

export interface RestoreDescriptor extends DescriptorBase {
	kind?: "restore";
	restoreId: string;
	snapshotId: string;
	selection: RestoreSelection;
}

export interface GcDescriptor extends DescriptorBase {
	kind?: "gc";
	epoch: number;
	markStartedAt: number;
	deadlineAt: number;
	gracePeriodMs: number;
	domains: Array<"recovery" | "blob">;
}

export interface PurgeDescriptor extends DescriptorBase {
	kind?: "purge";
	allowedPrefixes: string[];
	deletionId: string;
}

export type RecoveryJobDescriptor =
	| CaptureStartDescriptor
	| ProjectionDescriptor
	| RestoreDescriptor
	| GcDescriptor
	| PurgeDescriptor;

export interface RecoveryJobErrorStatus {
	code: string;
	reference: string | null;
}

export interface RecoveryJobStatus {
	jobId: string;
	vaultId: string;
	vaultGeneration: string;
	kind: RecoveryJobKind;
	state: RecoveryJobPhase;
	boundarySequence: number | null;
	processedEntries: number;
	totalEntries: number | null;
	contentObjectsWritten: number;
	contentObjectsReused: number;
	manifestNodesWritten: number;
	bytesRead: number;
	bytesWritten: number;
	retryCount: number;
	nextAttemptAt: number | null;
	error: RecoveryJobErrorStatus | null;
	cancelRequested: boolean;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	deletedObjects: number;
	deletedBytes: number;
	captureId?: string;
	restoreId?: string;
	snapshotId?: string;
	pinSoftExpiresAt?: number | null;
	pinHardExpiresAt?: number | null;
}

export interface RecoveryJobExecutor {
	startCapture(descriptor: CaptureStartDescriptor): Promise<JobHandle>;
	startProjection(descriptor: ProjectionDescriptor): Promise<JobHandle>;
	startRestore(descriptor: RestoreDescriptor): Promise<JobHandle>;
	startGc(descriptor: GcDescriptor): Promise<JobHandle>;
	startPurge(descriptor: PurgeDescriptor): Promise<JobHandle>;
	getStatus(jobId: string): Promise<RecoveryJobStatus>;
	cancel(jobId: string): Promise<void>;
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CAPABILITY_BYTES = 512;
const encoder = new TextEncoder();

function assertSafeId(value: string, label: string): void {
	if (!SAFE_ID.test(value)) throw new Error(`invalid ${label}`);
}

function assertDescriptorBase(descriptor: DescriptorBase): void {
	if (!isCanonicalVaultId(descriptor.vaultId) || !isCanonicalVaultId(descriptor.vaultGeneration)) throw new Error("invalid vault identity");
	if (!Number.isSafeInteger(descriptor.createdAt) || descriptor.createdAt < 0) throw new Error("invalid job creation time");
	if (!Number.isSafeInteger(descriptor.capabilityExpiresAt) || descriptor.capabilityExpiresAt <= descriptor.createdAt) {
		throw new Error("invalid job capability expiry");
	}
	if (descriptor.capability.length === 0 || encoder.encode(descriptor.capability).byteLength > MAX_CAPABILITY_BYTES) {
		throw new Error("invalid job capability");
	}
}

export function recoveryJobId(
	kind: RecoveryJobKind,
	vaultId: string,
	vaultGeneration: string,
	operationId?: string,
): string {
	if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)) throw new Error("invalid vault identity");
	const identity = `${vaultId}:${vaultGeneration}`;
	if (kind === "gc" || kind === "projection" || kind === "purge") {
		if (operationId !== undefined) throw new Error(`${kind} job identity has no operation suffix`);
		return `${kind}:${identity}`;
	}
	if (!operationId) throw new Error(`${kind} job identity requires an operation id`);
	assertSafeId(operationId, "operation id");
	return `${kind}:${identity}:${operationId}`;
}

function descriptorKind(descriptor: RecoveryJobDescriptor): RecoveryJobKind {
	if ("captureId" in descriptor) return "capture";
	if ("leaseId" in descriptor) return "projection";
	if ("restoreId" in descriptor) return "restore";
	if ("epoch" in descriptor) return "gc";
	return "purge";
}

function expectedJobId(descriptor: RecoveryJobDescriptor): string {
	const kind = descriptorKind(descriptor);
	if (kind === "capture") return recoveryJobId(kind, descriptor.vaultId, descriptor.vaultGeneration, (descriptor as CaptureStartDescriptor).captureId);
	if (kind === "restore") return recoveryJobId(kind, descriptor.vaultId, descriptor.vaultGeneration, (descriptor as RestoreDescriptor).restoreId);
	return recoveryJobId(kind, descriptor.vaultId, descriptor.vaultGeneration);
}

function validateDescriptor(descriptor: RecoveryJobDescriptor): string {
	assertDescriptorBase(descriptor);
	const kind = descriptorKind(descriptor);
	const jobId = expectedJobId(descriptor);
	if (descriptor.jobId !== undefined && descriptor.jobId !== jobId) throw new Error("recovery job identity mismatch");
	if (kind === "capture") {
		const capture = descriptor as CaptureStartDescriptor;
		assertSafeId(capture.captureId, "capture id");
		assertSafeId(capture.snapshotId, "snapshot id");
		if (!Number.isSafeInteger(capture.boundarySequence) || capture.boundarySequence < 0) throw new Error("invalid capture boundary");
		if (!Number.isSafeInteger(capture.rootGeneration) || capture.rootGeneration < 0
			|| typeof capture.runtimeEpoch !== "string" || capture.runtimeEpoch.length === 0 || capture.runtimeEpoch.length > 256) {
			throw new Error("invalid capture root descriptor");
		}
		if (capture.pinSoftExpiresAt <= capture.createdAt || capture.pinHardExpiresAt < capture.pinSoftExpiresAt) {
			throw new Error("invalid capture pin expiry");
		}
	} else if (kind === "projection") {
		assertSafeId((descriptor as ProjectionDescriptor).leaseId, "projection lease id");
	} else if (kind === "restore") {
		const restore = descriptor as RestoreDescriptor;
		assertSafeId(restore.restoreId, "restore id");
		assertSafeId(restore.snapshotId, "snapshot id");
		const selected = "paths" in restore.selection ? restore.selection.paths : "bodyIds" in restore.selection ? restore.selection.bodyIds : [];
		if (selected.length > 10_000 || selected.some((value) => typeof value !== "string" || value.length === 0)) {
			throw new Error("invalid restore selection");
		}
	} else if (kind === "gc") {
		const gc = descriptor as GcDescriptor;
		if (!Number.isSafeInteger(gc.epoch) || gc.epoch < 1 || gc.markStartedAt < gc.createdAt
			|| gc.deadlineAt <= gc.markStartedAt || gc.gracePeriodMs < 0 || gc.domains.length === 0) {
			throw new Error("invalid GC descriptor");
		}
	} else {
		const purge = descriptor as PurgeDescriptor;
		assertSafeId(purge.deletionId, "deletion id");
		const prefix = vaultGenerationPrefix(purge.vaultId, purge.vaultGeneration);
		const expectedPrefixes = [`${prefix}/recovery-v2/`, `${prefix}/blobs/`];
		if (purge.allowedPrefixes.length !== expectedPrefixes.length
			|| purge.allowedPrefixes.some((value, index) => value !== expectedPrefixes[index])) {
			throw new Error("invalid purge prefixes");
		}
	}
	return jobId;
}

async function callRecoveryJob<T>(
	stub: RecoveryJobStubPort,
	vaultId: string,
	vaultGeneration: string,
	operation: "initialize" | "status" | "cancel",
	payload?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		[RECOVERY_RPC_HEADER]: "1",
		"x-yaos-vault-id": vaultId,
		"x-yaos-vault-generation": vaultGeneration,
	};
	if (payload !== undefined) headers["content-type"] = "application/json";
	const response = await stub.fetch(new Request(`https://internal/__yaos/recovery-job/${operation}`, {
		method: operation === "status" ? "GET" : "POST",
		headers,
		body: payload === undefined ? undefined : JSON.stringify(payload),
	}));
	if (!response.ok) {
		const message = (await response.text()).slice(0, 512);
		throw new Error(`recovery job ${operation} failed (${response.status}): ${message}`);
	}
	return await response.json() as T;
}

/** Cloudflare adapter for the runtime-independent executor port. */
export class CloudflareRecoveryJobExecutor implements RecoveryJobExecutor {
	constructor(private readonly namespace: RecoveryJobNamespacePort) {}

	private async start(descriptor: RecoveryJobDescriptor): Promise<JobHandle> {
		const jobId = validateDescriptor(descriptor);
		const stub = this.namespace.get(this.namespace.idFromName(jobId));
		const initialized = await callRecoveryJob<{ jobId: string }>(
			stub,
			descriptor.vaultId,
			descriptor.vaultGeneration,
			"initialize",
			{ ...descriptor, jobId },
		);
		if (initialized.jobId !== jobId) throw new Error("recovery job initialization acknowledgement mismatch");
		return { jobId };
	}

	startCapture(descriptor: CaptureStartDescriptor): Promise<JobHandle> {
		return this.start(descriptor);
	}

	startProjection(descriptor: ProjectionDescriptor): Promise<JobHandle> {
		return this.start(descriptor);
	}

	startRestore(descriptor: RestoreDescriptor): Promise<JobHandle> {
		return this.start(descriptor);
	}

	startGc(descriptor: GcDescriptor): Promise<JobHandle> {
		return this.start(descriptor);
	}

	startPurge(descriptor: PurgeDescriptor): Promise<JobHandle> {
		return this.start(descriptor);
	}

	async getStatus(jobId: string): Promise<RecoveryJobStatus> {
		const parsed = parseRecoveryJobId(jobId);
		const stub = this.namespace.get(this.namespace.idFromName(parsed.jobId));
		return await callRecoveryJob<RecoveryJobStatus>(stub, parsed.vaultId, parsed.vaultGeneration, "status");
	}

	async cancel(jobId: string): Promise<void> {
		const parsed = parseRecoveryJobId(jobId);
		const stub = this.namespace.get(this.namespace.idFromName(parsed.jobId));
		await callRecoveryJob<null>(stub, parsed.vaultId, parsed.vaultGeneration, "cancel");
	}
}

export function parseRecoveryJobId(jobId: string): {
	jobId: string;
	kind: RecoveryJobKind;
	vaultId: string;
	vaultGeneration: string;
	operationId?: string;
} {
	const segments = jobId.split(":");
	if (segments.length < 3 || segments.length > 4) throw new Error("invalid recovery job id arity");
	const [kindValue, vaultId, vaultGeneration, operationId] = segments;
	if (kindValue !== "capture" && kindValue !== "projection" && kindValue !== "restore"
		&& kindValue !== "gc" && kindValue !== "purge") throw new Error("invalid recovery job kind");
	const needsOperation = kindValue === "capture" || kindValue === "restore";
	if (needsOperation !== (operationId !== undefined)) throw new Error("invalid recovery job id arity");
	if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)) throw new Error("invalid vault identity");
	if (operationId !== undefined) assertSafeId(operationId, "operation id");
	return {
		jobId,
		kind: kindValue,
		vaultId,
		vaultGeneration,
		...(operationId === undefined ? {} : { operationId }),
	};
}
