/**
 * TEST ONLY (testkit/: never imported by product code). A complete EnginePorts around the one port a test is about
 * (usually crypto): the rest are inert sim stand-ins, and a relay that is never meant to be dialled.
 */

import type { EnginePorts } from "../../../ports";
import type { CryptoPort } from "../../../ports/crypto";
import type { RelayPort } from "../../../ports/relay";
import { VirtualClock } from "../../../sim/clock";
import { simHashPort } from "../../../sim/hash";
import { SeededRandom } from "../../../sim/random";
import { MemStoragePort } from "../../../sim/storage";

const undialled: RelayPort = {
	connect: () => Promise.reject(new Error("testkit enginePorts: this relay is not meant to be dialled")),
};

export function enginePortsWith(crypto: CryptoPort, over: Partial<EnginePorts> = {}): EnginePorts {
	return {
		relay: undialled,
		storage: new MemStoragePort(),
		clock: new VirtualClock(),
		random: new SeededRandom(1),
		crypto,
		hash: simHashPort(),
		blob: null,
		...over,
	};
}
