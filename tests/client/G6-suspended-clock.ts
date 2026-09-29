import { strict as assert } from "node:assert";
import { VaultSync } from "../../src/sync/vaultSync";
import { ConnectionController } from "../../src/runtime/connectionController";
import { SocketLivenessCoordinator, type SocketLivenessClock } from "../../src/runtime/socketLivenessCoordinator";
import { SOCKET_LIVENESS_DESCRIPTOR } from "../../server/src/shared/socketLiveness";
import { getLabelFromConnectionState } from "../../src/status/statusBarController";
import { suite } from "../harness.ts";

class ManualClock implements SocketLivenessClock {
	time = 1_000;
	sequence = 0;
	timers = new Map<number, { at: number; callback: () => void }>();
	now(): number { return this.time; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void {
		this.time += ms;
		for (;;) {
			const due = [...this.timers.entries()].find(([, timer]) => timer.at <= this.time);
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

const checks = suite("G6-suspended-clock");

checks.test("real VaultSync getters stay Connected through three hidden minutes and fail only at the foreground probe deadline", () => {
	const clock = new ManualClock();
	const probes: string[] = [];
	const failures: string[] = [];
	const coordinator = new SocketLivenessCoordinator(clock, () => `probe-${probes.length + 1}`);
	const provider = { wsconnected: true, ws: { readyState: 1 }, wsconnecting: false, synced: true };
	const sync = Object.assign(Object.create(VaultSync.prototype) as object, {
		provider,
		socketLiveness: coordinator,
		options: { now: () => clock.now() },
		_localReady: true,
		_fatalAuthCode: null,
		_connectionGeneration: 4,
	}) as unknown as VaultSync;
	coordinator.register({
		id: "root",
		documentId: "root",
		isOpen: () => sync.websocketOpen,
		sendProbe: (probeId) => probes.push(probeId),
		onFailure: (reason) => failures.push(reason),
	});
	const controller = new ConnectionController({
		getVaultSync: () => sync,
		isReconciled: () => true,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastReconciledGeneration: () => 0,
		setReconnectPending: () => {},
		isReconcileInFlight: () => false,
		runReconnectReconciliation: () => {},
		refreshServerCapabilities: () => {},
		flushOpenWrites: () => {},
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		trace: (() => {}) as never,
		registerCleanup: () => {},
	});
	try {
		coordinator.connected("root");
		coordinator.ready("root", SOCKET_LIVENESS_DESCRIPTOR, "runtime-1");
		assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Connected");
		coordinator.setForeground(false);
		for (let minute = 0; minute < 3; minute++) {
			clock.advance(60_000);
			assert.equal(coordinator.snapshot()[0]?.phase, "suspended");
			assert.equal(sync.connected, false);
			assert.equal(sync.applicationResponsive, null);
			assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Connected");
		}
		assert.deepEqual(probes, []);
		assert.deepEqual(failures, []);
		coordinator.setForeground(true);
		coordinator.probeNow("app-foregrounded");
		assert.deepEqual(probes, ["probe-1"]);
		assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Connected");
		assert.ok(coordinator.acknowledge("root", "probe-1", "runtime-1"));
		assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Connected");
		coordinator.probeNow("test-failure");
		clock.advance(SOCKET_LIVENESS_DESCRIPTOR.timeoutMs);
		assert.deepEqual(failures, ["probe_timeout"]);
		assert.equal(sync.applicationResponsive, false);
		assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Offline");
		provider.ws.readyState = 3;
		coordinator.disconnected("root");
		assert.equal(controller.getState().kind, "offline");
	} finally {
		coordinator.stop();
	}
});

await checks.done();
