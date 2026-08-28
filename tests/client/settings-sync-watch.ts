import { SettingsSyncWatcher, type SettingsDirAdapter } from "../../src/sync/settingsSync/watch";
import { suite } from "../harness.ts";

const s = suite("settings-sync-watch");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		globalThis.setTimeout(resolve, ms);
	});
}

function adapter(files: Map<string, string>): SettingsDirAdapter {
	return {
		async list(path: string) {
			const prefix = path.replace(/\\/g, "/").replace(/\/$/, "");
			const outFiles: string[] = [];
			const folders = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(`${prefix}/`) && key !== prefix) continue;
				const rest = key.slice(prefix.length + 1);
				const slash = rest.indexOf("/");
				if (slash < 0) outFiles.push(key);
				else folders.add(`${prefix}/${rest.slice(0, slash)}`);
			}
			return { files: outFiles, folders: [...folders] };
		},
		async read(path: string) {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing ${path}`);
			return value;
		},
		async exists(path: string) {
			if (files.has(path)) return true;
			const prefix = `${path.replace(/\/$/, "")}/`;
			for (const key of files.keys()) {
				if (key.startsWith(prefix)) return true;
			}
			return false;
		},
		async write() {},
		async mkdir() {},
		async remove() {},
	};
}

s.test("data.json hash is not committed until debounce delivers", async () => {
	const files = new Map<string, string>([
		[".obsidian/app.json", "{}"],
		[".obsidian/plugins/calendar/data.json", "{\"v\":1}"],
	]);
	const delivered: string[] = [];
	const watcher = new SettingsSyncWatcher(
		adapter(files),
		".obsidian",
		{
			onFile: (event) => {
				if (event.type === "upsert") delivered.push(`${event.file.path}:${event.file.sha256.slice(0, 8)}`);
			},
		},
		60_000,
		40,
	);
	watcher.start();
	await delay(10);
	files.set(".obsidian/plugins/calendar/data.json", "{\"v\":2}");
	await watcher.poll();
	watcher.stop();
	const afterStop = delivered.filter((row) => row.startsWith("plugins/calendar/data.json:")).length;
	s.check(afterStop <= 1, "stopping during debounce does not deliver the latest pending body");

	const again: string[] = [];
	const watcher2 = new SettingsSyncWatcher(
		adapter(files),
		".obsidian",
		{
			onFile: (event) => {
				if (event.type === "upsert" && event.file.path === "plugins/calendar/data.json") {
					again.push(event.file.sha256);
				}
			},
		},
		60_000,
		40,
	);
	watcher2.start();
	await delay(60);
	s.check(again.length >= 1, "a new watcher delivers the current body after a dropped debounce");
	watcher2.stop();
});

await s.done();
