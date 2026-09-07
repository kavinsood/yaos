/**
 * Combined entry point for the existing storage-v3 validation Worker.
 * Production-shaped routes continue to use the normal Worker; only the
 * secret-gated benchmark prefix is intercepted by the isolated harness.
 */
import productionWorker, {
	RecoveryJob,
	ServerConfig,
	VaultSyncServer,
} from "../../server/src/index";
import benchmarkWorker, {
	authorizeBenchmarkRequest,
	benchmarkJson,
	type BenchmarkEnvironment,
	StorageBenchmarkRun,
} from "../../server/src/storageBenchmarkWorker";
import { runRecoveryPageSizingValidation } from "./recovery-page-sizing-harness";

interface CombinedEnvironment extends BenchmarkEnvironment {
	YAOS_SYNC: DurableObjectNamespace;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_RECOVERY_JOBS?: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
	YAOS_TICKET_TTL_MS?: string;
	YAOS_ENABLE_ADMIN_ROUTES?: string;
}

const worker = {
	async fetch(request: Request, env: CombinedEnvironment): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (request.method === "POST" && pathname === "/__yaos/benchmark/recovery-page-sizing") {
			const rejection = authorizeBenchmarkRequest(request, env);
			if (rejection) return rejection;
			try {
				const input = await request.json() as { pageSizes?: unknown };
				if (input.pageSizes !== undefined && !Array.isArray(input.pageSizes)) throw new Error("pageSizes must be an array");
				const pageSizes = input.pageSizes as number[] | undefined;
				return benchmarkJson(await runRecoveryPageSizingValidation({ pageSizes }));
			} catch (error) {
				return benchmarkJson({ error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}
		if (pathname.startsWith("/__yaos/benchmark/")) {
			return benchmarkWorker.fetch(request, env);
		}
		return productionWorker.fetch(request, env);
	},
};

export {
	RecoveryJob,
	ServerConfig,
	StorageBenchmarkRun,
	VaultSyncServer,
};

// Preserve every class name in the existing validation Worker's migration
// lineage. Wrangler requires previously-created classes to remain exported.
export {
	VaultSyncServer as VaultSyncServerStorage3Validation,
	ServerConfig as ServerConfigStorage3Validation,
	RecoveryJob as RecoveryJobStorage3Validation,
};
export {
	VaultSyncServer as VaultSyncServerStorage3Stress2,
	ServerConfig as ServerConfigStorage3Stress2,
	RecoveryJob as RecoveryJobStorage3Stress2,
};
export {
	VaultSyncServer as VaultSyncServerStorage3Stress3,
	ServerConfig as ServerConfigStorage3Stress3,
	RecoveryJob as RecoveryJobStorage3Stress3,
};
export {
	VaultSyncServer as VaultSyncServerStorage3Stress4,
	ServerConfig as ServerConfigStorage3Stress4,
	RecoveryJob as RecoveryJobStorage3Stress4,
};
export {
	VaultSyncServer as VaultSyncServerStorage3Stress5,
	ServerConfig as ServerConfigStorage3Stress5,
	RecoveryJob as RecoveryJobStorage3Stress5,
};

export default worker;
