// The config Durable Object: the singleton `idFromName("config")` (DECISIONS §2.1): claim, login, sessions, the vault
// registry and the restore journal. Only /claim, /operator/* and pre-claim /api/capabilities reach it.
import { DurableObject } from "cloudflare:workers";
import { SYSTEM_CLOCK } from "../ports";
import type { VaultDO } from "../vault/vault";
import { ConfigHost, type ConfigResult, type FrozenAction, type OperatorState, type VaultEntry } from "./host";
import type { RestoreResult } from "./restore";

/** The singleton's name; the Worker reaches it as `YAOS_CONFIG.get(YAOS_CONFIG.idFromName(CONFIG_OBJECT_NAME))`. */
export const CONFIG_OBJECT_NAME = "config";

/** The D8b runner calls the vault DOs (cold path only; the vault DO never calls back). */
export interface ConfigEnv {
	YAOS_VAULT: DurableObjectNamespace<VaultDO>;
}

export class ConfigDO extends DurableObject<ConfigEnv> {
	private readonly host: ConfigHost;

	constructor(ctx: DurableObjectState, env: ConfigEnv) {
		super(ctx, env);
		this.host = new ConfigHost(ctx.storage, SYSTEM_CLOCK, {
			// A new stub per call: after the rewind's ctx.abort() the stub that made the call stays broken.
			vault: (vaultId) => env.YAOS_VAULT.get(env.YAOS_VAULT.idFromName(vaultId)),
			alarms: ctx.storage,
		});
	}

	/** Alarm: D8b resumes every restore journal row and re-arms while any is left. */
	async alarm(): Promise<void> {
		await this.host.alarm();
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

	/** RPC: D8b restore, after `authorize(token, vaultId)`. */
	restore(vaultId: string, at: unknown): Promise<RestoreResult> {
		return this.host.restore(vaultId, at);
	}

	beginDeleteVault(vaultId: string): { ok: true } {
		return this.host.beginDeleteVault(vaultId);
	}

	unregisterVault(vaultId: string): { ok: true } {
		return this.host.unregisterVault(vaultId);
	}
}
