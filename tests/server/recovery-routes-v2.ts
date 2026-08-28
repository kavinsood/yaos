import { classifyWorkerRoute, handleWorkerRequest } from "../../server/src/index";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import type { Env } from "../../server/src/routes/types";
import { handleRecoveryRoute, type RecoveryRouteAuthority } from "../../server/src/recoveryRoutes";
import { FakeObjectStore, makeConfigNamespace, makeEnv, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("recovery-routes-v2");
const vaultId = "vault-routes-aa";

function authority(overrides: Partial<RecoveryRouteAuthority> = {}): RecoveryRouteAuthority {
	const unexpected = (name: string) => async (): Promise<never> => {
		throw new Error(`unexpected authority call: ${name}`);
	};
	return {
		startRecoveryCapture: unexpected("startRecoveryCapture"),
		getRecoveryCaptureStatus: unexpected("getRecoveryCaptureStatus"),
		cancelRecoveryCapture: unexpected("cancelRecoveryCapture"),
		listRecoverySnapshots: unexpected("listRecoverySnapshots"),
		authorizeRecoverySnapshotRead: unexpected("authorizeRecoverySnapshotRead"),
		deleteRecoverySnapshot: unexpected("deleteRecoverySnapshot"),
		startRecoveryRestore: unexpected("startRecoveryRestore"),
		getRecoveryRestoreStatus: unexpected("getRecoveryRestoreStatus"),
		listRecoveryRestoreItems: unexpected("listRecoveryRestoreItems"),
		getRecoveryRestoreItemContent: unexpected("getRecoveryRestoreItemContent"),
		recordRecoveryRestoreResults: unexpected("recordRecoveryRestoreResults"),
		cancelRecoveryRestore: unexpected("cancelRecoveryRestore"),
		applyRecoveryRetention: unexpected("applyRecoveryRetention"),
		startRecoveryGc: unexpected("startRecoveryGc"),
		getRecoveryStatus: unexpected("getRecoveryStatus"),
		...overrides,
	};
}

function recoveryRequest(method: string, parts: string[], body?: unknown): Request {
	return new Request(`https://example.test/vault/${vaultId}/${parts.join("/")}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

s.test("strict classifier exposes only the public v2 route table", () => {
	const accepted: Array<[string, string]> = [
		["POST", "recovery/captures"],
		["GET", "recovery/captures/capture-1"],
		["DELETE", "recovery/captures/capture-1"],
		["GET", "recovery/snapshots"],
		["GET", "recovery/snapshots/snapshot-1"],
		["GET", "recovery/snapshots/snapshot-1/entry"],
		["GET", "recovery/snapshots/snapshot-1/file"],
		["GET", "recovery/snapshots/snapshot-1/deleted/body-1"],
		["GET", "recovery/snapshots/snapshot-1/deleted/body-1/file"],
		["DELETE", "recovery/snapshots/snapshot-1"],
		["POST", "recovery/restores"],
		["GET", "recovery/restores/restore-1"],
		["GET", "recovery/restores/restore-1/items"],
		["GET", "recovery/restores/restore-1/items/item-1/content"],
		["POST", "recovery/restores/restore-1/results"],
		["DELETE", "recovery/restores/restore-1"],
		["POST", "recovery/retention"],
		["POST", "recovery/gc"],
		["GET", "recovery/status"],
	];
	for (const [method, path] of accepted) {
		if (classifyWorkerRoute(new Request(`https://example.test/vault/${vaultId}/${path}`, { method })).kind !== "vault") {
			throw new Error(`${method} ${path} rejected`);
		}
	}
	for (const [method, path] of [
		["POST", "recovery/capture"],
		["GET", "snapshots"],
		["POST", "recovery/restores/restore-1/start"],
		["POST", "recovery/internal/recipe"],
		["POST", "recovery/finalize"],
	] as Array<[string, string]>) {
		if (classifyWorkerRoute(new Request(`https://example.test/vault/${vaultId}/${path}`, { method })).kind !== "not-found") {
			throw new Error(`${method} ${path} leaked into public routes`);
		}
	}
});

s.test("unknown recovery paths stay dark before Config, Sync, and Job allocation", async () => {
	const trap = makeTrapNamespace("unknown recovery route allocated a Durable Object");
	const env = makeEnv({ YAOS_SYNC: trap, YAOS_CONFIG: trap, YAOS_RECOVERY_JOBS: trap });
	for (const [method, path] of [
		["POST", "recovery/capture"],
		["POST", "recovery/internal/recipe"],
		["POST", "recovery/finalize"],
		["GET", "recovery/snapshots/id/arbitrary/hash"],
	] as Array<[string, string]>) {
		const response = await handleWorkerRequest(new Request(`https://example.test/vault/${vaultId}/${path}`, { method }), env);
		if (response.status !== 404) throw new Error(`${method} ${path} returned ${response.status}`);
	}
	if (trap.touched.length !== 0) throw new Error(`unknown route touched ${trap.touched.join(",")}`);
});

s.test("capture routes preserve request identity and public response shape", async () => {
	let received: unknown;
	const response = await handleRecoveryRoute(
		recoveryRequest("POST", ["recovery", "captures"], { reason: "manual", requestId: "request-1" }),
		["recovery", "captures"],
		{
			vaultId,
			authority: authority({
				startRecoveryCapture: async (input) => {
					received = input;
					return {
						captureId: "capture-1",
						boundarySequence: 7,
						state: "queued",
						statusUrl: `/vault/${vaultId}/recovery/captures/capture-1`,
					};
				},
			}),
		},
	);
	const body = await response.json() as Record<string, unknown>;
	if (response.status !== 202 || body.captureId !== "capture-1" || "capability" in body) throw new Error("capture response leaked authority or changed shape");
	if (JSON.stringify(received) !== JSON.stringify({ vaultId, reason: "manual", requestId: "request-1" })) throw new Error("capture request identity changed");
});

s.test("selective and bulk restore requests preserve exact selections", async () => {
	const received: unknown[] = [];
	const routeAuthority = authority({
		startRecoveryRestore: async (input) => {
			received.push(input);
			return { restoreId: `restore-${received.length}`, state: "enumerating" };
		},
	});
	for (const selection of [
		{ kind: "all" },
		{ kind: "markdown-paths", paths: ["notes/one.md", "notes/two.md"] },
		{ kind: "attachment-paths", paths: ["assets/one.png"] },
		{ kind: "deleted-identities", bodyIds: ["body-deleted-1"] },
	]) {
		const response = await handleRecoveryRoute(
			recoveryRequest("POST", ["recovery", "restores"], { requestId: `request-${received.length}`, snapshotId: "snapshot-1", selection }),
			["recovery", "restores"],
			{ vaultId, authority: routeAuthority },
		);
		if (response.status !== 202) throw new Error(`${selection.kind} restore returned ${response.status}`);
	}
	const bulk = received[0];
	if (received.length !== 4 || !bulk || typeof bulk !== "object" || !("selection" in bulk)
		|| JSON.stringify(bulk.selection) !== JSON.stringify({ kind: "all" })) {
		throw new Error("bulk restore selection changed");
	}
	const selective = received[3];
	if (!selective || typeof selective !== "object" || !("selection" in selective)
		|| JSON.stringify(selective.selection) !== JSON.stringify({ kind: "deleted-identities", bodyIds: ["body-deleted-1"] })) {
		throw new Error("selective deleted restore changed");
	}
});

s.test("restore item, content, and result endpoints form an explicit handshake", async () => {
	const calls: string[] = [];
	const routeAuthority = authority({
		listRecoveryRestoreItems: async ({ cursor, limit }) => {
			calls.push(`list:${cursor}:${limit}`);
			return { items: [{ itemId: "item-1", contentUrl: "/content" }], nextCursor: null, total: 1 };
		},
		getRecoveryRestoreItemContent: async ({ itemId }) => {
			calls.push(`content:${itemId}`);
			return new Response("body", { headers: { "x-yaos-content-sha256": "a".repeat(64), "x-yaos-content-size": "4" } });
		},
		recordRecoveryRestoreResults: async ({ results }) => {
			calls.push(`results:${results[0]?.itemId}:${results[0]?.outcome}`);
			return { accepted: 1, complete: true, terminal: true };
		},
	});
	const listed = await handleRecoveryRoute(
		new Request(`https://example.test/vault/${vaultId}/recovery/restores/restore-1/items?limit=1`),
		["recovery", "restores", "restore-1", "items"],
		{ vaultId, authority: routeAuthority },
	);
	const content = await handleRecoveryRoute(
		recoveryRequest("GET", ["recovery", "restores", "restore-1", "items", "item-1", "content"]),
		["recovery", "restores", "restore-1", "items", "item-1", "content"],
		{ vaultId, authority: routeAuthority },
	);
	const results = await handleRecoveryRoute(
		recoveryRequest("POST", ["recovery", "restores", "restore-1", "results"], { results: [{ itemId: "item-1", outcome: "restored" }] }),
		["recovery", "restores", "restore-1", "results"],
		{ vaultId, authority: routeAuthority },
	);
	if (listed.status !== 200 || content.status !== 200 || results.status !== 200) throw new Error("restore handshake changed status");
	if (calls.join(",") !== "list:null:1,content:item-1,results:item-1:restored") throw new Error(`restore handshake reordered: ${calls.join(",")}`);
});

s.test("invalid restore paths, duplicate items, and result aliases fail before authority", async () => {
	for (const body of [
		{ requestId: "request-1", snapshotId: "snapshot-1", selection: { kind: "markdown-paths", paths: ["../escape.md"] } },
		{ requestId: "request-1", snapshotId: "snapshot-1", selection: { kind: "markdown-paths", paths: ["same.md", "same.md"] } },
	]) {
		const response = await handleRecoveryRoute(
			recoveryRequest("POST", ["recovery", "restores"], body),
			["recovery", "restores"],
			{ vaultId, authority: authority() },
		);
		if (response.status !== 400) throw new Error(`invalid restore returned ${response.status}`);
	}
	const duplicateResults = await handleRecoveryRoute(
		recoveryRequest("POST", ["recovery", "restores", "restore-1", "results"], {
			results: [{ itemId: "item-1", outcome: "restored" }, { itemId: "item-1", outcome: "failed" }],
		}),
		["recovery", "restores", "restore-1", "results"],
		{ vaultId, authority: authority() },
	);
	if (duplicateResults.status !== 400) throw new Error("duplicate restore result reached authority");
});

s.test("snapshot deletion keeps dependency failures explicit and safe IDs canonical", async () => {
	let invoked = 0;
	const routeAuthority = authority({
		deleteRecoverySnapshot: async ({ snapshotId }) => {
			invoked++;
			if (snapshotId === "snapshot-dependent") throw new Error("snapshot is retained by policy or dependency");
			return { deleted: true };
		},
	});
	const dependent = await handleRecoveryRoute(
		recoveryRequest("DELETE", ["recovery", "snapshots", "snapshot-dependent"]),
		["recovery", "snapshots", "snapshot-dependent"],
		{ vaultId, authority: routeAuthority },
	);
	const invalid = await handleRecoveryRoute(
		recoveryRequest("DELETE", ["recovery", "snapshots", "%2e%2e"]),
		["recovery", "snapshots", "%2e%2e"],
		{ vaultId, authority: routeAuthority },
	);
	if (dependent.status !== 409 || !String((await dependent.json() as { error: string }).error).includes("dependency")) {
		throw new Error("dependency rejection was not explicit");
	}
	if (invalid.status !== 400 || invoked !== 1) throw new Error("encoded snapshot alias reached authority");
});

s.test("device bearer auth runs before vault allocation and missing bucket/jobs are explicit", async () => {
	invalidateStoredServerConfigCache();
	const sync = makeTrapNamespace("vault allocated unexpectedly");
	const config = makeConfigNamespace(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/__yaos/config") {
			return Response.json({
				configFormat: 2,
				claimed: true,
				operatorRecoveryHash: "a".repeat(64),
				ticketSigningKey: "ticket-key",
				updateProvider: null,
				updateRepoUrl: null,
				updateRepoBranch: null,
			});
		}
		if (path === "/__yaos/authorize-device") return Response.json({ device: { deviceId: "device-1", vaultId } });
		throw new Error(`unexpected config path ${path}`);
	});
	const unauthorized = await handleWorkerRequest(new Request(`https://example.test/vault/${vaultId}/recovery/status`), makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync }));
	if (unauthorized.status !== 401 || sync.touched.length !== 0) throw new Error("unauthorized request allocated vault state");
	const token = { authorization: "Bearer device-token" };
	const missingBoth = await handleWorkerRequest(new Request(`https://example.test/vault/${vaultId}/recovery/status`, { headers: token }), makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync }));
	const missingJobs = await handleWorkerRequest(new Request(`https://example.test/vault/${vaultId}/recovery/status`, { headers: token }), makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync, YAOS_BUCKET: new FakeObjectStore() }));
	const bothBody = await missingBoth.json() as Record<string, unknown>;
	const jobsBody = await missingJobs.json() as Record<string, unknown>;
	if (missingBoth.status !== 503 || bothBody.storageAvailable !== false || bothBody.jobsAvailable !== false) {
		throw new Error("missing recovery bindings were not explicit");
	}
	if (missingJobs.status !== 503 || jobsBody.storageAvailable !== true || jobsBody.jobsAvailable !== false) {
		throw new Error("missing jobs binding was not distinguished");
	}
	if (sync.touched.length !== 0) throw new Error("unavailable recovery allocated vault state");
});

await s.done();
