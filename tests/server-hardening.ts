import { runSerialized, runSingleFlight } from "../server/src/asyncConcurrency";
import { MAX_BLOB_UPLOAD_BYTES } from "../server/src/contracts";
import worker from "../server/src/index";
import { getCapabilities } from "../server/src/routes/auth";
import { handleBlobRoute } from "../server/src/routes/blobs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeConfigNamespace(config: Record<string, unknown>) {
	return {
		idFromName: () => "global-config",
		get: () => ({
			fetch: async () => new Response(JSON.stringify(config), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		}),
	};
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

console.log("\n--- Test 1: runSingleFlight shares one in-flight cold-start load ---");
{
	let loadCalls = 0;
	let releaseLoad: (() => void) | null = null;
	const loadGate = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			await loadGate;
		});

	const pending = Promise.all([loadRoom(), loadRoom(), loadRoom()]);
	releaseLoad?.();
	await pending;

	assert(loadCalls === 1, "concurrent cold-start callers share one load task");
	assert(gate.inFlight === null, "single-flight gate clears after a successful load");
}

console.log("\n--- Test 2: runSingleFlight clears after a failed load so the next call can retry ---");
{
	let loadCalls = 0;
	let shouldFail = true;
	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			if (shouldFail) {
				throw new Error("boom");
			}
		});

	let sawFailure = false;
	try {
		await loadRoom();
	} catch {
		sawFailure = true;
	}

	assert(sawFailure, "failed single-flight load surfaces the original error");
	assert(gate.inFlight === null, "single-flight gate clears after a failed load");

	shouldFail = false;
	await loadRoom();
	assert(loadCalls === 2, "single-flight load can retry after a failure");
	assert(gate.inFlight === null, "single-flight gate clears after the retry succeeds");
}

console.log("\n--- Test 3: runSerialized keeps snapshot maybe logic single-filed under concurrency ---");
{
	const serialized = { chain: Promise.resolve() };
	let activeRuns = 0;
	let maxActiveRuns = 0;
	let created = false;

	const maybeCreateSnapshot = (triggeredBy: string) =>
		runSerialized(serialized, async () => {
			activeRuns++;
			maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
			try {
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (created) {
					return {
						status: "noop" as const,
						triggeredBy,
					};
				}
				created = true;
				return {
					status: "created" as const,
					triggeredBy,
				};
			} finally {
				activeRuns--;
			}
		});

	const results = await Promise.all([
		maybeCreateSnapshot("device-a"),
		maybeCreateSnapshot("device-b"),
		maybeCreateSnapshot("device-c"),
		maybeCreateSnapshot("device-d"),
	]);
	const createdResults = results.filter((result) => result.status === "created");
	const noopResults = results.filter((result) => result.status === "noop");

	assert(maxActiveRuns === 1, "serialized queue never runs snapshot maybe work concurrently");
	assert(createdResults.length === 1, "serialized snapshot maybe logic produces exactly one created result");
	assert(noopResults.length === results.length - 1, "remaining serialized snapshot maybe calls become noops");
}

console.log("\n--- Test 4: blob uploads reject poisoned content-addressed keys ---");
{
	let putCalls = 0;
	const bucket = {
		put: async () => {
			putCalls++;
		},
	};
	const env = { YAOS_BUCKET: bucket } as any;
	const body = new TextEncoder().encode("not the bytes for this hash");
	const wrongHash = "0".repeat(64);
	const res = await handleBlobRoute(
		env,
		"vault",
		new Request(`https://example.test/vault/vault/blobs/${wrongHash}`, {
			method: "PUT",
			body,
		}),
		[wrongHash],
		json,
	);
	assert(res.status === 400, "blob upload with mismatched body hash is rejected");
	assert(putCalls === 0, "mismatched blob body is not written to R2");
}

console.log("\n--- Test 5: blob uploads reject oversized Content-Length before R2 writes ---");
{
	let putCalls = 0;
	const bucket = {
		put: async () => {
			putCalls++;
		},
	};
	const env = { YAOS_BUCKET: bucket } as any;
	const body = new TextEncoder().encode("small body");
	const hash = await sha256Hex(body);
	const res = await handleBlobRoute(
		env,
		"vault",
		new Request(`https://example.test/vault/vault/blobs/${hash}`, {
			method: "PUT",
			headers: { "Content-Length": String(11 * 1024 * 1024) },
			body,
		}),
		[hash],
		json,
	);
	assert(res.status === 413, "blob upload with oversized Content-Length is rejected");
	assert(putCalls === 0, "oversized blob upload is not written to R2");
}

console.log("\n--- Test 6: blob uploads accept bytes whose body matches the address ---");
{
	let putCalls = 0;
	let writtenKey = "";
	const bucket = {
		put: async (key: string) => {
			putCalls++;
			writtenKey = key;
		},
	};
	const env = { YAOS_BUCKET: bucket } as any;
	const body = new TextEncoder().encode("correct content-addressed bytes");
	const hash = await sha256Hex(body);
	const res = await handleBlobRoute(
		env,
		"vault",
		new Request(`https://example.test/vault/vault/blobs/${hash}`, {
			method: "PUT",
			body,
		}),
		[hash],
		json,
	);
	assert(res.status === 204, "blob upload with matching body hash is accepted");
	assert(putCalls === 1, "matching blob body is written once");
	assert(writtenKey.endsWith(hash), "matching blob body is written under its hash key");
}

console.log("\n--- Test 7: blob uploads reject malformed Content-Length ---");
{
	let putCalls = 0;
	const bucket = {
		put: async () => {
			putCalls++;
		},
	};
	const env = { YAOS_BUCKET: bucket } as any;
	const body = new TextEncoder().encode("small body");
	const hash = await sha256Hex(body);
	const res = await handleBlobRoute(
		env,
		"vault",
		new Request(`https://example.test/vault/vault/blobs/${hash}`, {
			method: "PUT",
			headers: { "Content-Length": "not-a-number" },
			body,
		}),
		[hash],
		json,
	);
	assert(res.status === 400, "blob upload with malformed Content-Length is rejected");
	assert(putCalls === 0, "malformed Content-Length upload is not written to R2");
}

console.log("\n--- Test 8: public capabilities do not expose private update metadata ---");
{
	const env = { YAOS_BUCKET: {} } as any;
	const auth = { mode: "claim", claimed: true, tokenHash: "hash" } as const;
	const config = {
		claimed: true,
		tokenHash: "hash",
		updateProvider: "github" as const,
		updateRepoUrl: "https://github.com/private/fork",
		updateRepoBranch: "secret-branch",
	};
	const publicCaps = getCapabilities(auth, env, config);
	assert(publicCaps.maxBlobUploadBytes === MAX_BLOB_UPLOAD_BYTES, "capabilities expose the server blob upload cap");
	assert(publicCaps.updateProvider === null, "public capabilities hide update provider");
	assert(publicCaps.updateRepoUrl === null, "public capabilities hide update repo URL");
	assert(publicCaps.updateRepoBranch === null, "public capabilities hide update repo branch");

	const privateCaps = getCapabilities(auth, env, config, { includePrivateUpdateMetadata: true });
	assert(privateCaps.updateProvider === "github", "authenticated capabilities include update provider");
	assert(privateCaps.updateRepoUrl === "https://github.com/private/fork", "authenticated capabilities include update repo URL");
	assert(privateCaps.updateRepoBranch === "secret-branch", "authenticated capabilities include update repo branch");
}

console.log("\n--- Test 9: /api/capabilities route splits public and authenticated metadata ---");
{
	const token = "correct-token";
	const env = {
		SYNC_TOKEN: token,
		YAOS_BUCKET: {},
		YAOS_CONFIG: makeConfigNamespace({
			claimed: true,
			tokenHash: "unused-env-token-mode",
			updateProvider: "github",
			updateRepoUrl: "https://github.com/private/fork",
			updateRepoBranch: "secret-branch",
		}),
		YAOS_SYNC: {},
	} as any;

	const publicRes = await worker.fetch(new Request("https://example.test/api/capabilities"), env);
	const publicCaps = await publicRes.json() as Record<string, unknown>;
	assert(publicRes.status === 200, "public capabilities route returns 200");
	assert(publicCaps.updateProvider === null, "public capabilities route hides update provider");
	assert(publicCaps.updateRepoUrl === null, "public capabilities route hides update repo URL");
	assert(publicCaps.updateRepoBranch === null, "public capabilities route hides update repo branch");

	const wrongTokenRes = await worker.fetch(new Request("https://example.test/api/capabilities", {
		headers: { Authorization: "Bearer wrong-token" },
	}), env);
	const wrongTokenCaps = await wrongTokenRes.json() as Record<string, unknown>;
	assert(wrongTokenRes.status === 200, "wrong-token capabilities route returns public 200");
	assert(wrongTokenCaps.updateRepoUrl === null, "wrong-token capabilities route still hides update repo URL");

	const privateRes = await worker.fetch(new Request("https://example.test/api/capabilities", {
		headers: { Authorization: `Bearer ${token}` },
	}), env);
	const privateCaps = await privateRes.json() as Record<string, unknown>;
	assert(privateRes.status === 200, "authenticated capabilities route returns 200");
	assert(privateCaps.updateProvider === "github", "authenticated capabilities route includes update provider");
	assert(privateCaps.updateRepoUrl === "https://github.com/private/fork", "authenticated capabilities route includes update repo URL");
	assert(privateCaps.updateRepoBranch === "secret-branch", "authenticated capabilities route includes update repo branch");
	assert(privateCaps.maxBlobUploadBytes === MAX_BLOB_UPLOAD_BYTES, "capabilities route exposes max blob upload bytes");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
