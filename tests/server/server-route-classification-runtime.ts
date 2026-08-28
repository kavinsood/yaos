import { strict as assert } from "node:assert";
import { classifyWorkerRoute, handleWorkerRequest } from "../../server/src/index";
import type { Env } from "../../server/src/routes/types";
import { makeEnv, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("server-route-classification-runtime");
const DO_TOUCHED = "unknown route allocated a Durable Object";
const configTrap = makeTrapNamespace(DO_TOUCHED);
const syncTrap = makeTrapNamespace(DO_TOUCHED);
const trapEnv: Env = makeEnv({ YAOS_CONFIG: configTrap, YAOS_SYNC: syncTrap });

s.test("junk, legacy sync, and malformed vault routes return 404 before any DO", async () => {
	const routes: Array<[string, string]> = [
		["GET", "/wp-login.php"],
		["GET", "/.env"],
		["GET", "/vault/vault-route-0001"],
		["GET", "/vault/vault-route-0001/random"],
		["GET", "/vault/sync/vault-route-0001"],
		["POST", "/vault/vault-route-0001/bootstrap/attempt/unknown"],
		["GET", "/vault/%20vault-route-0001%20/status"],
		["GET", "/vault/%76ault-route-0001/status"],
		["GET", "/vault/vault-route-0001/settings-sync"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian"],
		["POST", "/vault/vault-route-0001/settings-sync/.obsidian/seed"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/unknown"],
		["GET", "/vault/vault-route-0001/settings-sync/.obsidian/seed"],
	];
	for (const [method, path] of routes) {
		const response = await handleWorkerRequest(new Request(`https://example.test${path}`, { method }), trapEnv);
		assert.equal(response.status, 404, `${method} ${path}`);
	}
	assert.deepEqual(configTrap.touched, []);
	assert.deepEqual(syncTrap.touched, []);
});

s.test("schema-4 root/body, candidate, lifecycle, and bootstrap shapes classify honestly", () => {
	const accepted: Array<[string, string]> = [
		["GET", "/vault/vault-route-0001/ws/root"],
		["GET", "/vault/vault-route-0001/ws/body/body-route-0001"],
		["POST", "/vault/vault-route-0001/body/body-route-0001/candidate"],
		["POST", "/vault/vault-route-0001/lifecycle"],
		["POST", "/vault/vault-route-0001/lifecycle/batch"],
		["POST", "/vault/vault-route-0001/lifecycle/publish"],
		["POST", "/vault/vault-route-0001/attachments/publish"],
		["POST", "/vault/vault-route-0001/bootstrap/start"],
		["GET", "/vault/vault-route-0001/bootstrap/bootstrap-route-0001/root"],
		["POST", "/vault/vault-route-0001/bootstrap/bootstrap-route-0001/bodies"],
		["GET", "/vault/vault-route-0001/bootstrap/bootstrap-route-0001/body/body-route-0001"],
		["GET", "/vault/vault-route-0001/settings-sync/.obsidian"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/seed"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/replace"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/file"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/intent"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/tombstone"],
		["PUT", "/vault/vault-route-0001/settings-sync/.obsidian/plugin-data"],
		["DELETE", "/vault/vault-route-0001/settings-sync/.obsidian/file"],
	];
	for (const [method, path] of accepted) {
		assert.equal(classifyWorkerRoute(new Request(`https://example.test${path}`, { method })).kind, "vault", `${method} ${path}`);
	}
	assert.equal(
		classifyWorkerRoute(new Request("https://example.test/operator/vaults/vault-route-0001/provision", { method: "POST" })).kind,
		"operator-vault-provision",
	);
	for (const [method, path] of [
		["GET", "/vault/vault-route-0001/ws/body"],
		["GET", "/vault/vault-route-0001/bootstrap/bootstrap-route-0001/unknown"],
		["POST", "/vault/vault-route-0001/provision"],
		["DELETE", "/vault/vault-route-0001/body/body-route-0001/candidate"],
	] as Array<[string, string]>) {
		assert.equal(classifyWorkerRoute(new Request(`https://example.test${path}`, { method })).kind, "not-found", `${method} ${path}`);
	}
});

await s.done();
