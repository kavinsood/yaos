import { ConnectionController } from "../../src/runtime/connectionController";
import { getFatalSyncNotice } from "../../src/runtime/fatalSyncNotice";
import { getLabelFromConnectionState } from "../../src/status/statusBarController";
import { parseFatalAuthMessage } from "../../src/sync/fatalAuth";
import type { VaultSync } from "../../src/sync/vaultSync";
import { readSource, suite } from "../harness.ts";

const s = suite("fatal-auth-state");

s.section("Unsupported server configuration is a recognized terminal auth frame");
{
	const parsed = parseFatalAuthMessage(JSON.stringify({
		type: "error",
		code: "server_format_unsupported",
		reason: "config_format_mismatch",
	}));
	s.check(parsed?.code === "server_format_unsupported", "parser accepts server_format_unsupported");
	s.check(parsed?.reason === "config_format_mismatch", "parser preserves the server reason");
	s.check(
		parseFatalAuthMessage(JSON.stringify({ type: "error", code: "invented_fatal_code" })) === null,
		"parser still rejects codes outside the fatal allowlist",
	);
}

s.section("Unsupported format is terminal and visible");
{
	let disconnects = 0;
	let reconnects = 0;
	const sync: VaultSync = {
		fatalAuthError: true,
		fatalAuthCode: "server_format_unsupported",
		fatalAuthDetails: {
			clientSchemaVersion: null,
			roomSchemaVersion: null,
			reason: "config_format_mismatch",
		},
		idbError: false,
		idbErrorDetails: null,
		localReady: true,
		connected: false,
		connectionGeneration: 1,
		// @ts-expect-error focused state test supplies only provider connection controls.
		provider: {
			disconnect: () => { disconnects++; },
			connect: async () => { reconnects++; },
		},
	};
	const controller = new ConnectionController({
		getVaultSync: () => sync,
		isReconciled: () => false,
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
	const state = controller.getState();
	s.check(
		state.kind === "auth_failed" && state.code === "server_format_unsupported",
		"connection state retains the unsupported-format code",
	);
	controller.reconnect("test");
	s.check(disconnects === 0 && reconnects === 0, "terminal unsupported format blocks reconnect attempts");
	s.check(
		getLabelFromConnectionState({ kind: "auth_failed", code: "server_format_unsupported" }) ===
			"YAOS: Server format unsupported",
		"status bar names the unsupported server format",
	);
	const notice = getFatalSyncNotice("server_format_unsupported", sync.fatalAuthDetails);
	s.check(/unsupported configuration format/.test(notice.message), "notice explains the unsupported configuration format");
	s.check(/server console/.test(notice.message), "notice gives a dedicated server-console action");
}

s.test("manual reconnect delegates to the unified runtime admission owner", async () => {
	let runtimeReconnects = 0;
	let directConnects = 0;
	let directDisconnects = 0;
	const sync = {
		fatalAuthError: false,
		fatalAuthCode: null,
		fatalAuthDetails: null,
		idbError: false,
		idbErrorDetails: null,
		localReady: true,
		connected: false,
		connectionGeneration: 1,
		reconnect: async () => {
			runtimeReconnects++;
			return { kind: "completed", value: undefined } as const;
		},
		provider: {
			disconnect: () => { directDisconnects++; },
			connect: () => { directConnects++; },
		},
	};
	const controller = new ConnectionController({
		// @ts-expect-error This focused fixture supplies only the fields used by reconnect.
		getVaultSync: () => sync,
		isReconciled: () => false,
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
	controller.reconnect("manual-test");
	await Promise.resolve();
	s.check(runtimeReconnects === 1, "manual reconnect reaches one runtime admission attempt");
	s.check(directConnects === 0 && directDisconnects === 0, "connection controller never manipulates provider transport directly");
});

s.section("Fatal auth stops ticket refresh lifecycle");
{
	const source = readSource("src/sync/vaultSync.ts");
	s.check(source.includes("this.setFatalAuth(fatal.code, fatal.details)"), "parsed fatal code is stored on VaultSync");
	s.check(
		source.includes('this.workScheduler.queueReconnect("ticket-refresh-due"') &&
		source.includes("this.destroyed || this.fatalAuthError") &&
		!source.includes("ticketRefreshTimer"),
		"fatal auth gates scheduler-owned proactive ticket refresh",
	);
	s.check(
		source.includes('status === "disconnected" && !this.fatalAuthError'),
		"fatal disconnect cannot trigger a best-effort ticket refresh",
	);
}

await s.done();
