/**
 * Production engine entry (worker and inline fallback): createEngine over the
 * web adapters. The only engine module the host imports (inline carrier);
 * workerMain.ts runs the same function inside the Blob-URL worker.
 *
 *  - storage: IndexedDB (an open failure answers init `storage-lost`, the host
 *    falls back to the inline carrier, OR-1);
 *  - relay: WebSocket streams + HTTP tickets; blobs: HTTP blob store when the
 *    relay advertises attachments. Capabilities unreachable (offline start):
 *    assume the blob store and let the blob queue retry, so refs never depend
 *    on whether the device happened to be online at startup;
 *  - crypto: suite 0 (identity, DESIGN §a); hash, random, clock: WebCrypto /
 *    setTimeout;
 *  - local time zone for conflict-copy names (the core never reads Date).
 */

import type { EngineTransport } from "../../protocol/transport";
import { createEngine, type EngineHandle } from "../compose/protocolEngine";
import { createHttpBlob, probeHttpBlob } from "./httpBlob";
import { createIdbStoragePort } from "./idbStorage";
import { createNoopCrypto } from "./noopCrypto";
import { createWebClock } from "./webClock";
import { createWebHash } from "./webHash";
import { createWebRandom } from "./webRandom";
import { createWsRelayPort } from "./wsRelay";

export interface WebEngineOptions {
	readonly clientVersion?: string;
	readonly log?: (line: string) => void;
}

export function createWebEngine(transport: EngineTransport, carrier: "worker" | "inline", o: WebEngineOptions = {}): EngineHandle {
	return createEngine(transport, {
		carrier,
		clientVersion: o.clientVersion ?? "dev",
		log: o.log,
		tzOffsetMinutes: () => -new Date().getTimezoneOffset(),
		makePorts: async (config) => {
			const clock = createWebClock();
			const hash = createWebHash();
			const random = createWebRandom();
			const storage = createIdbStoragePort();
			const relay = createWsRelayPort({ baseUrl: config.relay.url, credential: config.relay.credential, clock, random });
			const blobOpts = { baseUrl: config.relay.url, vaultId: config.vaultId, credential: config.relay.credential };
			const blob = await probeHttpBlob(blobOpts).catch(() => createHttpBlob(blobOpts));
			return { relay, storage, clock, random, crypto: createNoopCrypto(hash), hash, blob };
		},
	});
}
