import type { StoredServerConfig } from "../config";
import type { ActorCallPort, ObjectStorePort, SocketUpgradePort } from "../platformPorts";


export interface Env {
	YAOS_SYNC: ActorCallPort;
	YAOS_CONFIG: ActorCallPort;
	YAOS_RECOVERY_JOBS?: ActorCallPort;
	YAOS_BUCKET?: ObjectStorePort;
	socketUpgrades: SocketUpgradePort;
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
