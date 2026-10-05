import { strict as assert } from "node:assert";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { messageAwareness, messageQueryAwareness } from "y-partyserver/provider";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { fencedWebSocketConstructor } from "../../legacy-src/sync/fencedWebSocket";
import {
	AWARENESS_REMOTE_TIMEOUT_MS,
	AWARENESS_RENEW_MS,
	OwnAwarenessProvider,
} from "../../legacy-src/sync/ownAwarenessProvider";
import { suite } from "../harness.ts";

// The server binds exactly one awareness client per socket and closes a socket
// whose frame names another client. These tests drive the real y-partyserver
// provider through a fake socket and decode every awareness frame it sends.

class FakeWebSocket {
	static last: FakeWebSocket | null = null;
	readyState = 1;
	binaryType: BinaryType = "arraybuffer";
	readonly listeners = new Map<string, Set<EventListener>>();
	sent: unknown[] = [];
	constructor(readonly url: string | URL) { FakeWebSocket.last = this; }
	send(value: unknown): void { this.sent.push(value); }
	close(): void { this.readyState = 3; }
	addEventListener(type: string, listener: EventListener): void {
		const values = this.listeners.get(type) ?? new Set<EventListener>();
		values.add(listener);
		this.listeners.set(type, values);
	}
	removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
	emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
	}
	receive(data: Uint8Array): void {
		const buffer = data.slice().buffer;
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ type: "message", data: buffer } as unknown as Event);
		}
	}
}

interface AwarenessEntry { clientID: number; state: unknown }

/** Decodes every binary awareness frame the socket sent, in order. */
function sentAwarenessFrames(socket: FakeWebSocket): AwarenessEntry[][] {
	const frames: AwarenessEntry[][] = [];
	for (const value of socket.sent) {
		if (typeof value === "string") continue;
		const decoder = decoding.createDecoder(value as Uint8Array);
		if (decoding.readVarUint(decoder) !== messageAwareness) continue;
		const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
		const entries: AwarenessEntry[] = [];
		const count = decoding.readVarUint(update);
		for (let i = 0; i < count; i++) {
			const clientID = decoding.readVarUint(update);
			decoding.readVarUint(update);
			entries.push({ clientID, state: JSON.parse(decoding.readVarString(update)) });
		}
		frames.push(entries);
	}
	return frames;
}

function awarenessFrame(awareness: Awareness, clients: number[]): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
	return encoding.toUint8Array(encoder);
}

function queryAwarenessFrame(): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageQueryAwareness);
	return encoding.toUint8Array(encoder);
}

/** A peer whose awareness state arrives through the server relay. */
function remotePeer(state: Record<string, unknown>): { awareness: Awareness; doc: Y.Doc } {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
	awareness.setLocalState(state);
	return { awareness, doc };
}

async function withProvider(
	options: { ownAwareness: boolean },
	run: (provider: OwnAwarenessProvider, socket: FakeWebSocket) => void,
): Promise<void> {
	const hostWindow = window as Window & {
		addEventListener: Window["addEventListener"];
		removeEventListener: Window["removeEventListener"];
	};
	const originalAdd = hostWindow.addEventListener;
	const originalRemove = hostWindow.removeEventListener;
	hostWindow.addEventListener = (() => {}) as Window["addEventListener"];
	hostWindow.removeEventListener = (() => {}) as Window["removeEventListener"];
	const doc = new Y.Doc();
	try {
		// Mirrors VaultSync.createDefaultProvider: the root provider owns the
		// default awareness; body/semantic providers get their own, cleared.
		const provider = new OwnAwarenessProvider("example.test", `doc-${doc.clientID}`, doc, {
			connect: false,
			disableBc: true,
			// @ts-expect-error FakeWebSocket intentionally implements only the provider-used WebSocket surface.
			WebSocketPolyfill: fencedWebSocketConstructor(FakeWebSocket),
			awareness: options.ownAwareness ? new Awareness(doc) : undefined,
		});
		if (options.ownAwareness) provider.awareness.setLocalState(null);
		await provider.connect();
		const socket = FakeWebSocket.last!;
		socket.emit("open");
		try {
			run(provider, socket);
		} finally {
			provider.destroy();
		}
	} finally {
		hostWindow.addEventListener = originalAdd;
		hostWindow.removeEventListener = originalRemove;
		doc.destroy();
	}
}

const s = suite("own-awareness-provider");

for (const ownAwareness of [false, true]) {
	const label = ownAwareness ? "body provider (own Awareness)" : "root provider (default awareness)";

	s.test(`${label}: remote awareness is applied locally but never sent back`, async () => {
		await withProvider({ ownAwareness }, (provider, socket) => {
			const own = provider.awareness.clientID;
			const peer = remotePeer({ cursor: { anchor: 1 } });
			const before = sentAwarenessFrames(socket).length;
			socket.receive(awarenessFrame(peer.awareness, [peer.awareness.clientID]));
			assert.ok(provider.awareness.getStates().has(peer.awareness.clientID), "remote state is applied");
			peer.awareness.setLocalState({ cursor: { anchor: 2 } });
			socket.receive(awarenessFrame(peer.awareness, [peer.awareness.clientID]));
			peer.awareness.setLocalState(null);
			socket.receive(awarenessFrame(peer.awareness, [peer.awareness.clientID]));
			assert.ok(!provider.awareness.getStates().has(peer.awareness.clientID), "remote removal is applied");
			assert.equal(sentAwarenessFrames(socket).length, before, "remote add/update/remove sends nothing");
			for (const frame of sentAwarenessFrames(socket)) {
				assert.deepEqual(frame.map((entry) => entry.clientID), [own]);
			}
			peer.awareness.destroy();
			peer.doc.destroy();
		});
	});

	s.test(`${label}: own state changes and own removal are sent as single-client frames`, async () => {
		await withProvider({ ownAwareness }, (provider, socket) => {
			const own = provider.awareness.clientID;
			const before = sentAwarenessFrames(socket).length;
			provider.awareness.setLocalState({ cursor: { anchor: 3 } });
			provider.awareness.setLocalStateField("cursor", { anchor: 4 });
			provider.awareness.setLocalState(null);
			const frames = sentAwarenessFrames(socket).slice(before);
			assert.deepEqual(frames.map((frame) => frame.map((entry) => entry.clientID)), [[own], [own], [own]]);
			assert.deepEqual(frames[1]![0]!.state, { cursor: { anchor: 4 } });
			assert.equal(frames[2]![0]!.state, null, "own removal is transmitted");
		});
	});

	s.test(`${label}: an awareness query is answered with the own state only`, async () => {
		await withProvider({ ownAwareness }, (provider, socket) => {
			const own = provider.awareness.clientID;
			provider.awareness.setLocalState({ cursor: { anchor: 5 } });
			const peer = remotePeer({ cursor: { anchor: 6 } });
			socket.receive(awarenessFrame(peer.awareness, [peer.awareness.clientID]));
			assert.equal(provider.awareness.getStates().size, 2);
			const before = sentAwarenessFrames(socket).length;
			socket.receive(queryAwarenessFrame());
			const replies = sentAwarenessFrames(socket).slice(before);
			assert.equal(replies.length, 1);
			assert.deepEqual(replies[0], [{ clientID: own, state: { cursor: { anchor: 5 } } }]);
			peer.awareness.destroy();
			peer.doc.destroy();
		});
	});
}

s.test("destroy unsubscribes the filtered awareness handler", async () => {
	let awareness: Awareness | null = null;
	let socket: FakeWebSocket | null = null;
	await withProvider({ ownAwareness: true }, (provider, openSocket) => {
		awareness = provider.awareness;
		socket = openSocket;
	});
	const sentBefore = socket!.sent.length;
	awareness!.setLocalState({ cursor: { anchor: 7 } });
	assert.equal(socket!.sent.length, sentBefore);
	assert.equal((awareness! as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("change")?.size ?? 0, 0);
});

s.test("the own state is renewed once per renewal period, only while connected and non-empty (N5)", async () => {
	await withProvider({ ownAwareness: true }, (provider, socket) => {
		const own = provider.awareness.clientID;
		provider.awareness.setLocalState({ cursor: { anchor: 8 } });
		const setAt = provider.awareness.meta.get(own)!.lastUpdated;
		const clock = () => provider.awareness.meta.get(own)!.clock;
		const clockBefore = clock();
		const before = sentAwarenessFrames(socket).length;
		provider.checkAwareness(setAt + AWARENESS_RENEW_MS - 1);
		assert.equal(sentAwarenessFrames(socket).length, before, "not due yet");
		provider.checkAwareness(setAt + AWARENESS_RENEW_MS);
		const renewals = sentAwarenessFrames(socket).slice(before);
		assert.deepEqual(renewals, [[{ clientID: own, state: { cursor: { anchor: 8 } } }]], "one own-only renewal");
		assert.equal(clock(), clockBefore + 1, "at the next clock, so peers refresh it");
		provider.awareness.setLocalState({});
		const emptyBefore = sentAwarenessFrames(socket).length;
		provider.checkAwareness(Date.now() + 10 * AWARENESS_RENEW_MS);
		assert.equal(sentAwarenessFrames(socket).length, emptyBefore, "an empty state is not renewed (idle sockets stay quiet)");
		provider.awareness.setLocalState({ cursor: { anchor: 9 } });
		provider.disconnect();
		const offlineBefore = sentAwarenessFrames(socket).length;
		provider.checkAwareness(Date.now() + 10 * AWARENESS_RENEW_MS);
		assert.equal(sentAwarenessFrames(socket).length, offlineBefore, "no renewal while disconnected");
	});
});

s.test("a remote state that stops renewing times out locally without any frame being sent (N5)", async () => {
	await withProvider({ ownAwareness: true }, (provider, socket) => {
		const peer = remotePeer({ cursor: { anchor: 10 } });
		const peerId = peer.awareness.clientID;
		socket.receive(awarenessFrame(peer.awareness, [peerId]));
		assert.ok(provider.awareness.getStates().has(peerId));
		const seenAt = provider.awareness.meta.get(peerId)!.lastUpdated;
		const removed: number[] = [];
		provider.awareness.on("change", ({ removed: gone }: { removed: number[] }, origin: unknown) => {
			if (origin === "timeout") removed.push(...gone);
		});
		const before = sentAwarenessFrames(socket).length;
		provider.checkAwareness(seenAt + AWARENESS_REMOTE_TIMEOUT_MS - 1);
		assert.ok(provider.awareness.getStates().has(peerId), "a late renewal is tolerated");
		provider.checkAwareness(seenAt + AWARENESS_REMOTE_TIMEOUT_MS);
		assert.equal(provider.awareness.getStates().has(peerId), false, "a stale peer is dropped");
		assert.deepEqual(removed, [peerId], "observers see the removal (cursor decorations clear)");
		assert.equal(sentAwarenessFrames(socket).length, before, "a timeout is never relayed");
		peer.awareness.destroy();
		peer.doc.destroy();
	});
});

s.test("destroy stops the awareness check timer (N5)", async () => {
	let provider: OwnAwarenessProvider | null = null;
	await withProvider({ ownAwareness: true }, (open) => { provider = open; });
	assert.equal((provider! as unknown as { awarenessCheckTimer: unknown }).awarenessCheckTimer, null);
});

await s.done();
