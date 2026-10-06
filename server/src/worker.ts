// Worker entry module (wrangler.toml `main`). It exports only what workerd loads: the fetch handler and the two
// Durable Object classes. workerd reads every named export of the main module as an entrypoint, and a constant there
// stops the runtime at startup ("Incorrect type for map entry ...: the provided value is not of type 'function or
// ExportedHandler'", wrangler 4.147.0), so the route table and its constants live in router.ts.
import { ConfigDO } from "./config/config";
import { Router, type WorkerEnv } from "./router";
import { CLOUDFLARE_UPGRADE_REJECT } from "./vault/cloudflare";
import { VaultDO } from "./vault/vault";

export { ConfigDO, VaultDO };
export type { WorkerEnv };

const router = new Router({ upgrades: CLOUDFLARE_UPGRADE_REJECT });

export default {
	fetch(request: Request, env: WorkerEnv): Promise<Response> {
		return router.fetch(request, env);
	},
} satisfies ExportedHandler<WorkerEnv>;
