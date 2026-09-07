import { strict as assert } from "node:assert";
import {
	SOCKET_LIVENESS_DESCRIPTOR,
	SOCKET_LIVENESS_TIMEOUT_MS,
} from "../../server/src/shared/socketLiveness";
import {
	SocketLivenessCoordinator,
	type SocketLivenessClock,
} from "../../src/runtime/socketLivenessCoordinator";
import { suite } from "../harness.ts";

class ManualClock implements SocketLivenessClock {
	nowValue = 0;
	sequence = 0;
	timers = new Map<number, { at: number; callback: () => void }>();
	now(): number { return this.nowValue; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { at: this.nowValue + delayMs, callback });
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void {
		this.nowValue += ms;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.nowValue)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

const s = suite("socket-liveness-coordinator");

s.test("an exact acknowledgement renews one quiet connection", () => {
	const clock = new ManualClock();
	const probes: string[] = [];
	const failures: string[] = [];
	const ids = ["probe-1", "probe-2"];
	const coordinator = new SocketLivenessCoordinator(clock, () => ids.shift()!);
	coordinator.register({
		id: "root", documentId: "root", isOpen: () => true,
		sendProbe: (probeId) => probes.push(probeId),
		onFailure: (reason) => failures.push(reason),
	});
	coordinator.connected("root");
	coordinator.ready("root", SOCKET_LIVENESS_DESCRIPTOR, "runtime-1");
	clock.advance(SOCKET_LIVENESS_DESCRIPTOR.idleMs);
	assert.deepEqual(probes, ["probe-1"]);
	assert.equal(coordinator.acknowledge("root", "wrong", "runtime-1"), false);
	assert.equal(coordinator.acknowledge("root", "probe-1", "runtime-1"), true);
	assert.equal(coordinator.snapshot()[0]?.phase, "healthy");
	clock.advance(SOCKET_LIVENESS_DESCRIPTOR.idleMs);
	assert.deepEqual(probes, ["probe-1", "probe-2"]);
	assert.deepEqual(failures, []);
});

s.test("a missing acknowledgement fails once and stale timers stay fenced", () => {
	const clock = new ManualClock();
	const failures: string[] = [];
	const coordinator = new SocketLivenessCoordinator(clock, () => "probe-timeout");
	coordinator.register({
		id: "root", documentId: "root", isOpen: () => true,
		sendProbe: () => {}, onFailure: (reason) => failures.push(reason),
	});
	coordinator.connected("root");
	coordinator.ready("root", SOCKET_LIVENESS_DESCRIPTOR, "runtime-1");
	coordinator.probeNow("test");
	clock.advance(SOCKET_LIVENESS_DESCRIPTOR.timeoutMs);
	assert.deepEqual(failures, ["probe_timeout"]);
	assert.equal(coordinator.snapshot()[0]?.phase, "failed");
	clock.advance(SOCKET_LIVENESS_DESCRIPTOR.timeoutMs * 10);
	assert.deepEqual(failures, ["probe_timeout"]);
});

s.test("background suspension cannot manufacture a timeout", () => {
	const clock = new ManualClock();
	const probes: string[] = [];
	const failures: string[] = [];
	let sequence = 0;
	const coordinator = new SocketLivenessCoordinator(clock, () => `probe-${++sequence}`);
	coordinator.register({
		id: "root", documentId: "root", isOpen: () => true,
		sendProbe: (probeId) => probes.push(probeId), onFailure: (reason) => failures.push(reason),
	});
	coordinator.connected("root");
	coordinator.ready("root", SOCKET_LIVENESS_DESCRIPTOR, "runtime-1");
	coordinator.probeNow("before-background");
	coordinator.setForeground(false);
	clock.advance(SOCKET_LIVENESS_DESCRIPTOR.timeoutMs * 100);
	assert.deepEqual(failures, []);
	assert.equal(coordinator.snapshot()[0]?.phase, "suspended");
	coordinator.setForeground(true);
	assert.deepEqual(probes, ["probe-1", "probe-2"]);
	assert.equal(coordinator.snapshot()[0]?.phase, "probing");
});

s.test("an open socket must receive VAULT_READY within the handshake deadline", () => {
	const clock = new ManualClock();
	const failures: string[] = [];
	const coordinator = new SocketLivenessCoordinator(clock);
	coordinator.register({
		id: "root", documentId: "root", isOpen: () => true,
		sendProbe: () => {}, onFailure: (reason) => failures.push(reason),
	});
	coordinator.connected("root");
	clock.advance(SOCKET_LIVENESS_TIMEOUT_MS - 1);
	assert.deepEqual(failures, []);
	clock.advance(1);
	assert.deepEqual(failures, ["ready_timeout"]);
	assert.equal(coordinator.snapshot()[0]?.phase, "failed");
	assert.equal(coordinator.snapshot()[0]?.timeoutCount, 1);
});

s.test("background time does not consume the VAULT_READY handshake deadline", () => {
	const clock = new ManualClock();
	const failures: string[] = [];
	const coordinator = new SocketLivenessCoordinator(clock);
	coordinator.register({
		id: "root", documentId: "root", isOpen: () => true,
		sendProbe: () => {}, onFailure: (reason) => failures.push(reason),
	});
	coordinator.connected("root");
	coordinator.setForeground(false);
	clock.advance(SOCKET_LIVENESS_TIMEOUT_MS * 100);
	assert.deepEqual(failures, []);
	coordinator.setForeground(true);
	clock.advance(SOCKET_LIVENESS_TIMEOUT_MS);
	assert.deepEqual(failures, ["ready_timeout"]);
});

await s.done();
