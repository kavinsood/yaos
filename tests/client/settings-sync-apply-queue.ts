import type { App } from "obsidian";
import {
	persistAndRunApplyBatch,
	resumeApplyQueue,
	type ApplyBatch,
	type ApplyContext,
	type ApplyStep,
} from "../../src/sync/settingsSync/apply";
import { loadApplyQueue } from "../../src/sync/settingsSync/applyQueue";
import { suite } from "../harness.ts";
import { FakeIndexedDb } from "../mocks/indexedDb";

const s = suite("settings-sync-apply-queue");

type FileMap = Map<string, string>;

function makeAdapter(files: FileMap) {
	return {
		write: async (path: string, data: string) => {
			files.set(path, data);
		},
		remove: async (path: string) => {
			files.delete(path);
		},
		mkdir: async () => {},
		exists: async (path: string) => files.has(path),
		rmdir: async (path: string) => {
			for (const key of [...files.keys()]) {
				if (key === path || key.startsWith(`${path}/`)) files.delete(key);
			}
		},
	};
}

function makeCtx(opts: {
	files: FileMap;
	indexedDb: FakeIndexedDb;
	beforeStep?: ApplyContext["beforeStep"];
	isHidden?: () => boolean;
	isMobile?: boolean;
	plugins?: NonNullable<App["plugins"]>;
	changeLayout?: (layout: unknown) => void;
	loadData?: () => void;
	reasons?: string[];
}): ApplyContext {
	const loadData = opts.loadData;
	const changeLayout = opts.changeLayout;
	const app: App = {
		plugins: opts.plugins ?? {
			isEnabled: () => true,
			manifests: {},
			enabledPlugins: new Set<string>(),
			installPlugin: async () => undefined,
			enablePluginAndSave: async () => true,
			uninstallPlugin: async () => undefined,
		},
		// @ts-expect-error Focused fixture models the undocumented workspace plugin registry.
		internalPlugins: {
			plugins: {
				workspaces: {
					instance: {
						loadData,
						changeLayout,
					},
				},
			},
		},
	};
	return {
		app,
		adapter: makeAdapter(opts.files),
		configDir: ".obsidian",
		hostHash: "host",
		vaultId: "vault",
		vaultGeneration: "generation",
		folderKey: "folder",
		deviceId: "device",
		configDirKey: ".obsidian",
		indexedDb: opts.indexedDb,
		beforeStep: opts.beforeStep,
		isHidden: opts.isHidden,
		isMobile: opts.isMobile,
		notice: () => {},
		recordReason: (code) => {
			opts.reasons?.push(code);
		},
	};
}

const FILE_BATCH: ApplyBatch = {
	key: ".obsidian",
	steps: [
		{ kind: "file", path: "graph.json", body: '{"a":1}' },
		{ kind: "file", path: "bookmarks.json", body: '{"items":[]}' },
		{ kind: "file", path: "daily-notes.json", body: "{}" },
	],
};

s.test("persist happens before the first mutate", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	indexedDb.failOpen = true;
	const ctx = makeCtx({ files, indexedDb });
	let threw = false;
	try {
		await persistAndRunApplyBatch(ctx, FILE_BATCH);
	} catch {
		threw = true;
	}
	s.check(threw, "persist failure rejects the batch");
	s.check(files.size === 0, "no file mutate when IndexedDB persist fails");
});

s.test("persist then resume after simulated crash mid-batch", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const ctx = makeCtx({
		files,
		indexedDb,
		beforeStep: (index) => {
			if (index === 1) throw new Error("simulated crash");
		},
	});

	let crashed = false;
	try {
		await persistAndRunApplyBatch(ctx, FILE_BATCH);
	} catch (error) {
		crashed = error instanceof Error && error.message === "simulated crash";
	}
	s.check(crashed, "runner surfaces the simulated crash");
	s.check(files.get(".obsidian/graph.json") === '{"a":1}', "first step landed before the crash");
	s.check(!files.has(".obsidian/bookmarks.json"), "later steps did not run before the crash");
	s.check(!files.has(".obsidian/daily-notes.json"), "tail of the batch is unapplied after crash");

	const leftover = await loadApplyQueue(
		{ hostHash: "host", vaultId: "vault", vaultGeneration: "generation", folderKey: "folder", deviceId: "device", configDirKey: ".obsidian", indexedDb },
	);
	s.check(leftover !== null, "queue record survives the crash in IndexedDB");
	s.check(leftover !== null && leftover.nextIndex === 1, "checkpoint is the first unrun step");
	s.check(leftover !== null && leftover.steps.length === 3, "planned batch is still the full list");

	const reboot = makeCtx({ files, indexedDb });
	await resumeApplyQueue(reboot);
	s.check(files.get(".obsidian/bookmarks.json") === '{"items":[]}', "resume applies the next file");
	s.check(files.get(".obsidian/daily-notes.json") === "{}", "resume finishes the rest of the batch");
	s.check(files.get(".obsidian/graph.json") === '{"a":1}', "already-landed file is kept");

	const after = await loadApplyQueue(
		{ hostHash: "host", vaultId: "vault", vaultGeneration: "generation", folderKey: "folder", deviceId: "device", configDirKey: ".obsidian", indexedDb },
	);
	s.check(after === null, "finished queue is cleared from IndexedDB");
});

s.test("JSON quarantine keeps local and continues the batch", async () => {
	const files: FileMap = new Map();
	files.set(".obsidian/app.json", '{"keep":true}');
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const ctx = makeCtx({ files, indexedDb, reasons });
	const batch: ApplyBatch = {
		key: ".obsidian",
		steps: [
			{ kind: "file", path: "app.json", body: "{not-json" },
			{ kind: "file", path: "graph.json", body: '{"ok":true}' },
		],
	};
	await persistAndRunApplyBatch(ctx, batch);
	s.check(files.get(".obsidian/app.json") === '{"keep":true}', "invalid inbound JSON does not replace local");
	s.check(files.get(".obsidian/graph.json") === '{"ok":true}', "quarantine skip continues the rest");
	s.check(reasons.includes("settings.invalid_json"), "invalid JSON records a reason");
});

s.test("oversize file is skipped with a reason", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const ctx = makeCtx({ files, indexedDb, reasons });
	const huge = "x".repeat(1_000_001);
	const batch: ApplyBatch = {
		key: ".obsidian",
		steps: [
			{ kind: "file", path: "graph.json", body: huge },
			{ kind: "file", path: "templates.json", body: "{}" },
		],
	};
	await persistAndRunApplyBatch(ctx, batch);
	s.check(!files.has(".obsidian/graph.json"), "oversize body is not written");
	s.check(files.get(".obsidian/templates.json") === "{}", "oversize skip continues");
	s.check(reasons.includes("settings.oversized"), "oversize records a reason");
});

s.test("workspaces.json write never calls changeLayout", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	let layouts = 0;
	let loads = 0;
	const ctx = makeCtx({
		files,
		indexedDb,
		changeLayout: () => {
			layouts++;
		},
		loadData: () => {
			loads++;
		},
	});
	const batch: ApplyBatch = {
		key: ".obsidian",
		steps: [{ kind: "file", path: "workspaces.json", body: '{"work":{}}' }],
	};
	await persistAndRunApplyBatch(ctx, batch);
	s.check(files.get(".obsidian/workspaces.json") === '{"work":{}}', "workspaces.json is written");
	s.check(layouts === 0, "changeLayout is never called");
	s.check(loads === 1, "workspace name list is refreshed via loadData");
});

s.test("restricted mode skips plugin install and continues files", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const installs: string[] = [];
	const ctx = makeCtx({
		files,
		indexedDb,
		reasons,
		plugins: {
			isEnabled: () => false,
			manifests: {},
			enabledPlugins: new Set<string>(),
			installPlugin: async (repo, version) => {
				installs.push(`${repo}@${version}`);
			},
			enablePluginAndSave: async () => true,
		},
	});
	const batch: ApplyBatch = {
		key: ".obsidian",
		steps: [
			{ kind: "file", path: "core-plugins.json", body: "{}" },
			{
				kind: "install-plugin",
				id: "calendar",
				repo: "liamcain/obsidian-calendar-plugin",
				version: "1.5.10",
				manifest: { id: "calendar", version: "1.5.10", name: "Calendar" },
			},
			{ kind: "file", path: "graph.json", body: '{"g":1}' },
		],
	};
	await persistAndRunApplyBatch(ctx, batch);
	s.check(files.get(".obsidian/core-plugins.json") === "{}", "files before the install still land");
	s.check(installs.length === 0, "restricted mode does not call installPlugin");
	s.check(files.get(".obsidian/graph.json") === '{"g":1}', "files after the skipped install still land");
	s.check(reasons.includes("settings.restricted"), "restricted install records a reason");
});

s.test("backgrounded device pauses at installPlugin and resumes later", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const installs: string[] = [];
	let hidden = true;
	const plugins: NonNullable<App["plugins"]> = {
		isEnabled: () => true,
		manifests: {},
		enabledPlugins: new Set<string>(),
		installPlugin: async (repo, version, manifest) => {
			installs.push(`${manifest.id}:${repo}:${version}`);
		},
		enablePluginAndSave: async () => true,
	};
	const ctx = makeCtx({
		files,
		indexedDb,
		plugins,
		isHidden: () => hidden,
	});
	const batch: ApplyBatch = {
		key: ".obsidian",
		steps: [
			{ kind: "file", path: "graph.json", body: "{}" },
			{
				kind: "install-plugin",
				id: "calendar",
				repo: "liamcain/obsidian-calendar-plugin",
				version: "1.5.10",
				manifest: { id: "calendar", version: "1.5.10" },
			},
		],
	};
	await persistAndRunApplyBatch(ctx, batch);
	s.check(files.get(".obsidian/graph.json") === "{}", "file LWW runs while backgrounded");
	s.check(installs.length === 0, "installPlugin is not called while hidden");
	const leftover = await loadApplyQueue(
		{ hostHash: "host", vaultId: "vault", vaultGeneration: "generation", folderKey: "folder", deviceId: "device", configDirKey: ".obsidian", indexedDb },
	);
	s.check(leftover !== null && leftover.nextIndex === 1, "install step stays queued while hidden");

	hidden = false;
	const reboot = makeCtx({ files, indexedDb, plugins, isHidden: () => hidden });
	await resumeApplyQueue(reboot);
	s.check(installs.join(",") === "calendar:liamcain/obsidian-calendar-plugin:1.5.10", "install runs once visible");
});

s.test("plugin-data step honors the version gate", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const ctx = makeCtx({ files, indexedDb, reasons });
	const mismatch: ApplyStep = {
		kind: "plugin-data",
		pluginId: "obsidian-excalidraw-plugin",
		pluginVersion: "1.6",
		body: '{"ok":true}',
		localManifestVersion: "1.5",
		intentVersion: "1.6",
	};
	await persistAndRunApplyBatch(ctx, { key: ".obsidian", steps: [mismatch] });
	s.check(
		!files.has(".obsidian/plugins/obsidian-excalidraw-plugin/data.json"),
		"mismatched data.json is not applied",
	);
	s.check(reasons.includes("settings.plugin_version_mismatch"), "mismatch is loud");

	const match: ApplyStep = {
		kind: "plugin-data",
		pluginId: "calendar",
		pluginVersion: "1.5.10",
		body: '{"fmt":"iso"}',
		localManifestVersion: "1.5.10",
		intentVersion: "1.5.10",
	};
	const ctx2 = makeCtx({ files, indexedDb: new FakeIndexedDb() });
	await persistAndRunApplyBatch(ctx2, { key: ".obsidian", steps: [match] });
	s.check(
		files.get(".obsidian/plugins/calendar/data.json") === '{"fmt":"iso"}',
		"matching versions apply data.json",
	);
});

s.test("enablePluginAndSave throw does not halt later steps", async () => {
	const files: FileMap = new Map();
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const plugins: NonNullable<App["plugins"]> = {
		isEnabled: () => true,
		manifests: { calendar: { id: "calendar", version: "1.5.10" } as never },
		enabledPlugins: new Set<string>(),
		enablePluginAndSave: async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'enablePlugin')");
		},
	};
	const ctx = makeCtx({ files, indexedDb, plugins, reasons });
	await persistAndRunApplyBatch(ctx, {
		key: ".obsidian",
		steps: [
			{ kind: "enable-plugin", id: "calendar", enabled: true },
			{ kind: "file", path: "graph.json", body: '{"after":true}' },
		],
	});
	s.check(reasons.some((r) => r === "settings.enable_failed"), "enable failure is recorded");
	s.check(files.get(".obsidian/graph.json") === '{"after":true}', "later file step still lands");
});

s.test("uninstallPlugin throw still rmdirs the plugin folder", async () => {
	const files: FileMap = new Map([
		[".obsidian/plugins/calendar/manifest.json", '{"id":"calendar"}'],
		[".obsidian/plugins/calendar/main.js", "void 0"],
		[".obsidian/plugins/calendar/data.json", "{}"],
	]);
	const indexedDb = new FakeIndexedDb();
	const reasons: string[] = [];
	const plugins: NonNullable<App["plugins"]> = {
		isEnabled: () => true,
		manifests: { calendar: { id: "calendar", version: "1.5.10" } as never },
		enabledPlugins: new Set(["calendar"]),
		disablePluginAndSave: async () => true as never,
		uninstallPlugin: async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'disablePluginAndSave')");
		},
	};
	const ctx = makeCtx({ files, indexedDb, plugins, reasons });
	await persistAndRunApplyBatch(ctx, {
		key: ".obsidian",
		steps: [{ kind: "uninstall-plugin", id: "calendar" }],
	});
	s.check(reasons.includes("settings.uninstall_failed"), "host uninstall failure is recorded");
	s.check(reasons.includes("settings.plugin_removed_restart"), "rmdir fallback demands restart");
	s.check(!files.has(".obsidian/plugins/calendar/manifest.json"), "rmdir removes manifest");
	s.check(!files.has(".obsidian/plugins/calendar/main.js"), "rmdir removes main.js");
	s.check(!files.has(".obsidian/plugins/calendar/data.json"), "rmdir removes data.json");
});

s.test("persisted file steps cannot widen the settings allowlist", async () => {
	const files: FileMap = new Map();
	const reasons: string[] = [];
	await persistAndRunApplyBatch(
		makeCtx({ files, indexedDb: new FakeIndexedDb(), reasons }),
		{
			key: ".obsidian",
			steps: [
				{ kind: "file", path: "community-plugins.json", body: "[\"calendar\"]" },
				{ kind: "file", path: "plugins/calendar/data.json", body: "{}" },
			],
		},
	);
	s.check(!files.has(".obsidian/community-plugins.json"), "known-unsynced root JSON is rejected at apply time");
	s.check(!files.has(".obsidian/plugins/calendar/data.json"), "file step cannot bypass the plugin-data version gate");
	s.check(reasons.filter((reason) => reason === "settings.forbidden_path").length === 2, "both widened paths are reported");
});

s.test("persisted package steps cannot mutate protected YAOS plugins", async () => {
	const files: FileMap = new Map([
		[".obsidian/plugins/yaos/manifest.json", '{"id":"yaos","version":"2.1.0"}'],
		[".obsidian/plugins/yaos/main.js", "running"],
	]);
	const reasons: string[] = [];
	const calls: string[] = [];
	const plugins: NonNullable<App["plugins"]> = {
		isEnabled: () => true,
		manifests: { yaos: { id: "yaos", version: "2.1.0" } as never },
		enabledPlugins: new Set(["yaos"]),
		installPlugin: async () => { calls.push("install"); },
		enablePluginAndSave: async () => { calls.push("enable"); return true; },
		disablePluginAndSave: async () => { calls.push("disable"); return true; },
		unloadPlugin: async () => { calls.push("unload"); },
		uninstallPlugin: async () => { calls.push("uninstall"); },
	};
	await persistAndRunApplyBatch(
		makeCtx({ files, indexedDb: new FakeIndexedDb(), reasons, plugins }),
		{
			key: ".obsidian",
			steps: [
				{ kind: "install-plugin", id: "yaos", repo: "kavinsood/yaos", version: "2.1.0", manifest: { id: "yaos", version: "2.1.0" } },
				{ kind: "enable-plugin", id: "yaos", enabled: false },
				{ kind: "plugin-data", pluginId: "yaos", pluginVersion: "2.1.0", body: "{}", localManifestVersion: "2.1.0", intentVersion: "2.1.0" },
				{ kind: "uninstall-plugin", id: "yaos" },
			],
		},
	);
	s.check(calls.length === 0, "protected package steps call no Obsidian mutation API");
	s.check(files.get(".obsidian/plugins/yaos/main.js") === "running", "protected plugin files remain intact");
	s.check(reasons.filter((reason) => reason === "settings.forbidden_plugin").length === 4, "every protected operation is rejected");
});
s.test("theme tombstone removes the local theme folder", async () => {
	const files: FileMap = new Map([
		[".obsidian/themes/Minimal/manifest.json", '{"name":"Minimal"}'],
		[".obsidian/themes/Minimal/theme.css", "body {}"],
	]);
	const reasons: string[] = [];
	await persistAndRunApplyBatch(
		makeCtx({ files, indexedDb: new FakeIndexedDb(), reasons }),
		{ key: ".obsidian", steps: [{ kind: "uninstall-theme", name: "Minimal" }] },
	);
	s.check(!files.has(".obsidian/themes/Minimal/manifest.json"), "theme manifest is removed");
	s.check(!files.has(".obsidian/themes/Minimal/theme.css"), "theme stylesheet is removed");
	s.check(reasons.includes("settings.theme_removed_restart"), "theme removal reports restart guidance");
});
await s.done();
