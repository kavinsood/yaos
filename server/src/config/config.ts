// The config Durable Object: the singleton `idFromName("config")` (DECISIONS §2.1). P2 adds claim, login, sessions,
// the vault registry and the restore journal; P1 answers `isClaimed` for pre-claim /api/capabilities.
import { DurableObject } from "cloudflare:workers";
import { ConfigHost } from "./host";

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
}
