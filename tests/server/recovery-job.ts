import {
	advanceRecoveryPurgeProgress,
	canCancelRecoveryJob,
	createFailedRestoreItem,
	isRecoveryGcSweepCandidate,
	isRetryableRecoveryFailure,
	putCreateOnlyRecoveryRoot,
	recoveryProjectionPageAction,
	recoveryRestoreProgress,
	recoveryRetryDelay,
	shouldTraverseRecoveryGcObject,
} from "../../server/src/recoveryJob";
import {
	CloudflareRecoveryJobExecutor,
	parseRecoveryJobId,
	recoveryJobId,
	type CaptureStartDescriptor,
} from "../../server/src/recoveryExecutor";
import { encodeSnapshotRoot } from "../../server/src/recoveryManifestTree";
import { recoveryPrefix, RECOVERY_RPC_HEADER, vaultGenerationPrefix } from "../../server/src/recoveryProtocol";
import { FakeR2Bucket, makeRecoveryJobNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("recovery-job");
const vaultId = "vault-job-aa";
const vaultGeneration = "generation-job-aa";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function captureDescriptor(): CaptureStartDescriptor {
	return {
		vaultId,
		vaultGeneration,
		captureId: "capture_1",
		snapshotId: "snapshot_1",
		boundarySequence: 1,
		rootGeneration: 1,
		runtimeEpoch: "epoch_1",
		reason: "manual",
		createdAt: 1,
		capability: "capability",
		capabilityExpiresAt: 10_000,
		pinSoftExpiresAt: 5_000,
		pinHardExpiresAt: 10_000,
	};
}

s.section("Deterministic generation-fenced identities and retry policy");
{
	const jobId = recoveryJobId("capture", vaultId, vaultGeneration, "capture_1");
	const parsed = parseRecoveryJobId(jobId);
	s.check(
		parsed.vaultId === vaultId && parsed.vaultGeneration === vaultGeneration && parsed.operationId === "capture_1",
		"job identity preserves vault generation and operation identity",
	);
	s.check(
		recoveryJobId("capture", vaultId, "generation-job-bb", "capture_1") !== jobId,
		"same operation in a new generation receives a different actor",
	);
	s.check(isRetryableRecoveryFailure(new Error("R2 temporary 503")), "transient R2 failures retry");
	s.check(isRetryableRecoveryFailure(new Error("object key is temporarily leased")), "lease conflicts retry");
	s.check(isRetryableRecoveryFailure(new Error("internal error; reference = cf-generated")), "opaque platform failures retry within deadline");
	s.check(!isRetryableRecoveryFailure(new Error("invalid manifest structure")), "integrity failures do not retry forever");
	const first = recoveryRetryDelay(0);
	const capped = recoveryRetryDelay(100);
	s.check(first >= 0 && first < 1_000 && capped >= 0 && capped < 15 * 60_000, "full-jitter delay stays inside base and cap");
}

s.section("Cancellation, projection, restore, purge, and GC progress");
{
	s.check(canCancelRecoveryJob("queued") && canCancelRecoveryJob("retrying"), "queued and retrying jobs accept cancellation");
	s.check(!canCancelRecoveryJob("complete") && !canCancelRecoveryJob("cancelled"), "terminal jobs remain terminal");
	const partial = recoveryRestoreProgress(12, 5);
	const complete = recoveryRestoreProgress(12, 12);
	s.check(partial.processedEntries === 5 && !partial.complete && complete.complete, "restore progress waits for every item result");
	const deleting = advanceRecoveryPurgeProgress(0, 25);
	const nextPrefix = advanceRecoveryPurgeProgress(0, 0);
	s.check(!deleting.pageComplete && deleting.prefixIndex === 0, "purge repeats a nonempty generation prefix");
	s.check(nextPrefix.pageComplete && nextPrefix.prefixIndex === 1, "purge advances only after a prefix is empty");
	const projection = recoveryProjectionPageAction(0, false, "body-25");
	s.check(projection.kind === "advance" && projection.cursor === "body-25", "empty nonterminal projection pages durably advance");
	s.check(
		!shouldTraverseRecoveryGcObject("recovery", `${recoveryPrefix(vaultId, vaultGeneration)}/content/sha256/aa/${hashA}.md.gz`, undefined)
			&& shouldTraverseRecoveryGcObject("recovery", `${recoveryPrefix(vaultId, vaultGeneration)}/manifest/sha256/aa/${hashA}.json.gz`, "active"),
		"GC marks content directly and traverses only graph nodes",
	);
}

s.test("missing selective restore items become durable terminal results", async () => {
	const missing = await createFailedRestoreItem("restore_1", "active", "Missing.md", null, 0);
	if (missing.outcome !== "failed" || missing.errorCode !== "snapshot_item_missing") {
		throw new Error("missing direct selection was not terminal");
	}
});

s.section("GC immutable cutoff and grace");
{
	const markStartedAt = 1_000_000;
	const now = markStartedAt + 72 * 60 * 60_000;
	const grace = 48 * 60 * 60_000;
	s.check(isRecoveryGcSweepCandidate(markStartedAt - 1, markStartedAt, now, grace), "old unmarked object may sweep");
	s.check(!isRecoveryGcSweepCandidate(markStartedAt, markStartedAt, now, grace), "object at the mark cutoff is retained");
	s.check(!isRecoveryGcSweepCandidate(markStartedAt - 1, markStartedAt, markStartedAt + grace - 1, grace), "grace period prevents early sweep");
}

s.test("executor initialization is idempotent and every operation carries generation fencing", async () => {
	const requests: Request[] = [];
	const namespace = makeRecoveryJobNamespace(async (request) => {
		requests.push(request);
		const path = new URL(request.url).pathname;
		if (path.endsWith("/initialize")) {
			const body = await request.clone().json() as { jobId: string };
			return Response.json({ jobId: body.jobId });
		}
		if (path.endsWith("/status")) {
			return Response.json({
				jobId: recoveryJobId("capture", vaultId, vaultGeneration, "capture_1"),
				vaultId,
				vaultGeneration,
				kind: "capture",
				state: "queued",
				boundarySequence: 1,
				processedEntries: 0,
				totalEntries: null,
				contentObjectsWritten: 0,
				contentObjectsReused: 0,
				manifestNodesWritten: 0,
				bytesRead: 0,
				bytesWritten: 0,
				retryCount: 0,
				nextAttemptAt: null,
				error: null,
				cancelRequested: false,
				createdAt: 1,
				updatedAt: 1,
				completedAt: null,
				deletedObjects: 0,
				deletedBytes: 0,
			});
		}
		return Response.json(null);
	});
	const executor = new CloudflareRecoveryJobExecutor(namespace);
	const descriptor = captureDescriptor();
	const first = await executor.startCapture(descriptor);
	const replay = await executor.startCapture(descriptor);
	await executor.getStatus(first.jobId);
	await executor.cancel(first.jobId);
	if (first.jobId !== replay.jobId || requests.length !== 4) throw new Error("capture replay changed actor identity");
	if (requests.some((request) =>
		request.headers.get(RECOVERY_RPC_HEADER) !== "1"
		|| request.headers.get("x-yaos-vault-id") !== vaultId
		|| request.headers.get("x-yaos-vault-generation") !== vaultGeneration)) {
		throw new Error("executor bypassed strict generation-fenced transport");
	}
	if (requests.map((request) => new URL(request.url).pathname).join(",")
		!== "/__yaos/recovery-job/initialize,/__yaos/recovery-job/initialize,/__yaos/recovery-job/status,/__yaos/recovery-job/cancel") {
		throw new Error("executor used an unexpected internal route");
	}
});

s.test("descriptor generation and caller-supplied actor identity fail closed", async () => {
	let invoked = false;
	const namespace = makeRecoveryJobNamespace(async () => {
		invoked = true;
		return Response.json({ jobId: "unexpected" });
	});
	const executor = new CloudflareRecoveryJobExecutor(namespace);
	let rejected = false;
	try {
		await executor.startCapture({ ...captureDescriptor(), jobId: recoveryJobId("capture", vaultId, "generation-job-bb", "capture_1") });
	} catch {
		rejected = true;
	}
	if (!rejected || invoked) throw new Error("mismatched descriptor reached a Durable Object");
});

s.test("purge admission is restricted to the exact generation recovery and blob prefixes", async () => {
	let calls = 0;
	const namespace = makeRecoveryJobNamespace(async (request) => {
		calls++;
		const body = await request.json() as { jobId: string };
		return Response.json({ jobId: body.jobId });
	});
	const executor = new CloudflareRecoveryJobExecutor(namespace);
	const generationPrefix = vaultGenerationPrefix(vaultId, vaultGeneration);
	await executor.startPurge({
		vaultId,
		vaultGeneration,
		createdAt: 1,
		capability: "purge-capability",
		capabilityExpiresAt: 10_000,
		deletionId: "deletion_1",
		allowedPrefixes: [`${generationPrefix}/recovery-v2/`, `${generationPrefix}/blobs/`],
	});
	let rejected = false;
	try {
		await executor.startPurge({
			vaultId,
			vaultGeneration,
			createdAt: 1,
			capability: "purge-capability",
			capabilityExpiresAt: 10_000,
			deletionId: "deletion_1",
			allowedPrefixes: [`vault/${vaultId}/older-generation/recovery-v2/`, `${generationPrefix}/blobs/`],
		});
	} catch {
		rejected = true;
	}
	if (!rejected || calls !== 1) throw new Error("foreign-generation purge prefix reached the actor");
});

s.test("create-only root publication reuses exact bytes and rejects poisoned objects", async () => {
	const bucket = new FakeR2Bucket();
	const prefix = recoveryPrefix(vaultId, vaultGeneration);
	const encoded = await encodeSnapshotRoot(prefix, {
		format: "yaos-recovery-v2",
		snapshotFormatVersion: 2,
		snapshotId: "snapshot_1",
		vaultIdHash: hashA,
		vaultGenerationHash: hashB,
		runtimeEpoch: "epoch_1",
		boundarySequence: 10,
		rootGeneration: 2,
		sourcePlanDigest: hashB,
		manifestGraphDigest: hashC,
		manifestNodeCount: 3,
		createdAt: "2026-08-24T00:00:00.000Z",
		completedAt: "2026-08-24T00:01:00.000Z",
		health: "complete",
		reason: "manual",
		activeFilesTreeHash: hashA,
		deletedFilesTreeHash: hashB,
		attachmentsTreeHash: hashC,
		totals: { activeFiles: 1, deletedFiles: 0, unavailableFiles: 0, attachments: 0, markdownBytes: 4, attachmentBytes: 0 },
		previousSnapshotId: null,
	});
	await putCreateOnlyRecoveryRoot(bucket, encoded.objectKey, encoded.canonicalBytes, encoded.hash);
	await putCreateOnlyRecoveryRoot(bucket, encoded.objectKey, encoded.canonicalBytes, encoded.hash);
	if (bucket.puts.length !== 1) throw new Error("idempotent publication repeated a write");
	bucket.objects.set(encoded.objectKey, new TextEncoder().encode("different bytes"));
	let rejected = false;
	try {
		await putCreateOnlyRecoveryRoot(bucket, encoded.objectKey, encoded.canonicalBytes, encoded.hash);
	} catch {
		rejected = true;
	}
	if (!rejected) throw new Error("poisoned root collision was accepted");
});

await s.done();
