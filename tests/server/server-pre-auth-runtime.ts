import { rejectUnauthorizedVaultRequest } from "../../server/src/routes/auth";
import { createTicket } from "../../server/src/routes/ticket";
import { handleSyncSocketRoute } from "../../server/src/routes/syncSocket";
import type { AuthState, Env } from "../../server/src/routes/types";
import { makeConfigNamespace, makeEnv, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("server-pre-auth-runtime");
const touched = "Durable Object accessed before authentication";
const env: Env = makeEnv({
	YAOS_SYNC: makeTrapNamespace(touched),
	YAOS_CONFIG: makeTrapNamespace(touched),
});
const unclaimed: AuthState = { mode: "unclaimed", claimed: false };
const unsupported: AuthState = { mode: "unsupported", claimed: true };
const claimed: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "operator-hash",
	ticketSigningKey: "ticket-signing-key",
};

s.section("unclaimed and old-format configs fail before room access");
{
	const request = new Request("https://example.test/vault/test-vault/debug/recent");
	const unclaimedResult = await rejectUnauthorizedVaultRequest(request, env, unclaimed, "test-vault");
	s.check(unclaimedResult?.reason === "unclaimed" && unclaimedResult.response.status === 503, "unclaimed server is explicit");
	const unsupportedResult = await rejectUnauthorizedVaultRequest(request, env, unsupported, "test-vault");
	s.check(unsupportedResult?.reason === "server_format_unsupported", "old config format is explicit");
	s.check(unsupportedResult?.response.status === 503, "old config format cannot authenticate");
}

s.section("device bearer rejection may touch config but never room");
{
	const configTrap = makeTrapNamespace("config authorization attempted");
	const syncTrap = makeTrapNamespace("room should not be touched");
	const authEnv: Env = makeEnv({ YAOS_CONFIG: configTrap, YAOS_SYNC: syncTrap });
	let rejected = false;
	try {
		await rejectUnauthorizedVaultRequest(
			new Request("https://example.test/vault/test-vault/debug/recent", { headers: { Authorization: "Bearer wrong" } }),
			authEnv,
			claimed,
			"test-vault",
		);
	} catch {
		rejected = true;
	}
	s.check(rejected && configTrap.touched.length > 0, "authorization consults config membership");
	s.check(syncTrap.touched.length === 0, "unauthorized request never reaches room namespace");
}

s.section("socket without ticket fails before any Durable Object");
{
	const response = await handleSyncSocketRoute(
		new Request("https://example.test/vault/sync/test-vault?schemaVersion=3"),
		env,
		claimed,
		"test-vault",
	);
	s.check(response.status === 401, "missing ticket is unauthorized");
}
s.section("invalid schema logs only bounded metadata, never the raw query");
{
	const { ticket } = await createTicket(claimed, "test-vault", "device-1");
	const schemaMarker = "schema-secret-marker-";
	const rawSchema = schemaMarker + "x".repeat(20_000);
	const schemaEnv = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})),
		YAOS_SYNC: makeTrapNamespace("invalid schema must not reach room"),
	});
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => {
		warnings.push(values.map(String).join(" "));
	};
	let response: Response | null = null;
	try {
		response = await handleSyncSocketRoute(
			new Request(
				`https://example.test/vault/sync/test-vault?ticket=${encodeURIComponent(ticket)}&schemaVersion=${rawSchema}`,
			),
			schemaEnv,
			claimed,
			"test-vault",
		);
	} finally {
		console.warn = originalWarn;
	}
	const logged = warnings.join("\n");
	s.check(response?.status === 426, "invalid schema is rejected");
	s.check(!logged.includes(schemaMarker), "schema query content does not appear in logs");
	s.check(logged.includes('"length":256') && logged.includes('"lengthCapped":true'), "log contains bounded length metadata");
	s.check(logged.includes('"classification":"other"'), "log contains schema classification");
}


await s.done();
