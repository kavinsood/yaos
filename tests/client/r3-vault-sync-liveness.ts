import { strict as assert } from "node:assert";
import {
	SOCKET_CONTROL_CAPABILITIES,
	SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR,
	SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
	SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE,
	SOCKET_LIVENESS_DESCRIPTOR,
} from "../../server/src/shared/socketLiveness";
import { SocketLivenessCoordinator } from "../../src/runtime/socketLivenessCoordinator";
import { VaultSync, type SyncProviderPort } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture";
import { suite } from "../harness.ts";

const s = suite("r3-vault-sync-liveness");

interface FocusedSync {
	registerSocketLiveness(documentId: string, provider: SyncProviderPort): void;
	handleVaultControl(payload: string, documentId: string, provider: SyncProviderPort): void;
}

for (const autoResponse of [false, true]) {
	s.test(`VaultSync sends a single transport prefix and accepts only negotiated replies: AR=${autoResponse}`, () => {
		const messages: string[] = [];
		const provider = partialOf<SyncProviderPort>({
			wsconnected: true, ws: { readyState: 1 },
			sendMessage: (payload) => messages.push(`__YPS:${payload}`),
		});
		const coordinator = new SocketLivenessCoordinator({ now: () => 0,
			setTimer: () => 1, clearTimer: () => {} }, () => "r3-probe");
		const runtime = Object.create(VaultSync.prototype) as FocusedSync;
		const socketSessions = new WeakMap([[provider, { id: "session-r3", runtimeEpoch: "runtime-r3" }]]);
		Object.defineProperties(runtime, {
			socketLiveness: { value: coordinator }, socketSessions: { value: socketSessions },
			options: { value: { vaultGeneration: "generation-r3" } },
			_rootEpoch: { value: 1 }, _rootGeneration: { value: 0, writable: true },
		});
		runtime.registerSocketLiveness("root", provider);
		coordinator.connected("root");
		runtime.handleVaultControl(JSON.stringify({ type: "VAULT_READY", documentId: "root",
			documentEpoch: 1, vaultGeneration: "generation-r3", durableGeneration: 0,
			socketSessionId: "session-r3", runtimeEpoch: "runtime-r3", capabilities: SOCKET_CONTROL_CAPABILITIES,
			liveness: autoResponse ? SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR : SOCKET_LIVENESS_DESCRIPTOR,
		}), "root", provider);
		assert.equal(coordinator.snapshot()[0]?.phase, "healthy");
		runtime.handleVaultControl(SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE.slice(6), "root", provider);
		assert.equal(coordinator.snapshot()[0]?.phase, "healthy");
		coordinator.probeNow("r3-integration");
		assert.deepEqual(messages, [autoResponse ? SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST
			: '__YPS:{"type":"VAULT_PING","probeId":"r3-probe"}']);
		for (const payload of [
			`${SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE.slice(6)} `,
			'{"v":1,"type":"VAULT_PONG_AR"}',
			'{"type":"VAULT_PONG_AR","v":2}',
			'{"type":"VAULT_PONG_AR","v":1,"extra":true}',
		]) {
			runtime.handleVaultControl(payload, "root", provider);
			assert.equal(coordinator.snapshot()[0]?.phase, "probing");
		}
		const legacy = JSON.stringify({ type: "VAULT_PONG", probeId: "r3-probe", documentId: "root",
			documentEpoch: 1, vaultGeneration: "generation-r3", runtimeEpoch: "runtime-r3" });
		if (autoResponse) {
			runtime.handleVaultControl(legacy, "root", provider);
			assert.equal(coordinator.snapshot()[0]?.phase, "probing");
			socketSessions.delete(provider);
			runtime.handleVaultControl(SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE.slice(6), "root", provider);
			assert.equal(coordinator.snapshot()[0]?.phase, "probing");
			socketSessions.set(provider, { id: "session-r3", runtimeEpoch: "runtime-r3" });
			runtime.handleVaultControl(SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE.slice(6), "root", provider);
		} else {
			runtime.handleVaultControl(SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE.slice(6), "root", provider);
			assert.equal(coordinator.snapshot()[0]?.phase, "probing");
			runtime.handleVaultControl(legacy, "root", provider);
		}
		assert.equal(coordinator.snapshot()[0]?.phase, "healthy");
		assert.equal(socketSessions.get(provider)?.runtimeEpoch, "runtime-r3");
	});
}

await s.done();
