/**
 * The engine's one gate for a device that may not write (e2ee-design §12.4, WP-E4): unpinned, or pinned to suite 1
 * without the vault key.
 *
 * Every write the engine makes comes from the VaultRuntime: frame sends, the outbox and its mirrors, checkpoints,
 * blob PUTs and reconcile (ns entries). ComposedEngine gives a VaultRuntime its ports only through `writerPorts`,
 * which throws while the gate is closed, so a closed device cannot build one. Instead it runs the KeyReader over
 * `readerPorts`: a relay that connects and reads (`append` throws, `putCheckpoint` rejects), a clock, a random source
 * and the suite-1 adapter's key operations (no seal, open or blob op). No storage, blob or hash port reaches the
 * reader. The one write it can make is the genesis of enableE2ee (§15.1): on the creation path its relay appends on
 * `k` and on no other stream.
 *
 * The gate is open for suite 0, and for suite 1 once the keyring (keyring.ts) holds the key of the newest stored
 * winner, verified against its record (keyMissing null). The keys reach the crypto port in makePorts, which
 * zero-fills init's copies (webCryptoSuite1.ts). Unpinned is closed by definition. What can go wrong later in a
 * session (a revoke, a newer winner without its key, `k` not read yet) is the keyring runtime's to hold
 * (keyringRuntime.ts, writeGate.ts).
 */

import { KEYRING_STREAM } from "../../core/types";
import type { AppendFrame, PutCheckpointResult, RelayConnectParams, RelayConnectResult, RelayPort, RelaySession } from "../../ports/relay";
import type { ClockPort } from "../../ports/clock";
import type { EnginePorts } from "../../ports";
import type { CryptoPort, KeyringCrypto } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import type { EngineInitConfig } from "../../protocol/messages";
import { Keyring } from "../keyring/keyring";
import { keyringCryptoOf } from "../keyring/writeGate";
import type { HostKeyring } from "./hostKeyring";

/** A write attempted through a closed gate. A bug if it is ever thrown: nothing on the read path writes. */
export class WriteRefused extends Error {
	constructor(what: string) {
		super(`write refused: this device has no usable encryption pin (${what})`);
		this.name = "WriteRefused";
	}
}

/** The key operations a Keyring needs, without seal, open or any blob operation. */
export type ReaderKeys = KeyringCrypto & Pick<CryptoPort, "keyState" | "sealEpoch">;

/** All a closed device gets: read the relay (append on `k` on the creation path only), keep time, jitter, judge `k`. */
export interface ReaderPorts {
	readonly relay: RelayPort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	/** null: a suite-0 adapter (no keys to judge `k` with). */
	readonly keys: ReaderKeys | null;
}

export interface GateKeys {
	readonly vaultId: string;
	readonly keyring: HostKeyring;
	readonly diag?: (code: string, fields: Record<string, string | number | boolean | null>) => void;
}

/** A relay session that reads only, or (`kOnly`) appends on `k` and nowhere else. */
function readOnly(s: RelaySession, kOnly: boolean): RelaySession {
	return {
		get vaultEpoch() {
			return s.vaultEpoch;
		},
		get headSeq() {
			return s.headSeq;
		},
		get canWrite() {
			return kOnly && s.canWrite;
		},
		get limits() {
			return s.limits;
		},
		append(frame: AppendFrame): void {
			if (!kOnly || frame.stream !== KEYRING_STREAM) throw new WriteRefused("frame");
			s.append(frame);
		},
		bufferedBytes: () => s.bufferedBytes(),
		feed: (afterSeq) => s.feed(afterSeq),
		read: (stream, afterSeq, preferCheckpoint) => s.read(stream, afterSeq, preferCheckpoint),
		readBatch: (reqs) => s.readBatch(reqs),
		putCheckpoint(): Promise<PutCheckpointResult> {
			return Promise.reject(new WriteRefused("checkpoint"));
		},
		onEvent: (listener) => s.onEvent(listener),
		close: (code, reason) => s.close(code, reason),
	};
}

function readOnlyRelay(relay: RelayPort, kOnly: boolean): RelayPort {
	return {
		async connect(params: RelayConnectParams): Promise<RelayConnectResult> {
			const r = await relay.connect(params);
			return r.ok ? { ok: true, session: readOnly(r.session, kOnly) } : r;
		},
	};
}

/** The adapter's key operations as their own object: the reader cannot reach seal, open or the blob ops. */
function keysOf(crypto: CryptoPort): ReaderKeys | null {
	const kc = keyringCryptoOf(crypto);
	if (!kc) return null;
	return {
		generate: (e) => kc.generate(e),
		install: (e, raw) => kc.install(e, raw),
		kcv: (e) => kc.kcv(e),
		wrap: (role, e, aad, rk) => kc.wrap(role, e, aad, rk),
		unwrap: (role, e, aad, wrapped, rk) => kc.unwrap(role, e, aad, wrapped, rk),
		markVerified: (e) => kc.markVerified(e),
		setSealEpoch: (e) => kc.setSealEpoch(e),
		drop: (e) => kc.drop(e),
		exportForHost: () => kc.exportForHost(),
		keyState: (e) => kc.keyState(e),
		sealEpoch: () => kc.sealEpoch(),
	};
}

/** Suite 1: whether the adapter holds the newest stored winner's key, verified against its record (§12.4, §18.4). */
async function keyed(ports: EnginePorts, o: GateKeys): Promise<boolean> {
	const kc = keyringCryptoOf(ports.crypto);
	if (!kc) return false;
	const kr = await Keyring.open({ mode: "suite1", vaultId: o.vaultId, kc, records: o.keyring.records, persist: o.keyring.persist, diag: o.diag });
	try {
		return kr.keyMissing() === null;
	} finally {
		kr.dispose();
	}
}

export class PinGate {
	/** The pin this engine was started with (null: unpinned). */
	readonly suite: 0 | 1 | null;
	/** Started on the creation path (§15.1): the marker main holds for this vault. */
	readonly creating: boolean;
	private keyed = false;

	private constructor(crypto: EngineInitConfig["crypto"]) {
		this.suite = crypto.suite;
		this.creating = crypto.suite === null && crypto.creating;
	}

	/** After makePorts: the init keys are in the crypto port. */
	static async open(crypto: EngineInitConfig["crypto"], ports: EnginePorts, o: GateKeys): Promise<PinGate> {
		const gate = new PinGate(crypto);
		if (gate.suite === 1) gate.keyed = await keyed(ports, o);
		return gate;
	}

	/** Writes allowed: a VaultRuntime may run. */
	get open(): boolean {
		return this.suite === 0 || (this.suite === 1 && this.keyed);
	}

	/** Suite 1 started without the key: decide again after the KeyReader's keyring stored one. true: open now. */
	async recheck(ports: EnginePorts, o: GateKeys): Promise<boolean> {
		if (this.suite === 1 && !this.keyed) this.keyed = await keyed(ports, o);
		return this.open;
	}

	/** The ports of a VaultRuntime. The only way to get them: throws while the gate is closed. */
	writerPorts(ports: EnginePorts): EnginePorts {
		if (!this.open) throw new WriteRefused("vault runtime");
		return ports;
	}

	/** The view a closed device runs on. */
	readerPorts(ports: EnginePorts): ReaderPorts {
		return { relay: readOnlyRelay(ports.relay, this.creating), clock: ports.clock, random: ports.random, keys: keysOf(ports.crypto) };
	}
}
