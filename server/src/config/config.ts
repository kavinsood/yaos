// The config Durable Object: the singleton `idFromName("config")` (DECISIONS §2.1): claim, login, sessions, the vault
// registry and the restore journal. Only /claim, /operator/* and pre-claim /api/capabilities reach it.
import { DurableObject } from "cloudflare:workers";
import { ConfigHost, type ConfigResult, type FrozenAction, type OperatorState, type VaultEntry } from "./host";

/** The singleton's name; the Worker reaches it as `YAOS_CONFIG.get(YAOS_CONFIG.idFromName(CONFIG_OBJECT_NAME))`. */
export const CONFIG_OBJECT_NAME = "config";

export class ConfigDO extends DurableObject<unknown> {
	private readonly host: ConfigHost;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.host = new ConfigHost(ctx.storage);
	}

	/** RPC: whether the server is claimed. The Worker caches `true` forever (D2). */
	isClaimed(): boolean {
		return this.host.isClaimed();
	}

	claim(recoveryKey: string, vaultId: string, vaultName: string): Promise<ConfigResult<{ sessionToken: string }>> {
		return this.host.claim(recoveryKey, vaultId, vaultName);
	}

	login(recoveryKey: string): Promise<ConfigResult<{ sessionToken: string }>> {
		return this.host.login(recoveryKey);
	}

	logout(sessionToken: string): Promise<{ ok: true }> {
		return this.host.logout(sessionToken);
	}

	authorize(sessionToken: string, vaultId?: string, action?: FrozenAction): Promise<ConfigResult> {
		return this.host.authorize(sessionToken, vaultId, action);
	}

	state(sessionToken: string): Promise<ConfigResult<OperatorState>> {
		return this.host.state(sessionToken);
	}

	registerVault(vaultId: string, name: string): ConfigResult<{ vault: VaultEntry }> {
		return this.host.registerVault(vaultId, name);
	}

	beginDeleteVault(vaultId: string): { ok: true } {
		return this.host.beginDeleteVault(vaultId);
	}

	unregisterVault(vaultId: string): { ok: true } {
		return this.host.unregisterVault(vaultId);
	}
}
