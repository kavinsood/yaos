import { strict as assert } from "node:assert";
import * as encoding from "lib0/encoding";
import { NodeSocketHub, NodeSocketRegistry } from "../../packages/server-node/src/socketHost";
import type { NodeServerSocket, NodeServerSocketListener } from "../../packages/server-node/src/transport";
import { ywasmCrdtEngine as engine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import {
	SOCKET_CLIENT_CAPABILITY_AUTO_RESPONSE,
	SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR,
	SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
	SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE,
	SOCKET_LIVENESS_DESCRIPTOR,
	negotiateSocketLiveness,
	parseSocketClientCapabilities,
	parseSocketLivenessDescriptor,
} from "../../server/src/shared/socketLiveness";
import {
	VaultSocketService,
	parseVaultSocketAttachment,
	type SocketServiceOptions,
	type VaultSocketAttachment,
} from "../../server/src/vaultSocketService";
import { suite } from "../harness.ts";

const checks = suite("r3-socket-auto-response");

class WireSocket implements NodeServerSocket {
	readyState = 1;
	readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	readonly listeners = new Map<string, NodeServerSocketListener>();
	accept(): void {}
	send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(data); }
	close(code?: number, reason?: string): void { this.closes.push({ code, reason }); this.readyState = 2; }
	addEventListener(type: string, listener: NodeServerSocketListener): void { this.listeners.set(type, listener); }
	removeEventListener(type: string): void { this.listeners.delete(type); }
	message(data: string | ArrayBuffer): void { this.listeners.get("message")?.({ data }); }
}

const admission: VaultSocketAttachment = {
	vaultId: "vault-r3-test-0001", vaultGeneration: "generation-r3", runtimeEpoch: "runtime-r3",
	documentId: "root", kind: "root", documentEpoch: 1, deviceId: "device-r3", principalId: "principal-r3",
	membershipRevision: 1, deviceCredentialRevision: 1, role: "member", policyVersion: 1,
	capabilityDigest: "digest-r3", socketId: "socket-r3", lastSeenTouchedAt: 0,
	livenessAutoResponse: true, catchUpHint: true,
};

function connectedHost() {
	const hub = new NodeSocketHub();
	const dispatched: Array<string | ArrayBuffer> = [];
	const registry = new NodeSocketRegistry(hub, {
		message: (_socket, message) => dispatched.push(message), close: () => {}, error: () => {},
	});
	const pair = registry.createPair();
	pair.server.serializeAttachment({ ...admission });
	registry.accept(pair.server);
	const wire = new WireSocket();
	void hub.takeUpgrade(registry.upgradeResponse(pair.client))!.connected(wire);
	return { registry, socket: pair.server, wire, dispatched };
}

function serviceOptions(registry: NodeSocketRegistry, overrides: Partial<SocketServiceOptions> = {}): SocketServiceOptions {
	return {
		crdtEngine: engine, sockets: registry,
		cache: { load: () => { throw new Error("liveness must not hydrate documents"); }, get: () => undefined } as never,
		vaultId: () => admission.vaultId, vaultGeneration: () => admission.vaultGeneration,
		runtimeEpoch: admission.runtimeEpoch, isActiveBody: () => true,
		currentRootEpoch: () => 1,
		currentBodyHead: (bodyId) => ({ bodyId, bodyEpoch: 1, lifecycle: "active", generation: 4,
			contentHash: "a".repeat(64), size: 2, sequence: 9 }),
		currentSequence: () => 9, validateActor: () => true, principalPresence: () => null,
		scheduleFlush: () => { throw new Error("liveness must not flush"); }, ...overrides,
	};
}

checks.test("exact text ping replies 100 times without runtime dispatch, attachment writes, or touches", () => {
	const host = connectedHost();
	const before = host.socket.deserializeAttachment();
	assert.equal(host.registry.supportsAutoResponse(), true);
	assert.equal(host.registry.getAutoResponseTimestamp(host.socket), null);
	const started = Date.now();
	for (let index = 0; index < 100; index++) host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
	assert.deepEqual(host.wire.sent, Array.from({ length: 100 }, () => SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE));
	assert.deepEqual(host.dispatched, []);
	assert.equal(host.socket.deserializeAttachment(), before);
	assert.ok(host.registry.getAutoResponseTimestamp(host.socket)! >= started);
	assert.deepEqual(host.wire.closes, []);
});

checks.test("binary bytes, whitespace, extra keys, wrong version and double prefix never auto-reply", () => {
	const host = connectedHost();
	const frames = [
		`${SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST} `,
		'__YPS:{"v":1,"type":"VAULT_PING_AR"}',
		'__YPS:{"type":"VAULT_PING_AR","v":2}',
		'__YPS:{"type":"VAULT_PING_AR","v":1,"extra":true}',
		`__YPS:${SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST}`,
		'__YPS:{"type":"VAULT_PING","probeId":"legacy"}',
		new TextEncoder().encode(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST).slice().buffer,
	];
	for (const frame of frames) host.wire.message(frame);
	assert.deepEqual(host.dispatched, frames);
	assert.deepEqual(host.wire.sent, []);
	assert.equal(host.registry.getAutoResponseTimestamp(host.socket), null);
});

checks.test("revocation actively closes AR sockets with 4403; host cannot answer further pings", () => {
	for (const fence of ["device", "principal"] as const) {
		const host = connectedHost();
		host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
		const service = new VaultSocketService(serviceOptions(host.registry));
		assert.equal(fence === "device" ? service.closeDevice(admission.deviceId)
			: service.closePrincipal(admission.principalId), 1);
		assert.equal(host.wire.closes[0]?.code, 4403);
		const count = host.wire.sent.length;
		host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
		assert.equal(host.wire.sent.length, count);
		assert.deepEqual(host.dispatched, []);
	}
});

checks.test("AR pong survives wake but first real sync frame still fences the stale runtime", async () => {
	const host = connectedHost();
	const service = new VaultSocketService(serviceOptions(host.registry, { runtimeEpoch: "runtime-after-wake" }));
	host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
	assert.deepEqual(host.dispatched, []);
	const realFrame = new Uint8Array([0, 0]).buffer;
	host.wire.message(realFrame);
	await service.message(host.socket, host.dispatched[0]!);
	assert.deepEqual(host.wire.closes, [{ code: 1008, reason: "socket authority mismatch" }]);
	assert.equal(host.wire.sent[0], SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE);
});

checks.test("wake still sends receipt-free BODY_CHANGED_HINT, never an AR durability receipt", () => {
	const host = connectedHost();
	new VaultSocketService(serviceOptions(host.registry, { runtimeEpoch: "runtime-after-wake" }))
		.notifyBodyCommitted("body-r3", 4, 9);
	const hint = host.wire.sent[0];
	assert.ok(typeof hint === "string");
	assert.deepEqual(JSON.parse(hint.slice(6)) as unknown, {
		type: "BODY_CHANGED_HINT", bodyId: "body-r3", bodyEpoch: 1,
		vaultGeneration: admission.vaultGeneration, durableGeneration: 4, vaultSequence: 9,
	});
	assert.deepEqual(host.wire.closes, []);
});

checks.test("AR timestamps cause only coalesced root touches on authorized real frames", async () => {
	const host = connectedHost();
	let now = Date.now() + 1;
	let touches = 0;
	const service = new VaultSocketService(serviceOptions(host.registry, {
		touchDevice: () => { touches++; }, now: () => now,
	}));
	const query = '__YPS:{"type":"BODY_CURRENTNESS_QUERY","queryId":"r3-query","bodyIds":["body-r3"]}';
	await service.message(host.socket, query);
	assert.equal(touches, 0);
	host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
	assert.equal(touches, 0);
	await service.message(host.socket, query);
	assert.equal(touches, 1);
	assert.equal(parseVaultSocketAttachment(host.socket.deserializeAttachment())!.lastSeenTouchedAt, now);
	now += 60_000;
	await service.message(host.socket, query);
	assert.equal(touches, 1);
	now += 5 * 60_000;
	await service.message(host.socket, query);
	assert.equal(touches, 1, "the same old AR timestamp cannot keep touching forever");
	let autoResponseAt = now;
	host.registry.getAutoResponseTimestamp = () => autoResponseAt;
	await service.message(host.socket, query);
	assert.equal(touches, 2, "new AR activity becomes one touch on the next real frame");
	now += 60_000;
	autoResponseAt = now;
	await service.message(host.socket, query);
	assert.equal(touches, 2, "a new AR timestamp still obeys the resolution window");
	now += 5 * 60_000;
	await service.message(host.socket, query);
	assert.equal(touches, 3);
	host.socket.serializeAttachment({ ...admission, kind: "body", documentId: "body-r3" });
	await service.message(host.socket, query);
	assert.equal(touches, 3, "body sockets never touch");
	host.socket.serializeAttachment({ ...admission });
	await new VaultSocketService(serviceOptions(host.registry, { validateActor: () => false,
		touchDevice: () => { touches++; }, now: () => now })).message(host.socket, query);
	assert.equal(touches, 3, "unauthorized activity never touches");
	assert.equal(host.wire.closes[0]?.code, 4403);
});

checks.test("first real awareness after wake preserves the touch timestamp through attachment rewrites", async () => {
	const host = connectedHost();
	host.wire.message(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
	const now = Date.now() + 1;
	let touches = 0;
	const service = new VaultSocketService(serviceOptions(host.registry, {
		runtimeEpoch: "runtime-after-wake", now: () => now,
		touchDevice: () => { touches++; },
		principalPresence: () => ({ displayName: "R3", colorSeed: "r3" }),
	}));
	const update = encoding.createEncoder();
	encoding.writeVarUint(update, 1);
	encoding.writeVarUint(update, 42);
	encoding.writeVarUint(update, 1);
	encoding.writeVarString(update, '{"cursor":null}');
	const frame = encoding.createEncoder();
	encoding.writeVarUint(frame, 1);
	encoding.writeVarUint8Array(frame, encoding.toUint8Array(update));
	await service.message(host.socket, encoding.toUint8Array(frame).slice().buffer);
	const current = parseVaultSocketAttachment(host.socket.deserializeAttachment())!;
	assert.equal(current.lastSeenTouchedAt, now);
	assert.equal(current.awarenessClientId, 42);
	assert.equal(current.awarenessClock, 1);
	assert.equal(touches, 1);
	assert.deepEqual(host.wire.closes, []);
});

for (const clientCapable of [false, true]) {
	for (const hostCapable of [false, true]) {
		checks.test(`admission advertises AR iff caps and installed host agree: client=${clientCapable} host=${hostCapable}`, () => {
			const host = connectedHost();
			const document = engine.createDocument("r3-admission");
			try {
				const options = serviceOptions(host.registry, {
					cache: { load: () => ({ semanticEpoch: 1, generation: 1, doc: document }) } as never,
				});
				options.sockets = {
					sockets: () => [], createPair: () => ({ client: {}, server: host.socket }), accept: () => {},
					upgradeResponse: () => new Response(), ...(hostCapable ? { supportsAutoResponse: () => true } : {}),
				};
				const capabilities = parseSocketClientCapabilities(clientCapable ? SOCKET_CLIENT_CAPABILITY_AUTO_RESPONSE : null);
				new VaultSocketService(options).accept("root", "root", 1, admission.deviceId, { capabilities });
				const readyFrame = host.wire.sent.find((frame): frame is string => typeof frame === "string");
				assert.ok(readyFrame);
				const ready = JSON.parse(readyFrame.slice(6)) as { liveness: unknown };
				const expected = clientCapable && hostCapable ? SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR : SOCKET_LIVENESS_DESCRIPTOR;
				assert.deepEqual(ready.liveness, expected);
				assert.deepEqual(negotiateSocketLiveness(capabilities, hostCapable), expected);
				assert.equal(parseVaultSocketAttachment(host.socket.deserializeAttachment())!.livenessAutoResponse,
					clientCapable && hostCapable ? true : undefined);
			} finally { engine.destroyDocument(document); }
		});
	}
}

checks.test("only the exact advertised descriptor enables AR; unknown descriptors fall back to legacy", () => {
	assert.deepEqual(parseSocketLivenessDescriptor(SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR), SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR);
	for (const autoResponse of [null, [], { version: 2 }, { ...SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR.autoResponse,
		request: `${SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST} ` }]) {
		assert.deepEqual(parseSocketLivenessDescriptor({ ...SOCKET_LIVENESS_DESCRIPTOR, autoResponse }), SOCKET_LIVENESS_DESCRIPTOR);
	}
	assert.equal(parseVaultSocketAttachment({ ...admission, livenessAutoResponse: "yes" }), null);
});

await checks.done();
