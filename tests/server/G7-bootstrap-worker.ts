import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { suite } from "../harness";

const require = createRequire(join(process.cwd(), "server/package.json"));
const { Miniflare } = require("miniflare") as typeof import("../../server/node_modules/miniflare");
const tests = suite("G7-bootstrap-worker");
tests.test("concurrent bootstrap contract on Workers SQLite and pinned Worker Wasm", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-g7-worker-"));
	let runtime: InstanceType<typeof Miniflare> | undefined;
	const baseline = process.env.G7_BASELINE === "1";
	try {
		await build({
			stdin: { contents: `
import { bootstrapContract } from "./tests/fixtures/G7-bootstrap-contract.ts";
${baseline ? "" : `
import { bootstrapRoutesContract } from "./tests/fixtures/G7-bootstrap-routes-contract.ts";
import { VaultRuntime } from "./server/src/server.ts";
`}
export class G7Contract {
  constructor(state) { this.state = state; }
  async fetch(request) {
    try { return Response.json(await ${baseline ? "bootstrapContract(this.state.storage)" : `(new URL(request.url).pathname === "/routes"
      ? bootstrapRoutesContract(this.state.storage, VaultRuntime) : bootstrapContract(this.state.storage))`}); }
    catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  }
}
export default { fetch(request, env) { return env.G7.get(env.G7.idFromName(new URL(request.url).pathname)).fetch(request); } };
`, resolveDir: process.cwd(), sourcefile: "G7-worker.ts", loader: "ts" },
			outfile: join(directory, "worker.mjs"), bundle: true, format: "esm", platform: "browser", target: "es2022",
			alias: { yjs: join(process.cwd(), "node_modules/yjs/dist/yjs.mjs") },
			loader: { ".wasm": "copy" }, external: ["cloudflare:workers"], logLevel: "silent",
			plugins: baseline ? [{ name: "g7-baseline", setup(builder: import("esbuild").PluginBuild) {
				builder.onLoad({ filter: /server\/src\/(bootstrap|vaultBootstrapStore)\.ts$/ }, async ({ path }) => ({
					contents: execFileSync("git", ["show", `8c74c06ff0348aae448258c140836625d89e6d86:${path.slice(process.cwd().length + 1)}`], { encoding: "utf8" }), loader: "ts",
				}));
			} }] : [],
		});
		runtime = new Miniflare({ modules: true, scriptPath: join(directory, "worker.mjs"), modulesRoot: directory,
			modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }], compatibilityDate: "2026-03-02",
			durableObjects: { G7: { className: "G7Contract", useSQLite: true } }, durableObjectsPersist: join(directory, "state"),
		});
		const response = await runtime.dispatchFetch("http://g7.invalid/contract");
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		assert.ok(Array.isArray(result) && result.length === 6);
		for (const entry of result) console.log(`PASS ${entry}`);
		if (!baseline) {
			const routes = await runtime.dispatchFetch("http://g7.invalid/routes");
			const routeResults = await routes.json();
			assert.equal(routes.status, 200, JSON.stringify(routeResults));
			assert.ok(Array.isArray(routeResults) && routeResults.length === 2);
			for (const entry of routeResults) console.log(`PASS ${entry}`);
		}
	} finally {
		await runtime?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
await tests.done();
