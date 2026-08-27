import type { StoredServerConfig } from "../config";
import type { RecoveryJobNamespacePort } from "../recoveryExecutor";
export interface VaultRuntimeStubPort {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface VaultSyncNamespacePort {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): VaultRuntimeStubPort;
}


export interface Env {
	YAOS_SYNC: VaultSyncNamespacePort;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_RECOVERY_JOBS?: RecoveryJobNamespacePort;
	YAOS_BUCKET?: R2Bucket;
	YAOS_TICKET_TTL_MS?: string;
	YAOS_ENABLE_ADMIN_ROUTES?: string;
}

export type JsonResponse = (body: unknown, status?: number) => Response;

export type AuthState =
	| {
		mode: "claim";
		claimed: true;
		operatorRecoveryHash: string;
		ticketSigningKey: string;
		config?: StoredServerConfig;
	}
	| { mode: "unclaimed"; claimed: false; config?: StoredServerConfig }
	| { mode: "unsupported"; claimed: true; config?: StoredServerConfig };

export type AuthStateCached =
	| {
		mode: "claim";
		claimed: true;
		operatorRecoveryHash: string;
		ticketSigningKey: string;
		config: StoredServerConfig;
	}
	| { mode: "unclaimed"; claimed: false; config: StoredServerConfig }
	| { mode: "unsupported"; claimed: true; config: StoredServerConfig };

export type FatalAuthCode =
	| "unauthorized"
	| "server_misconfigured"
	| "server_format_unsupported"
	| "unclaimed"
	| "update_required";

export type UpdateProvider = "github" | "gitlab" | "unknown";
