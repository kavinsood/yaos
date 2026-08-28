import type { App, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { SettingsSyncEngine } from "../../src/sync/settingsSync/engine";
import { SettingsSyncClient } from "../../src/sync/settingsSync/protocol";
import {
	loadEnvironmentAcceptance,
	markEnvironmentAccepted,
	persistApplyQueue,
	type ApplyQueueScope,
} from "../../src/sync/settingsSync/applyQueue";
import { sha256TextHex } from "../../src/utils/sha256";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto";
import { FakeIndexedDb } from "../mocks/indexedDb";
import type { SettingsDirAdapter } from "../../src/sync/settingsSync/watch";

installDomCrypto();
const s = suite("settings-sync-engine");
const emptyRemote = { seeded: true, envRev: 1, files: [], intents: [], themes: [], tombstones: [], pluginData: [] };

function response(json: unknown): RequestUrlResponse {
	return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json, text: JSON.stringify(json) };
}

function makeAdapter() {
	return {
		list: async () => ({ files: [], folders: [] }),
		read: async () => { throw new Error("missing"); },
		write: async () => undefined,
		exists: async () => false,
		mkdir: async () => undefined,
		remove: async () => undefined,
	};
}

function appFixture(
	adapter: SettingsDirAdapter,
	plugins?: NonNullable<App["plugins"]>,
): App {
	return {
		// @ts-expect-error Focused fixture adapter implements only the settings engine's filesystem port.
		vault: { configDir: ".obsidian", adapter: { ...adapter, rmdir: async () => undefined } },
		...(plugins ? { plugins } : {}),
	};
}

function settings() {
	return {
		host: "https://sync.example.test",
		deviceToken: "device-secret",
		vaultId: "vault-a",
		vaultGeneration: "generation-a",
		deviceId: "device-a",
		settingsSyncEnabled: true,
		settingsSyncAutoInstall: false,
		settingsSyncDeferred: false,
	};
}
async function acceptedScope(
	indexedDb: FakeIndexedDb,
	overrides: Partial<ApplyQueueScope> = {},
): Promise<ApplyQueueScope> {
	return {
		hostHash: await sha256TextHex(settings().host),
		vaultId: "vault-a",
		vaultGeneration: "generation-a",
		folderKey: "folder-a",
		deviceId: "device-a",
		configDirKey: ".obsidian",
		indexedDb,
		...overrides,
	};
}


s.test("unsupported capability exits before queue, adapter, or network", async () => {
	let touched = 0;
	const app = appFixture(makeAdapter());
	const engine = new SettingsSyncEngine({
		app,
		getSettings: settings,
		getCapabilities: () => ({ settingsSync: false, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		adapter: { ...makeAdapter(), list: async () => { touched++; return { files: [], folders: [] }; } },
		createClient: (options) => new SettingsSyncClient({ ...options, request: async () => { touched++; return response(emptyRemote); } }),
	});
	await engine.start();
	s.check(engine.status.reason === "unsupported", "unsupported status is explicit");
	s.check(touched === 0, "gate runs before adapter and network access");
	s.check(
		engine.status.pendingApplySteps === 0
			&& engine.status.pendingApplyTotal === 0
			&& engine.status.environmentPlugins.length === 0
			&& engine.status.environmentThemes.length === 0,
		"unsupported status exposes empty bounded queue and environment summaries",
	);
	await engine.stop();
});

s.test("stop restores exact installer functions", async () => {
	const install = async () => undefined;
	const enable = async () => true;
	const adapter = makeAdapter();
	const indexedDb = new FakeIndexedDb();
	await markEnvironmentAccepted(await acceptedScope(indexedDb));
	const pluginHost = {
		installPlugin: install,
		enablePluginAndSave: enable,
		isEnabled: () => true,
		manifests: {},
		enabledPlugins: new Set<string>(),
	};
	const app = appFixture(adapter, pluginHost);
	const engine = new SettingsSyncEngine({
		app, adapter, getSettings: settings,
		getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		indexedDb,
		createClient: (options) => new SettingsSyncClient({ ...options, request: async (_input: RequestUrlParam) => response(emptyRemote) }),
	});
	await engine.start();
	s.check(pluginHost.installPlugin !== install, "installer is hooked while running");
	await engine.stop();
	s.check(pluginHost.installPlugin === install, "exact install function is restored");
	s.check(pluginHost.enablePluginAndSave === enable, "exact enable function is restored");
});

s.test("awaitable stop waits for an active serialized mutation", async () => {
	let reads = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const adapter = makeAdapter();
	const indexedDb = new FakeIndexedDb();
	await markEnvironmentAccepted(await acceptedScope(indexedDb));
	const app = appFixture(adapter);
	const engine = new SettingsSyncEngine({
		app, adapter, getSettings: settings,
		getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		indexedDb,
		createClient: (options) => new SettingsSyncClient({
			...options,
			request: async () => {
				reads++;
				if (reads > 1) await gate;
				return response(emptyRemote);
			},
		}),
	});
	await engine.start();
	const mutation = engine.applySettings();
	await Promise.resolve();
	let stopped = false;
	const stopping = engine.stop().then(() => { stopped = true; });
	await Promise.resolve();
	s.check(!stopped, "stop remains pending behind active mutation");
	release();
	await mutation;
	await stopping;
	s.check(stopped && engine.status.running === false, "stop resolves after mutation settles");
});

s.test("blank and occupied joiners require consent before any mutation", async () => {
	for (const occupied of [false, true]) {
		const indexedDb = new FakeIndexedDb();
		let gets = 0;
		let mutations = 0;
		const adapter = {
			...makeAdapter(),
			list: async (path: string) => ({
				files: [],
				folders: occupied && path.endsWith("/plugins")
					? [".obsidian/plugins/calendar"]
					: [],
			}),
			write: async () => { mutations++; },
			remove: async () => { mutations++; },
			mkdir: async () => { mutations++; },
		};
		const app = appFixture(adapter);
		const engine = new SettingsSyncEngine({
			app,
			adapter,
			indexedDb,
			getSettings: settings,
			getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
			folderKey: "folder-a",
			createClient: (options) => new SettingsSyncClient({
				...options,
				request: async (input) => {
					if (input.method === "GET") gets++;
					else mutations++;
					return response(emptyRemote);
				},
			}),
		});
		await engine.start();
		s.check(engine.status.reason === "decision-required", "seeded joiner reports decision required");
		s.check(engine.status.seedKind === (occupied ? "occupied" : "blank"), "local occupancy is explicit");
		s.check(gets === 1 && mutations === 0, "only the environment GET occurs before consent");
		await engine.stop();
	}
});

s.test("acceptance resumes only its exact identity", async () => {
	const indexedDb = new FakeIndexedDb();
	await markEnvironmentAccepted(await acceptedScope(indexedDb, { deviceId: "foreign-device" }));
	let gets = 0;
	const adapter = makeAdapter();
	const app = appFixture(adapter);
	const engine = new SettingsSyncEngine({
		app,
		adapter,
		indexedDb,
		getSettings: settings,
		getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		createClient: (options) => new SettingsSyncClient({
			...options,
			request: async () => {
				gets++;
				return response(emptyRemote);
			},
		}),
	});
	await engine.start();
	s.check(engine.status.reason === "decision-required", "foreign acceptance is ignored");
	await engine.stop();
	await markEnvironmentAccepted(await acceptedScope(indexedDb));
	await engine.start();
	s.check(engine.status.reason === "ok", "exact accepted identity resumes sync");
	s.check(gets === 2, "each startup fetches the environment once");
	await engine.stop();
});


s.test("take quarantines remote bodies whose hashes do not match", async () => {
	const indexedDb = new FakeIndexedDb();
	let writes = 0;
	const adapter = {
		...makeAdapter(),
		write: async () => { writes++; },
		read: async () => { throw new Error("missing"); },
	};
	const remote = {
		seeded: true as const,
		envRev: 2,
		files: [{
			path: "graph.json",
			sha256: "0".repeat(64),
			size: 2,
			rev: 2,
			bodyBase64: btoa("{}"),
		}],
		intents: [],
		themes: [],
		tombstones: [],
		pluginData: [{
			pluginId: "calendar",
			pluginVersion: "1.5.10",
			sha256: "1".repeat(64),
			size: 2,
			rev: 2,
			bodyBase64: btoa("{}"),
		}],
	};
	const engine = new SettingsSyncEngine({
		app: appFixture(adapter),
		adapter,
		indexedDb,
		getSettings: settings,
		getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		createClient: (options) => new SettingsSyncClient({
			...options,
			request: async () => response(remote),
		}),
	});
	await engine.start();
	await engine.takeSeed();
	s.check(writes === 0, "mismatched file and plugin-data bodies never reach the adapter");
	s.check(engine.status.error?.startsWith("invalid_hash:") === true, "hash mismatch remains visible after the consented take");
	await engine.stop();
});

s.test("foreground visibility resumes a paused consented package queue", async () => {
	const indexedDb = new FakeIndexedDb();
	const scope = await acceptedScope(indexedDb);
	const { indexedDb: _factory, ...identity } = scope;
	await persistApplyQueue(scope, {
		version: 1,
		identity,
		steps: [{
			kind: "install-plugin",
			id: "calendar",
			repo: "liamcain/obsidian-calendar-plugin",
			version: "1.5.10",
			manifest: { id: "calendar", version: "1.5.10" },
		}],
		nextIndex: 0,
	});
	let hidden = true;
	let visibilityListener!: () => void;
	let installs = 0;
	const adapter = makeAdapter();
	const plugins = {
		isEnabled: () => true,
		manifests: {},
		enabledPlugins: new Set<string>(),
		installPlugin: async () => { installs++; },
		enablePluginAndSave: async () => true,
	};
	const engine = new SettingsSyncEngine({
		app: appFixture(adapter, plugins),
		adapter,
		indexedDb,
		getSettings: settings,
		getCapabilities: () => ({ settingsSync: true, settingsFormatVersion: 1 }),
		folderKey: "folder-a",
		visibility: {
			isHidden: () => hidden,
			subscribe: (listener) => {
				visibilityListener = listener;
				return () => { visibilityListener = () => undefined; };
			},
		},
		createClient: (options) => new SettingsSyncClient({
			...options,
			request: async () => response(emptyRemote),
		}),
	});
	await engine.start();
	s.check(installs === 0 && engine.status.pendingApplySteps === 1, "hidden package work remains durably queued");
	hidden = false;
	visibilityListener();
	for (let attempt = 0; attempt < 50 && installs === 0; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	s.check(installs === 1, "foreground transition resumes the package install without restart");
	s.check(engine.status.pendingApplySteps === 0 && engine.status.reason === "ok", "completed foreground resume clears queue and accepts environment");
	s.check(await loadEnvironmentAcceptance(scope), "completed consented queue records exact environment acceptance");
	await engine.stop();
});
await s.done();
