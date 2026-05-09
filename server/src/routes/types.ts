import type { VaultSyncServer } from "../server";

export interface Env {
	SYNC_TOKEN?: string;
	YAOS_CANONICAL_REPO?: string;
	YAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
}

export type JsonResponse = (body: unknown, status?: number) => Response;

export type AuthState =
	| { mode: "env"; claimed: true; envToken: string }
	| { mode: "claim"; claimed: true; tokenHash: string }
	| { mode: "unclaimed"; claimed: false };

export type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

export type UpdateProvider = "github" | "gitlab" | "unknown";
