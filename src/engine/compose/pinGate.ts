/**
 * The engine's one write gate for a device without a usable pin (e2ee-design §12.4, WP-E4).
 *
 * Every write the engine makes comes from the VaultRuntime: frame sends, the outbox and its mirrors, checkpoints,
 * blob PUTs and reconcile (ns entries). ComposedEngine gives a VaultRuntime its ports only through `writerPorts`,
 * which throws while the gate is closed, so a closed device cannot build one. Instead it runs the KeyReader over
 * `readerPorts`: a relay that connects and reads (`canWrite` false; `append` and `putCheckpoint` throw), a clock and
 * a random source. No storage, blob, crypto or hash port reaches the reader, so it cannot write anything at all.
 *
 * The gate is open only for suite 0. Unpinned is closed by definition. Suite 1 stays closed until WP-E3's keyring
 * runtime can seal: the device is key-missing "no-key" and the init keys are zero-filled at once (§6.3), since
 * this engine has no use for them.
 */

import type { AppendFrame, PutCheckpointResult, RelayConnectParams, RelayConnectResult, RelayPort, RelaySession } from "../../ports/relay";
import type { ClockPort } from "../../ports/clock";
import type { EnginePorts } from "../../ports";
import type { RandomPort } from "../../ports/random";
import type { EngineInitConfig } from "../../protocol/messages";

/** A write attempted through a closed gate. A bug if it is ever thrown: nothing on the read path writes. */
export class WriteRefused extends Error {
	constructor(what: string) {
		super(`write refused: this device has no usable encryption pin (${what})`);
		this.name = "WriteRefused";
	}
}

/** All a closed device gets: read the relay, keep time, jitter its reconnects. */
export interface ReaderPorts {
	readonly relay: RelayPort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
}

/** A relay session that reads only. */
function readOnly(s: RelaySession): RelaySession {
	return {
		get vaultEpoch() {
			return s.vaultEpoch;
		},
		get headSeq() {
			return s.headSeq;
		},
		canWrite: false,
		get limits() {
			return s.limits;
		},
		append(_frame: AppendFrame): void {
			throw new WriteRefused("frame");
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

function readOnlyRelay(relay: RelayPort): RelayPort {
	return {
		async connect(params: RelayConnectParams): Promise<RelayConnectResult> {
			const r = await relay.connect(params);
			return r.ok ? { ok: true, session: readOnly(r.session) } : r;
		},
	};
}

export class PinGate {
	/** The pin this engine was started with (null: unpinned). */
	readonly suite: 0 | 1 | null;
	/** Started on the creation path (§15.1): the marker main holds for this vault. */
	readonly creating: boolean;

	constructor(crypto: EngineInitConfig["crypto"]) {
		this.suite = crypto.suite;
		this.creating = crypto.suite === null && crypto.creating;
		if (crypto.suite === 1) for (const key of crypto.keys) key.k.fill(0);
	}

	/** Writes allowed: a VaultRuntime may run. */
	get open(): boolean {
		return this.suite === 0;
	}

	/** The ports of a VaultRuntime. The only way to get them: throws while the gate is closed. */
	writerPorts(ports: EnginePorts): EnginePorts {
		if (!this.open) throw new WriteRefused("vault runtime");
		return ports;
	}

	/** The read-only view a closed device runs on. */
	readerPorts(ports: EnginePorts): ReaderPorts {
		return { relay: readOnlyRelay(ports.relay), clock: ports.clock, random: ports.random };
	}
}
