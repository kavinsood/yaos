import { strict as assert } from "node:assert";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import { fencedWebSocketConstructor } from "../../src/sync/fencedWebSocket";
import { suite } from "../harness.ts";

class FakeWebSocket {
	static last: FakeWebSocket | null = null;
	readyState = 1;
	binaryType: BinaryType = "arraybuffer";
	readonly listeners = new Map<string, Set<EventListener>>();
	closed = 0;
	terminated = 0;
	sent: unknown[] = [];
	constructor(readonly url: string | URL) { FakeWebSocket.last = this; }
	send(value: unknown): void { this.sent.push(value); }
	close(): void { this.closed++; this.readyState = 2; }
	terminate(): void { this.terminated++; this.readyState = 3; }
	addEventListener(type: string, listener: EventListener): void {
		const values = this.listeners.get(type) ?? new Set<EventListener>();
		values.add(listener);
		this.listeners.set(type, values);
	}
	removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
	emit(type: string): void {
		const listeners = this.listeners.get(type) ?? [];
		if (type === "error" && [...listeners].length === 0) throw new Error("unhandled websocket error");
		for (const listener of listeners) listener(new Event(type));
	}
	emitClose(code: number, reason: string): void {
		for (const listener of this.listeners.get("close") ?? []) {
			listener({ type: "close", code, reason } as unknown as Event);
		}
	}
}

const s = suite("fenced-websocket");

s.test("force termination closes provider state synchronously and fences late native events", () => {
	// @ts-expect-error FakeWebSocket intentionally implements only the provider-used WebSocket surface.
	const Constructor = fencedWebSocketConstructor(FakeWebSocket);
	const socket = new Constructor("ws://example.test") as WebSocket & { terminate(): void };
	const events: string[] = [];
	socket.addEventListener("close", () => {
		events.push("close");
		socket.terminate();
	});
	socket.addEventListener("message", () => events.push("message"));
	socket.close();
	socket.terminate();
	assert.deepEqual(events, ["close"]);
	assert.equal(socket.readyState, 3);
	FakeWebSocket.last!.emit("message");
	assert.doesNotThrow(() => FakeWebSocket.last!.emit("error"), "native teardown errors remain handled after provider listeners are fenced");
	FakeWebSocket.last!.emit("close");
	assert.deepEqual(events, ["close"]);
	assert.equal(FakeWebSocket.last!.terminated, 1);
});

s.test("native application close survives a lost provider control frame", () => {
	let close: { code: number; reason: string } | null = null;
	// @ts-expect-error FakeWebSocket intentionally implements only the provider-used WebSocket surface.
	const Constructor = fencedWebSocketConstructor(FakeWebSocket, (event) => { close = event; });
	new Constructor("ws://example.test");
	FakeWebSocket.last!.emitClose(4403, "device authority changed");
	assert.deepEqual(close, { code: 4403, reason: "device authority changed" });
});

s.test("the provider owns exactly one custom-message prefix", async () => {
	const hostWindow = window as Window & {
		addEventListener: Window["addEventListener"];
		removeEventListener: Window["removeEventListener"];
	};
	const originalAdd = hostWindow.addEventListener;
	const originalRemove = hostWindow.removeEventListener;
	hostWindow.addEventListener = (() => {}) as Window["addEventListener"];
	hostWindow.removeEventListener = (() => {}) as Window["removeEventListener"];
	// @ts-expect-error FakeWebSocket intentionally implements only the provider-used WebSocket surface.
	const Constructor = fencedWebSocketConstructor(FakeWebSocket);
	const doc = new Y.Doc();
	try {
		const provider = new YSyncProvider("example.test", "root", doc, {
			connect: false,
			WebSocketPolyfill: Constructor,
		});
		await provider.connect();
		FakeWebSocket.last!.emit("open");
		const payload = JSON.stringify({ type: "VAULT_PING", probeId: "probe-prefix" });
		provider.sendMessage(payload);
		assert.deepEqual(
			FakeWebSocket.last!.sent.filter((value): value is string => typeof value === "string"),
			[`__YPS:${payload}`],
		);
		const binaryBeforeUpdate = FakeWebSocket.last!.sent.filter((value) => typeof value !== "string").length;
		doc.getText("body").insert(0, "live update");
		assert.equal(
			FakeWebSocket.last!.sent.filter((value) => typeof value !== "string").length,
			binaryBeforeUpdate + 1,
			"provider broadcastMessage recognizes the instance OPEN constant",
		);
		provider.destroy();
	} finally {
		hostWindow.addEventListener = originalAdd;
		hostWindow.removeEventListener = originalRemove;
		doc.destroy();
	}
});

await s.done();
