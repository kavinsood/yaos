/**
 * Host runtime helpers: device class (§i.2), init config (§g.2), observation
 * chunking, vault-event batching (§g.3).
 */

import type { DeviceClass } from "../core/limits";
import type { VaultId } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { PlatformInfo } from "../ports/platform";
import type { VaultEvent, VaultStat } from "../ports/vault";
import type { EngineInitConfig, EngineSettings, LocalObservation } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";

export const OBSERVATION_CHUNK = 2_000;
export const VAULT_EVENT_BATCH_MS = 50;
export const VAULT_EVENT_BATCH_MAX = 256;

/** §i.2. */
export function deviceClassFor(info: PlatformInfo): DeviceClass {
	if (!info.isMobile) return "desktop";
	if ((info.deviceMemoryGiB !== null && info.deviceMemoryGiB < 3) || info.hardwareConcurrency <= 2) return "constrained";
	return info.isTablet ? "tablet" : "phone";
}

export interface HostIdentity {
	readonly vaultId: VaultId;
	readonly deviceLabel: string;
	/**
	 * The relay and the install's pairing grant (identity-per-store §3). SECRET (grantSecret): never log this object.
	 * The device identity is the store's (the engine finds or mints it, §4).
	 */
	readonly relay: { readonly url: string; readonly grantSecret: string };
	/** This install's key (identity-per-store §2.4; installRecord.ts). */
	readonly installKey: string;
	/** The install record's earlier stores (installRecord.ts lineageOf): EngineInitConfig.lineage. */
	readonly lineage?: readonly string[];
}

export function buildInitConfig(input: {
	readonly identity: HostIdentity;
	readonly platform: PlatformInfo;
	readonly configDir: string;
	readonly caseInsensitiveFs: boolean;
	readonly settings: EngineSettings;
	/** SECRET when suite 1: moved into the config as is (transferred by the carrier, §6.3). */
	readonly crypto: EngineInitConfig["crypto"];
}): EngineInitConfig {
	return {
		protocolVersion: PROTOCOL_VERSION,
		vaultId: input.identity.vaultId,
		deviceLabel: input.identity.deviceLabel,
		deviceClass: deviceClassFor(input.platform),
		platform: input.platform,
		configDir: input.configDir,
		caseInsensitiveFs: input.caseInsensitiveFs,
		relay: { url: input.identity.relay.url, grantSecret: input.identity.relay.grantSecret },
		installKey: input.identity.installKey,
		lineage: input.identity.lineage ?? [],
		settings: input.settings,
		crypto: input.crypto,
	};
}

/** Listing -> observation chunks (<= 2000 each); always at least one (possibly empty, complete) chunk. */
export function observationChunks(stats: readonly VaultStat[]): LocalObservation[][] {
	const out: LocalObservation[][] = [];
	for (let i = 0; i < stats.length; i += OBSERVATION_CHUNK) out.push(stats.slice(i, i + OBSERVATION_CHUNK).map((stat) => ({ stat })));
	if (out.length === 0) out.push([]);
	return out;
}

/** Batches vault events: flush after 50 ms or at 256 events, or on demand (lifecycle). */
export class VaultEventBatcher {
	private buf: VaultEvent[] = [];
	private timer: TimerHandle | null = null;

	constructor(
		private readonly clock: ClockPort,
		private readonly sink: (events: readonly VaultEvent[]) => void,
	) {}

	push(event: VaultEvent): void {
		this.buf.push(event);
		if (this.buf.length >= VAULT_EVENT_BATCH_MAX) {
			this.flush();
			return;
		}
		if (this.timer === null) {
			this.timer = this.clock.setTimer(VAULT_EVENT_BATCH_MS, () => {
				this.timer = null;
				this.flush();
			});
		}
	}

	flush(): void {
		if (this.timer !== null) {
			this.clock.clearTimer(this.timer);
			this.timer = null;
		}
		if (this.buf.length === 0) return;
		const events = this.buf;
		this.buf = [];
		this.sink(events);
	}

	get size(): number {
		return this.buf.length;
	}

	dispose(): void {
		if (this.timer !== null) this.clock.clearTimer(this.timer);
		this.timer = null;
		this.buf = [];
	}
}
