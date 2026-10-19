/**
 * The engine's port bundle. DESIGN §h. Everything outside src/host and the
 * production adapters talks to the world only through ports.
 */

import type { ClockPort } from "./clock";
import type { RandomPort } from "./random";
import type { CryptoPort, HashPort } from "./crypto";
import type { BlobPort } from "./blob";
import type { RelayPort } from "./relay";
import type { StoragePort } from "./storage";

/** Ports the engine (in the worker; in-process in tests and the sim) is constructed with. No vault access: that goes over the protocol. */
export interface EnginePorts {
	readonly relay: RelayPort;
	readonly storage: StoragePort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	/**
	 * null = no blob store (the relay's capabilities say no attachments): attachments and oversize body updates
	 * do not sync (fail closed, DESIGN §j.1). Blobs never ride the relay's sequence log.
	 */
	readonly blob: BlobPort | null;
	/**
	 * Asks the relay again whether it has a blob store (capabilities). Without one, the engine calls this once per
	 * session that reaches live; a store found restarts the runtime with it. Absent = never re-asked.
	 */
	readonly probeBlob?: () => Promise<BlobPort | null>;
}

