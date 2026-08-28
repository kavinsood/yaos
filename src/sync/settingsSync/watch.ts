import {
	isAllowlistedConfigPath,
	isPluginDataRelPath,
	listUnknownRootJson,
	normalizeConfigRelPath,
} from "./allowlist";
import { sha256BytesHex } from "../../utils/sha256";
import { SETTINGS_SYNC_MAX_FILE_BYTES } from "./types";

export const SETTINGS_SYNC_POLL_MS = 2_000;
export const SETTINGS_SYNC_DATA_JSON_DEBOUNCE_MS = 5_000;

export type SettingsDirAdapter = {
	list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
	read: (path: string) => Promise<string>;
	readBinary?: (path: string) => Promise<ArrayBuffer>;
	write: (path: string, data: string) => Promise<void>;
	writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
	exists: (path: string) => Promise<boolean>;
	stat?: (path: string) => Promise<{ mtime: number; size: number } | null>;
	mkdir: (path: string) => Promise<void>;
	remove: (path: string) => Promise<void>;
};

export type LocalConfigFile = {
	path: string;
	sha256: string;
	size: number;
	body: Uint8Array;
};

export type ConfigDirScan = {
	files: Map<string, LocalConfigFile>;
	unknownRootJson: string[];
};

export type WatchFileEvent =
	| { type: "upsert"; file: LocalConfigFile }
	| { type: "delete"; path: string };

export type SettingsSyncWatchHandlers = {
	onFile: (event: WatchFileEvent) => void;
	onUnknownRootJson?: (names: string[]) => void;
};

export async function scanConfigDir(
	adapter: SettingsDirAdapter,
	configDir: string,
): Promise<ConfigDirScan> {
	const files = new Map<string, LocalConfigFile>();
	const rootNames: string[] = [];

	const root = await listSafe(adapter, configDir);
	for (const listed of root.files) {
		const rel = toRel(configDir, listed);
		if (!rel || rel.includes("/")) continue;
		rootNames.push(rel);
		if (!isAllowlistedConfigPath(rel)) continue;
		const loaded = await loadAllowlistedFile(adapter, configDir, rel);
		if (loaded) files.set(rel, loaded);
	}

	const snippets = await listSafe(adapter, joinConfig(configDir, "snippets"));
	for (const listed of snippets.files) {
		const rel = toRel(configDir, listed);
		if (!isAllowlistedConfigPath(rel)) continue;
		const loaded = await loadAllowlistedFile(adapter, configDir, rel);
		if (loaded) files.set(rel, loaded);
	}

	const plugins = await listSafe(adapter, joinConfig(configDir, "plugins"));
	for (const folder of plugins.folders) {
		const id = basename(folder);
		if (!id) continue;
		const rel = `plugins/${id}/data.json`;
		if (!isAllowlistedConfigPath(rel)) continue;
		const loaded = await loadAllowlistedFile(adapter, configDir, rel);
		if (loaded) files.set(rel, loaded);
	}

	return { files, unknownRootJson: listUnknownRootJson(rootNames) };
}

export class SettingsSyncWatcher {
	private timer: number | null = null;
	private stopped = true;
	private readonly lastHash = new Map<string, string>();
	private readonly debounceTimers = new Map<string, number>();
	private readonly debounceLatest = new Map<string, WatchFileEvent>();

	constructor(
		private readonly adapter: SettingsDirAdapter,
		private readonly configDir: string,
		private readonly handlers: SettingsSyncWatchHandlers,
		private readonly pollMs = SETTINGS_SYNC_POLL_MS,
		private readonly dataJsonDebounceMs = SETTINGS_SYNC_DATA_JSON_DEBOUNCE_MS,
	) {}

	start(): void {
		this.stopped = false;
		void this.poll();
		this.timer = window.setInterval(() => {
			void this.poll();
		}, this.pollMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
		this.debounceTimers.clear();
		this.debounceLatest.clear();
	}

	async poll(): Promise<ConfigDirScan | null> {
		if (this.stopped) return null;
		const scan = await scanConfigDir(this.adapter, this.configDir);
		if (this.stopped) return null;
		this.handlers.onUnknownRootJson?.(scan.unknownRootJson);

		const seen = new Set<string>();
		for (const [path, file] of scan.files) {
			seen.add(path);
			if (this.lastHash.get(path) === file.sha256) continue;
			this.emit({ type: "upsert", file });
		}
		for (const path of [...this.lastHash.keys()]) {
			if (!seen.has(path)) this.emit({ type: "delete", path });
		}
		return scan;
	}

	private emit(event: WatchFileEvent): void {
		const path = event.type === "upsert" ? event.file.path : event.path;
		if (!isPluginDataRelPath(path)) {
			this.commit(event);
			return;
		}
		this.debounceLatest.set(path, event);
		const existing = this.debounceTimers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.debounceTimers.delete(path);
			const latest = this.debounceLatest.get(path);
			this.debounceLatest.delete(path);
			if (latest && !this.stopped) this.commit(latest);
		}, this.dataJsonDebounceMs);
		this.debounceTimers.set(path, timer);
	}

	private commit(event: WatchFileEvent): void {
		if (event.type === "upsert") this.lastHash.set(event.file.path, event.file.sha256);
		else this.lastHash.delete(event.path);
		this.handlers.onFile(event);
	}
}

export function joinConfig(configDir: string, rel: string): string {
	const root = configDir.replace(/\\/g, "/").replace(/\/$/, "");
	return rel ? `${root}/${normalizeConfigRelPath(rel)}` : root;
}

export function toRel(configDir: string, listed: string): string {
	const normalizedListed = normalizeConfigRelPath(listed);
	const prefix = normalizeConfigRelPath(configDir).replace(/\/$/, "");
	if (normalizedListed === prefix) return "";
	if (normalizedListed.startsWith(`${prefix}/`)) return normalizedListed.slice(prefix.length + 1);
	return normalizedListed;
}

async function loadAllowlistedFile(
	adapter: SettingsDirAdapter,
	configDir: string,
	rel: string,
): Promise<LocalConfigFile | null> {
	const absolute = joinConfig(configDir, rel);
	try {
		if (adapter.stat) {
			const stats = await adapter.stat(absolute);
			if (!stats || stats.size > SETTINGS_SYNC_MAX_FILE_BYTES) return null;
		}
		const body = await readBytes(adapter, absolute);
		if (!body || body.byteLength > SETTINGS_SYNC_MAX_FILE_BYTES) return null;
		return {
			path: rel,
			sha256: await sha256BytesHex(body),
			size: body.byteLength,
			body,
		};
	} catch {
		return null;
	}
}

async function readBytes(adapter: SettingsDirAdapter, path: string): Promise<Uint8Array | null> {
	try {
		if (adapter.readBinary) return new Uint8Array(await adapter.readBinary(path));
		return new TextEncoder().encode(await adapter.read(path));
	} catch {
		return null;
	}
}

async function listSafe(
	adapter: SettingsDirAdapter,
	path: string,
): Promise<{ files: string[]; folders: string[] }> {
	try {
		if (!(await adapter.exists(path))) return { files: [], folders: [] };
		return await adapter.list(path);
	} catch {
		return { files: [], folders: [] };
	}
}

function basename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
