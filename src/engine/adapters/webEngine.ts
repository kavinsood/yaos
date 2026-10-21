/**
 * Production engine: createEngine over the web adapters, run by workerMain.ts
 * inside the Blob-URL worker (the only carrier; no host module imports this).
 *
 *  - storage: IndexedDB (an open failure answers init `storage-lost`: the host
 *    stops and reports it, OR-1);
 *  - identity (identity-per-store §4): registration with the install's grant (relayHttp.ts registerDevice), and the
 *    store's device token, which the relay and blob adapters read per call once the engine found or minted it;
 *  - relay: WebSocket streams + HTTP tickets; blobs: HTTP blob store when the
 *    relay advertises attachments, else none (attachments are not synced; a
 *    later connect probes again, probeBlob). Capabilities unreachable (offline
 *    start) or unanswered within CAPABILITIES_TIMEOUT_MS: assume the blob store
 *    and let the blob queue retry (startupBlob), so refs never depend on whether
 *    the device happened to be online at startup and init never waits on it;
 *  - crypto: by init.crypto (e2ee-design §12.4, §18.4): suite 0 is the identity
 *    adapter (DESIGN §a); suite 1 and an unpinned device get the suite-1
 *    adapter (unpinned: no keys, so a QR / RK key can be verified against `k`);
 *    hash, random, clock: WebCrypto / setTimeout;
 *  - local time zone for conflict-copy names (the core never reads Date);
 *  - the worker scope's facts for the device check (webDeviceEnv.ts).
 */

import type { EngineTransport } from "../../protocol/transport";
import { createEngine, type EngineHandle } from "../compose/protocolEngine";
import { probeHttpBlob, startupBlob } from "./httpBlob";
import { createIdbStoragePort } from "./idbStorage";
import { createNoopCrypto } from "./noopCrypto";
import { createWebCryptoSuite1 } from "./webCryptoSuite1";
import { createWebClock } from "./webClock";
import { webDeviceEnv } from "./webDeviceEnv";
import { createWebHash } from "./webHash";
import { createWebRandom } from "./webRandom";
import { createWsRelayPort } from "./wsRelay";
import { createRelayHttp } from "./relayHttp";
import type { IdentityPort } from "../../ports/identity";

export interface WebEngineOptions {
	readonly clientVersion?: string;
	readonly log?: (line: string) => void;
}

export function createWebEngine(transport: EngineTransport, o: WebEngineOptions = {}): EngineHandle {
	return createEngine(transport, {
		carrier: "worker",
		clientVersion: o.clientVersion ?? "dev",
		log: o.log,
		tzOffsetMinutes: () => -new Date().getTimezoneOffset(),
		deviceEnv: webDeviceEnv,
		makePorts: async (config) => {
			const clock = createWebClock();
			const hash = createWebHash();
			const random = createWebRandom();
			const storage = createIdbStoragePort();
			// SECRET: the store's device token, set once the engine found or minted the store (identity-per-store §4).
			let token = "";
			const credential = (): string => token;
			const relay = createWsRelayPort({ baseUrl: config.relay.url, credential, clock, random });
			const blobOpts = { baseUrl: config.relay.url, vaultId: config.vaultId, credential, clock };
			const blob = await startupBlob(blobOpts, o.log);
			const c = config.crypto;
			// Suite-1 keys are zero-filled once imported (webCryptoSuite1.ts); the port outlives runtime restarts.
			const crypto = c.suite === 0 ? createNoopCrypto(hash) : await createWebCryptoSuite1({ vaultId: config.vaultId, random, keys: c.suite === 1 ? c.keys : [] });
			const http = createRelayHttp({ baseUrl: config.relay.url, credential, clock });
			const grantSecret = config.relay.grantSecret;
			const identity: IdentityPort = {
				register: (body) => (grantSecret ? http.registerDevice(config.vaultId, grantSecret, body) : Promise.resolve({ ok: false, reason: "no-grant", retryAfterMs: null })),
				use: (deviceToken) => {
					token = deviceToken;
				},
			};
			return { relay, storage, clock, random, crypto, hash, blob, probeBlob: () => probeHttpBlob(blobOpts), identity };
		},
	});
}
