/**
 * b3-clientblob A4: a note created while the D8 daily limit is active must be
 * created once the limit clears (exactly once), not an hour later.
 *
 * Deployed DLI: the real client's commitFreshBody hit a 503 cf_daily_limit,
 * the create stayed durably pending (correct), and the client parked every
 * submission for min(resetAt, now + 1 h). The limit cleared 5 min later but the
 * note only reached the server after the hourly probe.
 */
import { strict as assert } from "node:assert";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../legacy-src/shared/binaryEnvelope";
import { dailyLimitResponse } from "../../server/src/dailyLimit";
import {
	DAILY_LIMIT_FIRST_PROBE_MS,
	DAILY_LIMIT_MAX_BACKOFF_MS,
	dailyLimitBackoffUntil,
	dailyLimitProbeIntervalMs,
} from "../../legacy-src/sync/dailyLimit";
import { FreshAdmissionDurablyPendingError, VaultSync, type BulkCreateRequest } from "../../legacy-src/sync/vaultSync";
import type { HttpRequest, HttpResponse } from "../../legacy-src/utils/http";
import { suite, until } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault, testProvider } from "./helpers/fakeBulkCreateServer.ts";

installDomCrypto();
const s = suite("daily-limit-create-replay");

async function limitedResponse(): Promise<HttpResponse> {
	const response = dailyLimitResponse(Date.now());
	const text = await response.text();
	return { status: response.status, headers: {}, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
		text, get json() { return JSON.parse(text); } };
}

function fixture(probeBaseMs?: number) {
	const server = new FakeBulkCreateServer();
	const state = { limited: true, limitedAnswers: 0, okCreates: 0 };
	const request = async (input: HttpRequest): Promise<HttpResponse> => {
		if (!input.url.endsWith("/lifecycle/create-bulk")) throw new Error(`unexpected request: ${input.url}`);
		if (state.limited) { state.limitedAnswers++; return limitedResponse(); }
		const decoded = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as BulkCreateRequest;
		const reply = await server.commitCreateBulk(decoded);
		state.okCreates += decoded.files.length;
		return { status: 200, headers: {}, arrayBuffer: encodeBinaryEnvelope(reply).slice().buffer, json: null, text: "" };
	};
	const vault = memoryVault();
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database, request, providerFactory: testProvider,
		...(probeBaseMs === undefined ? {} : { dailyLimitProbeBaseMs: probeBaseMs }),
	} as ConstructorParameters<typeof VaultSync>[0]);
	return { server, state, vault, runtime };
}

s.test("A4: a note created while limited is created once the limit clears, exactly once", async () => {
	const { server, state, vault, runtime } = fixture(200);
	try {
		await assert.rejects(
			runtime.commitFreshBody({ bodyId: "body-rc", path: "rc-note.md", content: "# limited\n",
				candidateId: "candidate-rc", reason: "dli" }),
			(error: unknown) => error instanceof FreshAdmissionDurablyPendingError,
		);
		assert.ok(runtime.getDailyLimitState(), "the 503 trips D8");
		assert.equal(vault.lifecycle.size, 1, "the create is durably pending");
		assert.equal(runtime.getFileId("rc-note.md"), undefined);
		// Still limited: probes back off (200, 400, 800 ms ...), no retry loop.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.ok(state.limitedAnswers >= 2 && state.limitedAnswers <= 5, `probes while limited: ${state.limitedAnswers}`);
		assert.equal(runtime.getFileId("rc-note.md"), undefined);
		state.limited = false;
		await until(() => runtime.getFileId("rc-note.md") === "body-rc",
			{ timeoutMs: 5_000, message: "the pending create replays after the limit clears" });
		await until(() => vault.lifecycle.size === 0, { timeoutMs: 2_000, message: "no create left to replay" });
		assert.equal(state.okCreates, 1, "exactly one create reached the server");
		assert.equal(server.bodyText("body-rc"), "# limited\n");
		assert.equal(runtime.getDailyLimitState(), null, "a successful write clears the D8 state");
	} finally {
		await runtime.destroy();
	}
});

s.test("probe schedule doubles from the first probe to hourly and never passes the reset", () => {
	const now = Date.UTC(2026, 9, 2, 12, 0);
	const info = { resetAt: Date.UTC(2026, 9, 3), kind: "rows-written" };
	const steps = [0, 1, 2, 3, 4, 5, 6, 50].map((index) => (dailyLimitBackoffUntil(info, now, index) - now) / 60_000);
	assert.deepEqual(steps, [2, 4, 8, 16, 32, 60, 60, 60]);
	assert.equal(dailyLimitProbeIntervalMs(0), DAILY_LIMIT_FIRST_PROBE_MS);
	assert.equal(dailyLimitBackoffUntil({ ...info, resetAt: now + 30_000 }, now, 0), now + 30_000);
	assert.equal(dailyLimitBackoffUntil(info, now) - now, DAILY_LIMIT_MAX_BACKOFF_MS, "no index = hourly (unchanged API)");
});

s.test("concurrent 503s in one probe round do not escalate the back-off", () => {
	let clock = Date.UTC(2026, 9, 2, 12, 0);
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: memoryVault().database, providerFactory: testProvider,
		now: () => clock,
	});
	const info = { resetAt: Date.UTC(2026, 9, 3), kind: "rows-written" };
	const paused = () => (runtime as unknown as { dailyLimitPausedUntil: number }).dailyLimitPausedUntil - clock;
	for (let index = 0; index < 5; index++) runtime.tripDailyLimit(info);
	assert.equal(paused(), 2 * 60_000);
	clock += 2 * 60_000;
	runtime.tripDailyLimit(info);
	runtime.tripDailyLimit(info);
	assert.equal(paused(), 4 * 60_000);
	void runtime.destroy();
});

await s.done();
