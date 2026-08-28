import type { App, PluginManifest } from "obsidian";
import { runSmokeInstallCalendar } from "../../src/sync/settingsSync/obsidianPluginInstall";
import { suite } from "../harness.ts";

const s = suite("obsidian-plugin-install");
const MANIFEST: PluginManifest = {
	id: "calendar",
	name: "Calendar",
	author: "Liam Cain",
	version: "1.5.10",
	minAppVersion: "0.9.11",
	description: "Calendar view of your daily notes",
};
type FakePlugins = NonNullable<App["plugins"]>;

function fakeApp(plugins: Partial<FakePlugins>): App {
	return {
		plugins: {
			installPlugin: async () => undefined,
			enablePluginAndSave: async () => true,
			setEnable: async () => undefined,
			isEnabled: () => true,
			manifests: {},
			enabledPlugins: new Set<string>(),
			...plugins,
		},
	} as App;
}

const lookups = {
	lookupCatalog: async () => ({ id: "calendar", repo: "liamcain/obsidian-calendar-plugin" }),
	lookupManifest: async () => MANIFEST,
};

s.test("installs before enabling when Calendar is missing", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		installPlugin: async (repo, version, manifest) => {
			calls.push(`install:${repo}:${version}:${manifest.id}`);
		},
		enablePluginAndSave: async (id) => {
			calls.push(`enable:${id}`);
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "installed", "missing Calendar is installed");
	s.check(result.kind === "installed" && result.version === "1.5.10", "resolved catalog version is installed");
	s.check(result.kind === "installed" && result.enabled, "Calendar is enabled after install");
	s.check(
		calls.join(",") === "install:liamcain/obsidian-calendar-plugin:1.5.10:calendar,enable:calendar",
		"host methods retain their receiver and run install before enable",
	);
});

s.test("does not enable after a failed install", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		installPlugin: async () => {
			calls.push("install");
			throw new Error("github 404");
		},
		enablePluginAndSave: async () => {
			calls.push("enable");
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "failed", "install failure is reported");
	s.check(calls.join(",") === "install", "enable is not called after install throws");
});

s.test("skips an already-current enabled install", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		manifests: { calendar: { ...MANIFEST } },
		enabledPlugins: new Set(["calendar"]),
		installPlugin: async () => { calls.push("install"); },
		enablePluginAndSave: async () => {
			calls.push("enable");
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "skipped", "already-current Calendar is skipped");
	s.check(calls.length === 0, "already-current Calendar invokes no host mutation");
});

s.test("enables only when the installed version matches", async () => {
	const calls: string[] = [];
	const app = fakeApp({
		manifests: { calendar: { ...MANIFEST } },
		enabledPlugins: new Set(),
		installPlugin: async () => { calls.push("install"); },
		enablePluginAndSave: async (id) => {
			calls.push(`enable:${id}`);
			return true;
		},
	});
	const result = await runSmokeInstallCalendar(app, lookups);
	s.check(result.kind === "installed" && result.enabled, "matching disabled Calendar is enabled");
	s.check(calls.join(",") === "enable:calendar", "matching version is not downloaded again");
});

s.test("fails closed for restricted community plugins", async () => {
	const result = await runSmokeInstallCalendar(fakeApp({ isEnabled: () => false }), lookups);
	s.check(result.kind === "failed", "restricted mode fails closed");
	s.check(result.kind === "failed" && result.reason.includes("Restricted"), "failure explains restricted mode");
});

s.test("fails closed when installPlugin is missing", async () => {
	const result = await runSmokeInstallCalendar(fakeApp({ installPlugin: undefined }), lookups);
	s.check(result.kind === "failed", "missing installer API fails closed");
	s.check(result.kind === "failed" && result.reason.includes("does not expose"), "failure names missing host seam");
});

await s.done();
