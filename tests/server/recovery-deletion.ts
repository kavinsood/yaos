import type { PendingDestroyRecord } from "../../server/src/config";
import { hashSecret, OPERATOR_COOKIE } from "../../server/src/identity";
import { recoveryJobId } from "../../server/src/recoveryExecutor";
import { attemptVaultCleanup, handleOperatorVaultDeletionStatus } from "../../server/src/routes/operator";
import {
	FakeR2Bucket,
	makeConfigNamespace,
	makeEnv,
	makeRecoveryJobNamespace,
	makeVaultSyncNamespace,
} from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("recovery-deletion");
const vaultId = "vault-delete-aa";
const vaultGeneration = "generation-delete-aa";

function pending(overrides: Partial<PendingDestroyRecord> = {}): PendingDestroyRecord {
	return {
		vaultId,
		vaultGeneration,
		deletionId: "deletion-delete-aa",
		purgeJobId: recoveryJobId("purge", vaultId, vaultGeneration),
		requestedAt: 1_000,
		roomComplete: false,
		r2Complete: false,
		purgeState: "pending",
		capabilityHash: "a".repeat(64),
		capabilityExpiresAt: Date.now() + 60_000,
		deletedObjects: 0,
		deletedBytes: 0,
		lastError: null,
		...overrides,
	};
}

function jobStatus(state: "queued" | "purging" | "retrying" | "complete" | "failed") {
	return {
		jobId: recoveryJobId("purge", vaultId, vaultGeneration),
		vaultId,
		vaultGeneration,
		kind: "purge",
		state,
		boundarySequence: null,
		processedEntries: 0,
		totalEntries: null,
		contentObjectsWritten: 0,
		contentObjectsReused: 0,
		manifestNodesWritten: 0,
		bytesRead: 0,
		bytesWritten: 0,
		retryCount: state === "retrying" ? 1 : 0,
		nextAttemptAt: state === "retrying" ? Date.now() + 1_000 : null,
		error: state === "failed" ? { code: "purge_failed", reference: null } : null,
		cancelRequested: false,
		createdAt: 1_000,
		updatedAt: 2_000,
		completedAt: state === "complete" ? 2_000 : null,
		deletedObjects: state === "complete" ? 3 : 1,
		deletedBytes: state === "complete" ? 30 : 10,
	};
}

s.test("room SQL deletion is never called before successful generation purge", async () => {
	const operations: string[] = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		operations.push(new URL(request.url).pathname);
		return Response.json({ deleting: true });
	});
	const jobs = makeRecoveryJobNamespace(async (request) => {
		operations.push(new URL(request.url).pathname);
		return Response.json(jobStatus("purging"));
	});
	let sqlDeletes = 0;
	const result = await attemptVaultCleanup(
		makeEnv({ YAOS_SYNC: sync, YAOS_RECOVERY_JOBS: jobs, YAOS_BUCKET: new FakeR2Bucket() }),
		vaultId,
		pending(),
		async () => {
			sqlDeletes++;
			return Response.json({ ok: true });
		},
	);
	if (sqlDeletes !== 0 || result.roomComplete || result.r2Complete || result.purgeState !== "purging") {
		throw new Error("SQL deletion ran before purge completion");
	}
	if (operations.join(",") !== "/__yaos/begin-vault-deletion,/__yaos/recovery-job/status") {
		throw new Error(`deletion ordering changed: ${operations.join(",")}`);
	}
});

s.test("successful generation purge permits exactly one SQL delete afterwards", async () => {
	const operations: string[] = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		operations.push(new URL(request.url).pathname);
		return Response.json({ deleting: true });
	});
	const jobs = makeRecoveryJobNamespace(async (request) => {
		operations.push(new URL(request.url).pathname);
		return Response.json(jobStatus("complete"));
	});
	const result = await attemptVaultCleanup(
		makeEnv({ YAOS_SYNC: sync, YAOS_RECOVERY_JOBS: jobs, YAOS_BUCKET: new FakeR2Bucket() }),
		vaultId,
		pending(),
		async () => {
			operations.push("SQL_DELETE_ALL");
			return Response.json({ ok: true });
		},
	);
	if (!result.r2Complete || !result.roomComplete || result.deletedObjects !== 3 || result.deletedBytes !== 30) {
		throw new Error("completed purge did not unlock SQL cleanup");
	}
	if (operations.join(",") !== "/__yaos/begin-vault-deletion,/__yaos/recovery-job/status,SQL_DELETE_ALL") {
		throw new Error(`purge-first ordering changed: ${operations.join(",")}`);
	}
});

s.test("retrying purge remains visible and never falls through to SQL deletion", async () => {
	const sync = makeVaultSyncNamespace(async () => Response.json({ deleting: true }));
	const jobs = makeRecoveryJobNamespace(async () => Response.json(jobStatus("retrying")));
	let sqlDeletes = 0;
	const result = await attemptVaultCleanup(
		makeEnv({ YAOS_SYNC: sync, YAOS_RECOVERY_JOBS: jobs, YAOS_BUCKET: new FakeR2Bucket() }),
		vaultId,
		pending(),
		async () => {
			sqlDeletes++;
			return Response.json({ ok: true });
		},
	);
	if (result.purgeState !== "retrying" || result.lastError !== null || sqlDeletes !== 0) {
		throw new Error("retrying purge was hidden or bypassed");
	}
});

s.test("operator deletion status remains available without waking the vault runtime", async () => {
	const sessionToken = "operator-deletion-status-token";
	const descriptor = pending({ purgeState: "retrying", lastError: "purge: transient" });
	let consoleReads = 0;
	const config = makeConfigNamespace(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/__yaos/verify-session") {
			const body = await request.json() as { sessionHash?: string };
			return body.sessionHash === await hashSecret(sessionToken)
				? Response.json({ ok: true })
				: Response.json({ error: "unauthorized" }, { status: 401 });
		}
		if (path === "/__yaos/console") {
			consoleReads++;
			return Response.json({ vaults: [], devices: [], pairingCodes: [], pendingDestroys: [descriptor] });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	});
	const response = await handleOperatorVaultDeletionStatus(
		new Request(`https://example.test/operator/vaults/${vaultId}/deletion`, {
			headers: { Cookie: `${OPERATOR_COOKIE}=${sessionToken}` },
		}),
		makeEnv({ YAOS_CONFIG: config }),
		vaultId,
	);
	const body = await response.json() as { pending?: PendingDestroyRecord };
	if (response.status !== 200 || consoleReads !== 1 || body.pending?.purgeState !== "retrying"
		|| body.pending.lastError !== descriptor.lastError) {
		throw new Error("operator retry status became unavailable");
	}
});

s.test("failed purge reset is fail-closed and cannot trigger SQL deletion", async () => {
	let sqlDeletes = 0;
	const sync = makeVaultSyncNamespace(async () => Response.json({ deleting: true }));
	const jobs = makeRecoveryJobNamespace(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/__yaos/recovery-job/status") return Response.json(jobStatus("failed"));
		if (path === "/__yaos/recovery-job/delete-state") return Response.json({ error: "reset rejected" }, { status: 409 });
		throw new Error(`unexpected job path ${path}`);
	});
	const result = await attemptVaultCleanup(
		makeEnv({ YAOS_SYNC: sync, YAOS_RECOVERY_JOBS: jobs, YAOS_BUCKET: new FakeR2Bucket() }),
		vaultId,
		pending({ purgeState: "failed" }),
		async () => {
			sqlDeletes++;
			return Response.json({ ok: true });
		},
	);
	if (sqlDeletes !== 0 || result.r2Complete || !result.lastError?.includes("purge reset returned HTTP 409")) {
		throw new Error("failed purge reset did not fail closed");
	}
});

await s.done();
