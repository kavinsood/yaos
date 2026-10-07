/**
 * Test kit for SimRelay under a VirtualClock (WP-A tests; usable by WP-D sims).
 * No node imports: typechecks with the strict client tsconfig.
 */

import type { ClientFrameId, DeviceId, Seq, StreamName } from "../core/types";
import type { AppendFrame, RelayConnectResult, RelayEvent } from "../ports/relay";
import type { VirtualClock } from "./clock";
import { SIM_VAULT_ID } from "./net";
import type { SimRelay, SimRelaySession } from "./relay";

export interface RelayPeer {
	readonly deviceId: DeviceId;
	readonly session: SimRelaySession;
	/** Every event delivered to the listener, in order. */
	readonly events: RelayEvent[];
	of<T extends RelayEvent["t"]>(t: T): Extract<RelayEvent, { t: T }>[];
	/** Seqs delivered as committed or receipt, in delivery order. */
	seqs(): Seq[];
}

const enc = new TextEncoder();

export function bytes(value: string | readonly number[] | number): Uint8Array {
	if (typeof value === "number") return new Uint8Array(value).fill(7);
	return typeof value === "string" ? enc.encode(value) : Uint8Array.from(value);
}

export function frame(stream: string, clientFrameId: string, payload: string | readonly number[] | number | Uint8Array): AppendFrame {
	return { stream: stream as StreamName, clientFrameId: clientFrameId as ClientFrameId, payload: payload instanceof Uint8Array ? payload : bytes(payload) };
}

export async function connectRaw(relay: SimRelay, clock: VirtualClock, deviceId: string): Promise<RelayConnectResult> {
	let result: RelayConnectResult | null = null;
	void relay.connect({ vaultId: SIM_VAULT_ID, deviceId: deviceId as DeviceId }).then((r) => {
		result = r;
	});
	await clock.runUntil(() => result !== null, 3_600_000);
	if (result === null) throw new Error("connect did not resolve");
	return result;
}

export function attach(session: SimRelaySession): RelayPeer {
	const events: RelayEvent[] = [];
	session.onEvent((e) => events.push(e));
	return {
		deviceId: session.deviceId,
		session,
		events,
		of: <T extends RelayEvent["t"]>(t: T) => events.filter((e): e is Extract<RelayEvent, { t: T }> => e.t === t),
		seqs: () => events.flatMap((e) => (e.t === "committed" ? [e.frame.seq] : e.t === "receipt" ? [e.seq] : [])),
	};
}

export async function connectPeer(relay: SimRelay, clock: VirtualClock, deviceId: string): Promise<RelayPeer> {
	const result = await connectRaw(relay, clock, deviceId);
	if (!result.ok) throw new Error(`connect refused: ${result.reason}`);
	return attach(result.session as SimRelaySession);
}

/** Resolves a promise produced against the virtual clock. */
export async function pump<T>(clock: VirtualClock, promise: Promise<T>): Promise<T> {
	let done = false;
	let value: T | undefined;
	let error: unknown = null;
	let failed = false;
	promise.then((v) => {
		done = true;
		value = v;
	}, (e: unknown) => {
		done = true;
		failed = true;
		error = e;
	});
	await clock.runUntil(() => done, 3_600_000);
	if (!done) throw new Error("promise did not settle");
	if (failed) throw error;
	return value as T;
}

/** Event kinds in order, with the interesting field (compact assertions). */
export function trace(events: readonly RelayEvent[]): string[] {
	return events.map((e) => {
		switch (e.t) {
			case "receipt": return `receipt ${e.clientFrameId}@${e.seq}${e.deduped ? " dedup" : ""}`;
			case "committed": return `committed ${e.frame.clientFrameId}@${e.frame.seq}${e.frame.payload === null ? " null" : ""}`;
			case "provisional": return `provisional ${e.clientFrameId}`;
			case "refused": return `refused ${e.clientFrameId} ${e.reason}${e.conflictSeq !== null ? `@${e.conflictSeq}` : ""}`;
			case "provisionalDropped": return `dropped ${e.clientFrameId}`;
			case "resendUnreceipted": return `resend ${e.headSeq}`;
			case "backpressure": return "backpressure";
			case "head": return `head ${e.headSeq}`;
			case "closed": return `closed ${e.code}${e.errorCode !== null ? ` ${e.errorCode}` : ""}${e.wasClean ? "" : " unclean"}`;
		}
	});
}
