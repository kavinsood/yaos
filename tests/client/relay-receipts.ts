import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { fencedWebSocketConstructor } from "../../legacy-src/sync/fencedWebSocket";
import { OwnAwarenessProvider } from "../../legacy-src/sync/ownAwarenessProvider";
import {
	RECEIPT_RESEND_MAX_MS,
	RECEIPT_RESEND_MS,
	RelayReceiptChannel,
	parseSyncFrame,
	type RelayReceiptInfo,
} from "../../legacy-src/sync/relayReceipts";
import { sha256HexSync } from "../../legacy-src/utils/sha256Sync";
import { suite } from "../harness.ts";

const s = suite("relay-receipts");

// The provider registers window unload/online listeners; the Node host window
// has no event target (same stub as own-awareness-provider). Each suite runs in
// its own process, so this is not restored.
{
	const hostWindow = window as unknown as Record<string, unknown>;
	if (typeof hostWindow.addEventListener !== "function") hostWindow.addEventListener = () => {};
	if (typeof hostWindow.removeEventListener !== "function") hostWindow.removeEventListener = () => {};
}
const BODY_ID = "body-1";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class FakeClock {
	private time = 0;
	private sequence = 0;
	readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
	now(): number { return this.time; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { dueAt: this.time + delayMs, callback });
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			const next = [...this.timers.entries()]
				.filter(([, timer]) => timer.dueAt <= target)
				.sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
			if (!next) break;
			this.timers.delete(next[0]);
			this.time = Math.max(this.time, next[1].dueAt);
			next[1].callback();
		}
		this.time = target;
	}
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** Browser-WebSocket double the test drives as the server. */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	readyState = 0;
	binaryType = "arraybuffer";
	readonly sent: Array<string | Uint8Array> = [];
	private readonly listeners = new Map<string, Set<Listener>>();
	constructor(readonly url: string) { FakeSocket.instances.push(this); }
	addEventListener(type: string, listener: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
	dispatchEvent(): boolean { return true; }
	send(data: string | ArrayBufferLike | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("socket not open");
		if (typeof data === "string") this.sent.push(data);
		else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		else this.sent.push(new Uint8Array(data as ArrayBuffer).slice());
	}
	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", { code, reason });
	}
	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}
	receive(data: string | Uint8Array): void {
		this.emit("message", { data: typeof data === "string" ? data : data.slice().buffer });
	}
	private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
}

function syncFrame(sync: number, payload: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	encoding.writeVarUint(encoder, sync);
	encoding.writeVarUint8Array(encoder, payload);
	return encoding.toUint8Array(encoder);
}

interface ClientFrame {
	kind: "step1" | "step2" | "update" | "awareness" | "other";
	inner: Uint8Array | null;
	envelope: Record<string, unknown> | null;
}

/** Server-side view of what the client sent, envelopes paired with the next binary frame. */
function readFrames(socket: FakeSocket, from = 0): ClientFrame[] {
	const frames: ClientFrame[] = [];
	let pending: Record<string, unknown> | null = null;
	for (const data of socket.sent.slice(from)) {
		if (typeof data === "string") {
			const value = JSON.parse(data.slice("__YPS:".length)) as Record<string, unknown>;
			if (value.type === "BODY_UPDATE_ENVELOPE") {
				assert.equal(pending, null, "two envelopes without a frame between them");
				pending = value;
			}
			continue;
		}
		const parsed = parseSyncFrame(data);
		const kind = parsed.type === 1 ? "awareness"
			: parsed.type !== 0 ? "other"
				: parsed.sync === 0 ? "step1" : parsed.sync === 1 ? "step2" : "update";
		if (kind === "step1") {
			const decoder = decoding.createDecoder(data);
			decoding.readVarUint(decoder);
			decoding.readVarUint(decoder);
			frames.push({ kind, inner: decoding.readVarUint8Array(decoder), envelope: null });
			assert.equal(pending, null, "envelope before a step1");
			continue;
		}
		frames.push({ kind, inner: parsed.inner, envelope: pending });
		if (pending) assert.ok(kind === "update", "envelopes only precede update frames");
		pending = null;
	}
	assert.equal(pending, null, "dangling envelope");
	return frames;
}

function ready(socket: FakeSocket, relayBodies: number | null = 2): void {
	socket.receive(`__YPS:${JSON.stringify({
		type: "VAULT_READY", documentId: BODY_ID, documentEpoch: 1, socketSessionId: "s", vaultGeneration: "gen-1",
		durableGeneration: 1, runtimeEpoch: "runtime-1",
		capabilities: relayBodies === null ? {} : { relayBodies },
	})}`);
}

function receipt(socket: FakeSocket, envelope: Record<string, unknown>, durableGeneration: number,
	extra: Record<string, unknown> = {}): void {
	socket.receive(`__YPS:${JSON.stringify({
		type: "BODY_COMMITTED", bodyId: BODY_ID, bodyEpoch: 1, vaultGeneration: "gen-1", durableGeneration,
		vaultSequence: durableGeneration, lifecycle: "active", contentHash: null, size: null,
		runtimeEpoch: "runtime-1", relay: true, clientFrameId: envelope.clientFrameId,
		payloadDigest: envelope.payloadDigest, commitRuntimeEpoch: "runtime-2", contentHashAccepted: false,
		deduped: false, noop: false, ...extra,
	})}`);
}

interface Rig {
	clock: FakeClock;
	doc: Y.Doc;
	server: Y.Doc;
	channel: RelayReceiptChannel;
	provider: OwnAwarenessProvider;
	confirmations: Array<{ seq: number; info: RelayReceiptInfo }>;
	active: boolean[];
	socket(): FakeSocket;
	/** Connects, answers the client step1, sends the server step1 and (optionally) VAULT_READY. */
	connect(options?: { relayBodies?: number | null; skipReady?: boolean }): Promise<FakeSocket>;
	type(text: string): void;
	applyToServer(frames: ClientFrame[]): void;
	destroy(): void;
}

function rig(options: { random?: number; receipts?: boolean } = {}): Rig {
	FakeSocket.instances = [];
	const clock = new FakeClock();
	const doc = new Y.Doc();
	const server = new Y.Doc();
	const confirmations: Rig["confirmations"] = [];
	const active: boolean[] = [];
	let provider: OwnAwarenessProvider | null = null;
	let frameCounter = 0;
	const channel = new RelayReceiptChannel({
		bodyId: BODY_ID,
		doc,
		bodyEpoch: () => 1,
		isLocalOrigin: (origin) => provider !== null && origin !== provider,
		receipts: options.receipts,
		random: () => options.random ?? 0.5,
		setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
		clearTimer: (handle) => clock.clearTimer(handle),
		newFrameId: () => `frame-${++frameCounter}`,
		onConfirmed: (seq, info) => confirmations.push({ seq, info }),
		onRelayActiveChanged: (value) => active.push(value),
	});
	provider = new OwnAwarenessProvider("ws://relay.test", BODY_ID, doc, {
		connect: false,
		disableBc: true,
		maxBackoffTime: 60_000,
		WebSocketPolyfill: fencedWebSocketConstructor(FakeSocket as unknown as typeof WebSocket, undefined,
			channel.tapFactory),
	});
	const current = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
	return {
		clock, doc, server, channel, provider, confirmations, active,
		socket: current,
		async connect(connectOptions = {}) {
			const before = FakeSocket.instances.length;
			await provider!.connect();
			for (let index = 0; index < 20 && FakeSocket.instances.length === before; index++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			const socket = current();
			socket.open();
			// Server step1 first (as the relay accept path does), then VAULT_READY.
			socket.receive(syncFrame(0, Y.encodeStateVector(server)));
			const step1 = readFrames(socket).find((frame) => frame.kind === "step1");
			if (step1?.inner) socket.receive(syncFrame(1, Y.encodeStateAsUpdate(server, step1.inner)));
			if (!connectOptions.skipReady) ready(socket, connectOptions.relayBodies === undefined ? 2 : connectOptions.relayBodies);
			return socket;
		},
		type(text: string) {
			const ytext = doc.getText("body");
			ytext.insert(ytext.length, text);
		},
		applyToServer(frames: ClientFrame[]) {
			for (const frame of frames) {
				if ((frame.kind === "update" || frame.kind === "step2") && frame.inner) Y.applyUpdate(server, frame.inner, "client");
			}
		},
		destroy() {
			provider!.destroy();
			channel.destroy();
			doc.destroy();
			server.destroy();
		},
	};
}

s.test("sha256HexSync matches node:crypto across block boundaries", () => {
	for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
		const bytes = new Uint8Array(randomBytes(length));
		assert.equal(sha256HexSync(bytes), sha(bytes), `length ${length}`);
	}
});

s.test("updates after the sync point are enveloped, back to back, with the inner-update digest", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		assert.equal(r.channel.relayActive, true);
		assert.deepEqual(r.active, [true]);
		const from = socket.sent.length;
		r.type("hello");
		const frames = readFrames(socket, from);
		assert.equal(frames.length, 1);
		assert.equal(frames[0]!.kind, "update");
		const envelope = frames[0]!.envelope!;
		assert.equal(envelope.type, "BODY_UPDATE_ENVELOPE");
		assert.equal(envelope.bodyId, BODY_ID);
		assert.equal(envelope.bodyEpoch, 1);
		assert.equal(envelope.payloadDigest, sha(frames[0]!.inner!));
		assert.equal(envelope.frameKind, "update");
		// The text frame is immediately followed by its binary frame.
		assert.equal(typeof socket.sent[from], "string");
		assert.ok(socket.sent[from + 1] instanceof Uint8Array);
	} finally { r.destroy(); }
});

s.test("a 1.5 s receipt is normal: no re-send, confirmation advances", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		r.type("a");
		r.type("b");
		r.clock.advance(1_500);
		const frames = readFrames(socket, from);
		assert.equal(frames.length, 2, "no re-send while the receipt is 1.5 s late");
		receipt(socket, frames[1]!.envelope!, 7);
		assert.equal(r.channel.confirmedSeq, r.channel.seq);
		assert.equal(r.confirmations.length, 1);
		assert.equal(r.confirmations[0]!.info.durableGeneration, 7);
		assert.equal(r.confirmations[0]!.info.commitRuntimeEpoch, "runtime-2");
		r.clock.advance(RECEIPT_RESEND_MAX_MS * 3);
		assert.equal(readFrames(socket, from).length, 2, "nothing re-sent once confirmed");
		assert.equal(r.channel.diagnostics().resends.timeout, 0);
	} finally { r.destroy(); }
});

s.test("a receipt for a later frame settles earlier frames (in-order commit)", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		r.type("1");
		const seqAfterFirst = r.channel.seq;
		r.type("2");
		r.type("3");
		const frames = readFrames(socket, from);
		receipt(socket, frames[2]!.envelope!, 3);
		assert.equal(r.channel.confirmedSeq, r.channel.seq);
		assert.ok(r.channel.confirmedSeq > seqAfterFirst);
		// The late receipts for frames 1 and 2 are ignored, not errors.
		receipt(socket, frames[0]!.envelope!, 1);
		receipt(socket, frames[1]!.envelope!, 2);
		assert.equal(r.confirmations.length, 1);
		assert.equal(r.channel.diagnostics().unconfirmedEntries, 0);
	} finally { r.destroy(); }
});

s.test("no receipt: re-send after RECEIPT_RESEND_MS, exponential backoff, capped", async () => {
	assert.equal(RECEIPT_RESEND_MS, 5_000);
	const r = rig({ random: 0.5 });
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		r.type("lost ");
		r.type("edit");
		const resendTimes: number[] = [];
		let seen = readFrames(socket, from).length;
		for (let elapsed = 0; elapsed < 200_000; elapsed += 100) {
			r.clock.advance(100);
			const frames = readFrames(socket, from);
			if (frames.length > seen) {
				for (const frame of frames.slice(seen)) {
					assert.equal(frame.envelope?.frameKind, "timeout");
					resendTimes.push(r.clock.now());
				}
				seen = frames.length;
			}
		}
		const gaps = resendTimes.map((time, index) => time - (index === 0 ? 0 : resendTimes[index - 1]!));
		assert.deepEqual(gaps.slice(0, 6), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
		// Each re-send carries every unconfirmed update, merged.
		const last = readFrames(socket, from).at(-1)!;
		const probe = new Y.Doc();
		Y.applyUpdate(probe, last.inner!);
		assert.equal(probe.getText("body").toString(), "lost edit");
		assert.equal(last.envelope!.payloadDigest, sha(last.inner!));
		// A receipt for a re-send stops the loop and resets the backoff.
		receipt(socket, last.envelope!, 9);
		const after = socket.sent.length;
		r.clock.advance(RECEIPT_RESEND_MAX_MS * 2);
		assert.equal(socket.sent.length, after);
		assert.equal(r.channel.diagnostics().resendAttempt, 0);
	} finally { r.destroy(); }
});

s.test("re-send delay jitter stays within ±20 %", async () => {
	for (const random of [0, 0.999]) {
		const r = rig({ random });
		try {
			const socket = await r.connect();
			const from = socket.sent.length;
			r.type("x");
			let at = -1;
			for (let elapsed = 0; elapsed < 7_000 && at < 0; elapsed += 50) {
				r.clock.advance(50);
				if (readFrames(socket, from).length > 1) at = r.clock.now();
			}
			const expected = random === 0 ? 4_000 : 6_000;
			assert.ok(Math.abs(at - expected) <= 50, `random ${random}: re-sent at ${at}`);
		} finally { r.destroy(); }
	}
});

s.test("reconnect: the sync point re-sends every unconfirmed update, online and offline", async () => {
	const r = rig();
	try {
		const first = await r.connect();
		const from = first.sent.length;
		r.type("online-unacked ");
		r.applyToServer(readFrames(first, from)); // broadcast, but never committed
		first.close(1006, "network");
		assert.equal(r.channel.relayActive, false);
		assert.deepEqual(r.active, [true, false]);
		r.type("offline");
		// Server lost the uncommitted frame on restart.
		r.server.destroy();
		r.server = new Y.Doc();
		r.clock.advance(1_000);
		const second = await r.connect({ skipReady: true });
		const beforeReady = readFrames(second);
		const step2 = beforeReady.find((frame) => frame.kind === "step2");
		assert.ok(step2, "client answered the server step1 with step2");
		assert.equal(step2!.envelope, null, "step2 is never enveloped");
		const readyAt = second.sent.length;
		ready(second);
		const resend = readFrames(second, readyAt);
		assert.equal(resend.length, 1);
		assert.equal(resend[0]!.envelope!.frameKind, "reconnect");
		const probe = new Y.Doc();
		Y.applyUpdate(probe, resend[0]!.inner!);
		assert.equal(probe.getText("body").toString(), "online-unacked offline");
		assert.equal(r.channel.diagnostics().resends.reconnect, 1);
		receipt(second, resend[0]!.envelope!, 4);
		assert.equal(r.channel.confirmedSeq, r.channel.seq);
	} finally { r.destroy(); }
});

s.test("re-sends are idempotent: duplicates in any order converge to the client state", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		r.type("alpha ");
		r.type("beta ");
		r.doc.getText("body").delete(0, 2);
		r.type("gamma");
		r.clock.advance(RECEIPT_RESEND_MS + 10);
		r.clock.advance(2 * RECEIPT_RESEND_MS + 10);
		const frames = readFrames(socket, from).filter((frame) => frame.kind === "update");
		assert.ok(frames.filter((frame) => frame.envelope?.frameKind === "timeout").length >= 2);
		const orders = [frames, [...frames].reverse(), [...frames, ...frames], [frames.at(-1)!, ...frames]];
		for (const order of orders) {
			const server = new Y.Doc();
			for (const frame of order) Y.applyUpdate(server, frame.inner!);
			assert.equal(server.getText("body").toString(), r.doc.getText("body").toString());
			assert.deepEqual(Y.encodeStateVector(server), Y.encodeStateVector(r.doc));
		}
		// Distinct frames get distinct clientFrameIds even when the bytes repeat.
		const ids = frames.map((frame) => frame.envelope!.clientFrameId);
		assert.equal(new Set(ids).size, ids.length);
	} finally { r.destroy(); }
});

s.test("mid-session server step1 (DO wake) gets a step2 reply with what the server lacks", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		r.type("before wake ");
		r.applyToServer(readFrames(socket));
		r.type("lost in wake");
		// The woken server only has "before wake" and asks the open socket.
		const from = socket.sent.length;
		socket.receive(syncFrame(0, Y.encodeStateVector(r.server)));
		const replies = readFrames(socket, from);
		assert.equal(replies.length, 1);
		assert.equal(replies[0]!.kind, "step2");
		assert.equal(replies[0]!.envelope, null);
		Y.applyUpdate(r.server, replies[0]!.inner!);
		assert.equal(r.server.getText("body").toString(), "before wake lost in wake");
		// An up-to-date step1 gets an (empty) step2, also plain.
		const again = socket.sent.length;
		socket.receive(syncFrame(0, Y.encodeStateVector(r.server)));
		const empty = readFrames(socket, again);
		assert.equal(empty.length, 1);
		assert.equal(empty[0]!.kind, "step2");
		assert.equal(empty[0]!.envelope, null);
	} finally { r.destroy(); }
});

s.test("no relay capability: frames pass through unchanged, no envelopes, no re-sends", async () => {
	const r = rig();
	try {
		const socket = await r.connect({ relayBodies: null });
		const from = socket.sent.length;
		r.type("base server");
		r.clock.advance(RECEIPT_RESEND_MAX_MS * 2);
		assert.equal(socket.sent.slice(from).filter((data) => typeof data === "string").length, 0);
		assert.equal(readFrames(socket, from).length, 1);
		assert.equal(r.channel.relayActive, false);
	} finally { r.destroy(); }
	const off = rig({ receipts: false });
	try {
		const socket = await off.connect();
		const from = socket.sent.length;
		off.type("receipts disabled");
		off.clock.advance(RECEIPT_RESEND_MAX_MS);
		assert.equal(socket.sent.slice(from).filter((data) => typeof data === "string").length, 0);
		assert.equal(off.channel.relayActive, false);
	} finally { off.destroy(); }
});

s.test("every local update is its own frame, sent at once (no send coalescing)", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		for (const char of "typing") r.type(char);
		assert.equal(readFrames(socket, from).length, 6);
	} finally { r.destroy(); }
});

s.test("receipt with a mismatched payload digest or foreign frame id confirms nothing", async () => {
	const r = rig();
	try {
		const socket = await r.connect();
		const from = socket.sent.length;
		r.type("x");
		const envelope = readFrames(socket, from)[0]!.envelope!;
		receipt(socket, { ...envelope, payloadDigest: "0".repeat(64) }, 2);
		receipt(socket, { ...envelope, clientFrameId: "someone-else" }, 2);
		assert.equal(r.confirmations.length, 0);
		assert.ok(r.channel.confirmedSeq < r.channel.seq);
	} finally { r.destroy(); }
});

await s.done();
