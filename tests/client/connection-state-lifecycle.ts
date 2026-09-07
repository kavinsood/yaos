import {
	ConnectionController,
	ConnectionStateLatch,
	type ConnectionState,
} from "../../src/runtime/connectionController";
import type { VaultSync } from "../../src/sync/vaultSync";
import { getLabelFromConnectionState } from "../../src/status/statusBarController";
import { suite } from "../harness.ts";

const s = suite("connection-state-lifecycle");

s.section("Terminal startup failure survives periodic live-state refresh");
{
	const latch = new ConnectionStateLatch();
	const failure = {
		phase: "schema" as const,
		message: "Room schema is newer than this plugin",
	};
	latch.failInitialization(failure);

	const periodicStates: ConnectionState[] = [
		{ kind: "loading_cache" },
		{ kind: "offline", reason: "provider_disconnected", generation: 4 },
		{ kind: "online", generation: 5 },
	];
	for (const liveState of periodicStates) {
		const visible = latch.resolve(liveState);
		s.check(visible.kind === "error", `periodic ${liveState.kind} refresh cannot overwrite terminal Error`);
		s.check(
			visible.kind === "error"
			&& visible.details?.phase === "schema"
			&& visible.details.message === failure.message,
			`periodic ${liveState.kind} refresh retains rich schema failure details`,
		);
		s.check(
			getLabelFromConnectionState(visible) === "YAOS: Error",
			`periodic ${liveState.kind} refresh still renders terminal Error status`,
		);
	}
}

s.section("New initialization and successful recovery clear terminal failure");
{
	const latch = new ConnectionStateLatch();
	latch.failInitialization({
		phase: "initialization",
		message: "Local initialization failed",
	});
	s.check(latch.resolve({ kind: "disconnected" }).kind === "error", "initialization failure is terminal for its attempt");

	latch.beginInitialization();
	const retryState = latch.resolve({ kind: "loading_cache" });
	s.check(retryState.kind === "loading_cache", "starting a new initialization attempt clears the prior terminal state");

	latch.failInitialization({
		phase: "initialization",
		message: "Retry failed",
	});
	s.check(latch.resolve({ kind: "online", generation: 7 }).kind === "error", "retry failure latches independently");

	latch.recover();
	const recoveredState = latch.resolve({ kind: "online", generation: 8 });
	s.check(recoveredState.kind === "online", "successful recovery clears terminal failure");
	s.check(
		recoveredState.kind === "online" && recoveredState.generation === 8,
		"successful recovery exposes the current rich connection state",
	);
}

type ConnectionStateSyncFixture = Pick<VaultSync,
	| "fatalAuthError"
	| "fatalAuthCode"
	| "idbError"
	| "localReady"
	| "connected"
	| "websocketOpen"
	| "applicationResponsive"
	| "connectionGeneration"
> & { provider: Pick<VaultSync["provider"], "wsconnecting"> };

function controllerState(sync: ConnectionStateSyncFixture, reconciled: boolean): ConnectionState {
	return new ConnectionController({
		// @ts-expect-error This focused fixture supplies only the fields getState reads.
		getVaultSync: () => sync,
		isReconciled: () => reconciled,
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
	}).getState();
}

s.section("Application handshake is visible as connecting");
{
	const base = {
		fatalAuthError: false,
		fatalAuthCode: null,
		idbError: false,
		localReady: true,
		connected: false,
		websocketOpen: true,
		applicationResponsive: null,
		connectionGeneration: 3,
		provider: { wsconnecting: false },
	} satisfies ConnectionStateSyncFixture;

	s.check(controllerState(base, true).kind === "connecting", "open transport awaiting VAULT_READY is connecting");
	s.check(controllerState(base, false).kind === "connecting", "handshake stays connecting before reconciliation");
	const failed = { ...base, applicationResponsive: false } satisfies ConnectionStateSyncFixture;
	s.check(controllerState(failed, true).kind === "offline", "failed application liveness is offline");
}

await s.done();
