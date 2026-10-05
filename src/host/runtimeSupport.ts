/**
 * Host runtime helpers: device class (§i.2), init config (§g.2), observation
 * chunking, vault-event batching (§g.3).
 */

import type { DeviceClass } from "../core/limits";
import type { DeviceId, VaultId } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { PlatformInfo } from "../ports/platform";
import type { SideFileName, SideFilePort, VaultEvent, VaultStat } from "../ports/vault";
import type { EngineInitConfig, EngineSettings, LocalObservation } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import { owned } from "../protocol/workerTransport";

export const OBSERVATION_CHUNK = 2_000;
export const VAULT_EVENT_BATCH_MS = 50;
export const VAULT_EVENT_BATCH_MAX = 256;

/** §i.2. Inline runs one class lower (phone/tablet inline => constrained). */
export function deviceClassFor(info: PlatformInfo, carrier: "worker" | "inline"): DeviceClass {
	let cls: DeviceClass;
	if (!info.isMobile) cls = "desktop";
	else if ((info.deviceMemoryGiB !== null && info.deviceMemoryGiB < 3) || info.hardwareConcurrency <= 2) cls = "constrained";
	else cls = info.isTablet ? "tablet" : "phone";
	if (carrier === "inline") {
		if (cls === "desktop") return "tablet";
		return "constrained";
	}
	return cls;
}

export interface HostIdentity {
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	readonly deviceLabel: string;
	/** SECRET credential inside: never log this object. */
	readonly relay: { readonly url: string; readonly credential: string };
}

const SIDE_A_B: { outbox: [SideFileName, SideFileName]; synced: [SideFileName, SideFileName] } = {
	outbox: ["outbox-a.bin", "outbox-b.bin"],
	synced: ["synced-a.bin", "synced-b.bin"],
};

async function readSide(side: SideFilePort, name: SideFileName): Promise<Uint8Array | null> {
	try {
		const b = await side.read(name);
		return b ? owned(b.slice()) : null;
	} catch {
		return null;
	}
}

export async function buildInitConfig(input: {
	readonly identity: HostIdentity;
	readonly platform: PlatformInfo;
	readonly carrier: "worker" | "inline";
	readonly workerSupported: boolean;
	readonly configDir: string;
	readonly caseInsensitiveFs: boolean;
	readonly settings: EngineSettings;
	readonly side: SideFilePort;
}): Promise<EngineInitConfig> {
	const [oa, ob, sa, sb] = await Promise.all([
		readSide(input.side, SIDE_A_B.outbox[0]),
		readSide(input.side, SIDE_A_B.outbox[1]),
		readSide(input.side, SIDE_A_B.synced[0]),
		readSide(input.side, SIDE_A_B.synced[1]),
	]);
	const platform: PlatformInfo = { ...input.platform, workerSupported: input.workerSupported };
	return {
		protocolVersion: PROTOCOL_VERSION,
		vaultId: input.identity.vaultId,
		deviceId: input.identity.deviceId,
		deviceLabel: input.identity.deviceLabel,
		deviceClass: deviceClassFor(platform, input.carrier),
		platform,
		configDir: input.configDir,
		caseInsensitiveFs: input.caseInsensitiveFs,
		relay: { url: input.identity.relay.url, credential: input.identity.relay.credential },
		settings: input.settings,
		sideState: { outboxMirror: [oa, ob], syncedMirror: [sa, sb] },
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
