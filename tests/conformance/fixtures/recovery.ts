import { strict as assert } from "node:assert";
import {
	bearer,
	crashRecoveryCaptureAtDispatch,
	createBody,
	hardRestart,
	pass,
	type JsonResult,
	vaultJson,
	vaultUrl,
} from "../client.ts";
import { SNAPSHOT_FORMAT_VERSION, targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const CAPTURE_WORKLOAD_BODY_COUNT = 30;
async function retryJson(suffix: string, label: string): Promise<JsonResult> {
	const deadline = Date.now() + 10_000;
	let lastFailure = "no attempt";
	while (Date.now() < deadline) {
		try {
			const result = await vaultJson(target.deviceA, suffix);
			if (result.response.ok) return result;
			lastFailure = `HTTP ${result.response.status}: ${JSON.stringify(result.body)}`;
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${label} did not become readable: ${lastFailure}`);
}

async function waitForState(
	suffix: string,
	accepted: readonly string[],
	label: string,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 60_000;
	let last: Record<string, unknown> | null = null;
	while (Date.now() < deadline) {
		const result = await retryJson(suffix, label);
		if (!result.body) throw new Error(`${label} returned non-object JSON`);
		last = result.body;
		if (typeof last.state === "string" && accepted.includes(last.state)) return last;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`${label} did not reach ${accepted.join("/")}: ${JSON.stringify(last)}`);
}

for (let index = 0; index < CAPTURE_WORKLOAD_BODY_COUNT; index++) {
	const path = index === 0 ? "recovery.md" : `recovery-workload-${index}.md`;
	const content = index === 0
		? "recovery restart and bounded reads"
		: `recovery multi-slice workload ${index}`;
	await createBody(target.deviceA, path, content);
}
const captureRequest = {
	reason: "manual" as const,
	requestId: `capture_${crypto.randomUUID().replaceAll("-", "")}`,
};
const crashResume = target.capabilities.has("recovery-crash-resume");
let captureId: string;
if (crashResume) {
	const barrier = await crashRecoveryCaptureAtDispatch(target, target.deviceA, captureRequest);
	captureId = barrier.captureId;
	assert.ok(barrier.dispatchId.length > 0);
	assert.ok(barrier.crashPid > 0);
	assert.equal(barrier.crashSignal, "SIGKILL");
	pass(`recovery capture dispatch ${barrier.dispatchId} was in-flight in phase ${barrier.observedState} before a verified SIGKILL`);
} else {
	const started = await vaultJson(target.deviceA, "recovery/captures", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(captureRequest),
	});
	assert.equal(started.response.status, 202, JSON.stringify(started.body));
	assert.ok(started.body && typeof started.body.captureId === "string");
	captureId = started.body.captureId;
	console.log("  GAP   target does not declare recovery-crash-resume; capture still must complete");
}
const capture = await waitForState(
	`recovery/captures/${captureId}`,
	["complete", "complete_with_gaps", "failed"],
	"recovery capture after process restart",
);
if (capture.state !== "complete" && capture.state !== "complete_with_gaps") {
	throw new Error(`capture did not complete: ${JSON.stringify(capture)}`);
}
assert.equal(typeof capture.snapshotId, "string");
const snapshotId = capture.snapshotId as string;
pass(crashResume
	? "recovery capture job and acknowledgement resume after a crash restart"
	: "recovery capture completes without claiming process-level alarm recovery");

const badLimit = await vaultJson(target.deviceA, "recovery/snapshots?limit=101");
assert.equal(badLimit.response.status, 400);
const catalog = await vaultJson(target.deviceA, "recovery/snapshots?limit=1");
assert.equal(catalog.response.status, 200);
assert.ok(catalog.body && Array.isArray(catalog.body.snapshots));
assert.ok((catalog.body.snapshots as Array<{ snapshotId?: unknown }>).some((entry) => entry.snapshotId === snapshotId));
const root = await vaultJson(target.deviceA, `recovery/snapshots/${snapshotId}`);
assert.equal(root.response.status, 200);
assert.equal(root.body?.format, "yaos-recovery-v2");
assert.equal(root.body?.snapshotFormatVersion, SNAPSHOT_FORMAT_VERSION);
const entry = await vaultJson(target.deviceA, `recovery/snapshots/${snapshotId}/entry?path=${encodeURIComponent("recovery.md")}`);
assert.equal(entry.response.status, 200);
assert.equal(entry.body?.path, "recovery.md");
const file = await fetch(`${vaultUrl(target.deviceA, `recovery/snapshots/${snapshotId}/file`)}?path=${encodeURIComponent("recovery.md")}`, { headers: bearer(target.deviceA) });
assert.equal(file.status, 200);
assert.equal(await file.text(), "recovery restart and bounded reads");
pass("recovery-v2 catalog and bounded object reads expose verified snapshot content");

const restore = await vaultJson(target.deviceA, "recovery/restores", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		requestId: `restore_${crypto.randomUUID().replaceAll("-", "")}`, snapshotId, selection: { kind: "markdown-paths", paths: ["recovery.md"] },
	}),
});
assert.equal(restore.response.status, 202);
assert.ok(restore.body && typeof restore.body.restoreId === "string");
const restoreId = restore.body.restoreId;
const restoreStatus = await waitForState(
	`recovery/restores/${restoreId}`,
	["awaiting-results", "failed"],
	"restore awaiting client results",
);
if (restoreStatus.state !== "awaiting-results") {
	throw new Error(`restore did not reach awaiting-results: ${JSON.stringify(restoreStatus)}`);
}
await hardRestart(target);
const items = await retryJson(`recovery/restores/${restoreId}/items?limit=10`, "restore items after crash restart");
assert.equal(items.response.status, 200);
const list = items.body?.items as Array<{ itemId?: unknown; path?: unknown }>;
assert.equal(list.length, 1);
assert.equal(list[0]?.path, "recovery.md");
const itemId = list[0]?.itemId;
assert.equal(typeof itemId, "string");
const acknowledged = await vaultJson(target.deviceA, `recovery/restores/${restoreId}/results`, {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ itemId, outcome: "skipped-changed" }] }),
});
assert.equal(acknowledged.response.status, 200);
assert.equal((await waitForState(`recovery/restores/${restoreId}`, ["complete"], "restore completion")).state, "complete");
pass("restore work survives restart and completes only after client acknowledgement");
