import { strict as assert } from "node:assert";
import { ConnectionController } from "../../src/runtime/connectionController";
import type { VaultSync } from "../../src/sync/vaultSync";
import { deriveSyncFacts } from "../../src/runtime/connectionFacts";
import { getLabelFromConnectionState, renderConnectionState } from "../../src/status/statusBarController";
import { suite } from "../harness.ts";

const checks = suite("G6-status-liveness");

function fixture() {
	const events: string[] = [];
	const sync = {
		fatalAuthError: false,
		fatalAuthCode: null,
		idbError: false,
		localReady: true,
		connected: false,
		websocketOpen: true,
		applicationResponsive: null as boolean | null,
		connectionGeneration: 4,
		provider: { wsconnecting: false, synced: true, on: () => {} },
		setReconnectRequester: () => {},
		setReconnectBlocked: () => {},
		onProviderSync: () => {},
		setSocketLivenessForeground: (foreground: boolean) => events.push(`foreground:${foreground}`),
		probeSocketLiveness: (reason: string) => events.push(`probe:${reason}`),
		pokeOverdueWork: () => {},
		queueReconnect: async () => {},
	};
	const controller = new ConnectionController({
		getVaultSync: () => sync as unknown as VaultSync,
		isReconciled: () => true,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastReconciledGeneration: () => 0,
		setReconnectPending: () => {},
		isReconcileInFlight: () => false,
		runReconnectReconciliation: () => {},
		refreshServerCapabilities: () => {},
		flushOpenWrites: (reason: string) => events.push(`flush:${reason}`),
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		trace: (() => {}) as never,
		registerCleanup: () => {},
	});
	return { controller, sync, events };
}

checks.test("suspended liveness with an open synced provider renders Connected", () => {
	const { controller } = fixture();
	assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Connected");
});

checks.test("an actual failed probe downgrades even an open synced provider", () => {
	const { controller, sync } = fixture();
	sync.applicationResponsive = false;
	assert.equal(getLabelFromConnectionState(controller.getState()), "YAOS: Offline");
	sync.connected = true;
	assert.equal(controller.getState().kind, "offline");
});

checks.test("an explicitly unknown responsiveness fact never fabricates an acknowledgement", () => {
	const facts = deriveSyncFacts({
		connected: true,
		websocketOpen: true,
		applicationResponsive: null,
		fatalAuthError: false,
		fatalAuthCode: null,
		lastLocalUpdateAt: null,
		lastLocalUpdateWhileConnectedAt: null,
		lastRemoteUpdateAt: null,
		pendingBlobUploads: 0,
		pendingAttachmentPublications: 0,
		attachmentReconciliationPending: false,
		permanentAttachmentTransferFailures: 0,
		fatalAttachmentPublications: 0,
	}, "online");
	assert.equal(facts.applicationResponsive, null);
	assert.equal(facts.lastLivenessAckAt, null);
	assert.equal(facts.serverReceipt, null);
});

checks.test("a closed socket is offline and an unsynced handshake stays Connecting", () => {
	const { controller, sync } = fixture();
	sync.websocketOpen = false;
	assert.equal(controller.getState().kind, "offline");
	sync.websocketOpen = true;
	sync.provider.synced = false;
	assert.equal(controller.getState().kind, "connecting");
});

checks.test("visibility retains Connected and requests an immediate foreground probe", () => {
	const { controller, events } = fixture();
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const documentTarget = new EventTarget();
	const windowTarget = new EventTarget();
	const documentFixture = Object.assign(documentTarget, { visibilityState: "visible" });
	Object.defineProperty(globalThis, "document", { configurable: true, value: documentFixture });
	Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
	try {
		controller.start();
		documentFixture.visibilityState = "hidden";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		assert.ok(events.includes("foreground:false"));
		assert.ok(events.includes("flush:app-backgrounded"));
		assert.equal(controller.getState().kind, "online");
		documentFixture.visibilityState = "visible";
		documentTarget.dispatchEvent(new Event("visibilitychange"));
		assert.deepEqual(events.filter((event) => event.startsWith("probe:")), ["probe:app-foregrounded"]);
		assert.equal(controller.getState().kind, "online");
	} finally {
		controller.stop();
		if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});

checks.test("unavailable recovery never adds a standing status suffix or tooltip", () => {
	assert.equal(getLabelFromConnectionState({ kind: "online", generation: 4 }, null, null, 0, "unavailable"), "YAOS: Connected");
	let title = "";
	const element = {
		setText: () => {},
		setAttr: (_name: string, value: string) => { title = value; },
	} as unknown as HTMLElement;
	renderConnectionState(element, { kind: "online", generation: 4 }, null, null, 0, "unavailable");
	assert.equal(title, "");
});

await checks.done();
