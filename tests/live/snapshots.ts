import { deviceBearerHeaders, requireLiveIdentity } from "./liveIdentity.ts";
import { requestJson, vaultRoute } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const TERMINAL = new Set(["complete", "complete_with_gaps", "failed", "cancelled"]);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

async function waitForState(
	suffix: string,
	accepted: ReadonlySet<string>,
	label: string,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 15_000;
	let last: Record<string, unknown> | null = null;
	while (Date.now() < deadline) {
		const result = await requestJson(identity, suffix);
		if (!result.response.ok || !result.body) throw new Error(`${label} status failed (${result.response.status})`);
		last = result.body;
		if (typeof last.state === "string" && accepted.has(last.state)) return last;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${label} did not reach ${[...accepted].join("/")}: ${JSON.stringify(last)}`);
}

console.log("\n--- Recovery-v2 capture/read/restore smoke ---");
const requestId = `live-capture-${crypto.randomUUID()}`;
const started = await requestJson(identity, "recovery/captures", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ reason: "manual", requestId }),
});
if (started.response.status === 503) {
	assert(started.body?.error === "recovery_unavailable", "missing recovery bindings report recovery_unavailable explicitly");
	assert(typeof started.body.storageAvailable === "boolean" && typeof started.body.jobsAvailable === "boolean", "unavailable response identifies bucket and job binding availability");
	console.log(`Recovery smoke unavailable: storage=${String(started.body.storageAvailable)}, jobs=${String(started.body.jobsAvailable)}.`);
	process.exit(0);
}
assert(started.response.status === 202 && typeof started.body?.captureId === "string", "manual recovery-v2 capture starts asynchronously");
const captureId = started.body.captureId;
const capture = await waitForState(`recovery/captures/${encodeURIComponent(captureId)}`, TERMINAL, "capture");
assert(capture.state === "complete" || capture.state === "complete_with_gaps", `capture reaches a successful terminal state (${String(capture.state)})`);
assert(typeof capture.snapshotId === "string", "terminal capture publishes a snapshot identity");
const snapshotId = capture.snapshotId;

const catalog = await requestJson(identity, "recovery/snapshots?limit=10");
assert(catalog.response.status === 200 && Array.isArray(catalog.body?.snapshots), "recovery snapshot catalog is listable");
assert((catalog.body.snapshots as Array<{ snapshotId?: unknown }>).some((entry) => entry.snapshotId === snapshotId), "catalog contains the completed capture");

const root = await requestJson(identity, `recovery/snapshots/${encodeURIComponent(snapshotId)}`);
assert(root.response.status === 200 && root.body?.format === "yaos-recovery-v2" && root.body.snapshotFormatVersion === 2, "snapshot root is recovery format v2");
const entry = await requestJson(identity, `recovery/snapshots/${encodeURIComponent(snapshotId)}/entry?path=${encodeURIComponent("redeploy-test.md")}`);
assert(entry.response.status === 200 && entry.body?.path === "redeploy-test.md", "one snapshot manifest entry is readable");
const file = await fetch(vaultRoute(identity, `recovery/snapshots/${encodeURIComponent(snapshotId)}/file?path=${encodeURIComponent("redeploy-test.md")}`), {
	headers: deviceBearerHeaders(identity),
});
const fileText = await file.text();
assert(file.status === 200 && fileText.includes("SQL redeploy durability"), "one recovery content object is readable and verified");

const restore = await requestJson(identity, "recovery/restores", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		requestId: `live-restore-${crypto.randomUUID()}`,
		snapshotId,
		selection: { kind: "markdown-paths", paths: ["redeploy-test.md"] },
	}),
});
assert(restore.response.status === 202 && typeof restore.body?.restoreId === "string", "selective restore handshake starts for one markdown path");
const restoreId = restore.body.restoreId;
const ready = await waitForState(
	`recovery/restores/${encodeURIComponent(restoreId)}`,
	new Set(["awaiting-results", ...TERMINAL]),
	"restore",
);
assert(ready.state === "awaiting-results", `selective restore enumerates client work (${String(ready.state)})`);
const items = await requestJson(identity, `recovery/restores/${encodeURIComponent(restoreId)}/items?limit=10`);
const list = Array.isArray(items.body?.items) ? items.body.items as Array<Record<string, unknown>> : [];
assert(items.response.status === 200 && list.length === 1 && list[0]?.path === "redeploy-test.md", "restore lists exactly the selected snapshot entry");
const itemId = list[0]?.itemId;
assert(typeof itemId === "string", "restore item has a stable identity");
const restoreContent = await fetch(vaultRoute(identity, `recovery/restores/${encodeURIComponent(restoreId)}/items/${encodeURIComponent(itemId)}/content`), {
	headers: deviceBearerHeaders(identity),
});
assert(restoreContent.status === 200 && (await restoreContent.text()) === fileText, "restore item content matches the snapshot read");
const recorded = await requestJson(identity, `recovery/restores/${encodeURIComponent(restoreId)}/results`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ results: [{ itemId, outcome: "skipped-changed" }] }),
});
assert(recorded.response.status === 200, "client result acknowledgement completes the selective restore handshake safely");
const completed = await waitForState(`recovery/restores/${encodeURIComponent(restoreId)}`, new Set(["complete"]), "restore completion");
assert(completed.state === "complete", "selective restore reaches terminal completion");
console.log("\n✓ Recovery-v2 bounded smoke passed");
