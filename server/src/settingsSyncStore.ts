import { base64ToBytes, bytesToBase64 } from "./base64url";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { isSha256Hex, sha256Hex } from "./hex";
import { SETTINGS_FORMAT_VERSION } from "./shared/productVersions";

export { SETTINGS_FORMAT_VERSION };
export const MAX_SETTINGS_CONFIG_KEY_LENGTH = 64;
export const MAX_SETTINGS_PATH_LENGTH = 256;
export const MAX_SETTINGS_ID_LENGTH = 128;
export const MAX_SETTINGS_REPO_LENGTH = 256;
export const MAX_SETTINGS_VERSION_LENGTH = 64;
export const MAX_SETTINGS_FILE_BYTES = 1_000_000;
export const MAX_SETTINGS_ENVIRONMENT_BODY_BYTES = 4_000_000;
export const MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES = 6_000_000;
export const MAX_SETTINGS_ITEM_REQUEST_BYTES = 1_500_000;
export const MAX_SETTINGS_GET_RESPONSE_BYTES = 6_000_000;
export const MAX_SETTINGS_FILES = 256;
export const MAX_SETTINGS_INTENTS = 256;
export const MAX_SETTINGS_THEMES = 64;
export const MAX_SETTINGS_PLUGIN_DATA = 256;
export const MAX_SETTINGS_TOMBSTONES = 512;

const FORBIDDEN_PLUGIN_IDS: Record<string, true> = {
	yaos: true,
	"yaos-qa-harness": true,
};
const ROOT_JSON_FILES: Record<string, true> = {
	"app.json": true,
	"appearance.json": true,
	"hotkeys.json": true,
	"graph.json": true,
	"daily-notes.json": true,
	"templates.json": true,
	"backlink.json": true,
	"page-preview.json": true,
	"note-composer.json": true,
	"switcher.json": true,
	"bookmarks.json": true,
	"workspaces.json": true,
	"core-plugins.json": true,
	"core-plugins-migration.json": true,
};

export type SqlStorageValue = ArrayBuffer | string | number | null;
export interface SettingsSqlCursor<T> {
	toArray(): T[];
	[Symbol.iterator](): Iterator<T>;
}
export interface SettingsSqlStorage {
	exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SettingsSqlCursor<T>;
}
export interface SettingsDurableStorage {
	readonly sql: SettingsSqlStorage;
	transactionSync<T>(closure: () => T): T;
}

export type SettingsFileRow = {
	path: string;
	sha256: string;
	size: number;
	rev: number;
	bodyBase64: string;
};
export type SettingsIntentRow = { id: string; repo: string; version: string; enabled: boolean; rev: number };
export type SettingsThemeRow = { name: string; repo: string; version: string; rev: number };
export type SettingsTombstoneRow = { kind: "plugin" | "theme"; id: string; rev: number; deletedAt: number };
export type SettingsPluginDataRow = {
	pluginId: string;
	pluginVersion: string;
	sha256: string;
	size: number;
	rev: number;
	bodyBase64: string;
};
export type SettingsEnvironment = {
	seeded: true;
	envRev: number;
	files: SettingsFileRow[];
	intents: SettingsIntentRow[];
	themes: SettingsThemeRow[];
	tombstones: SettingsTombstoneRow[];
	pluginData: SettingsPluginDataRow[];
};
export type SettingsGetBody = { seeded: false } | SettingsEnvironment;
export type SettingsSyncError = { ok: false; status: number; error: string };
export type SettingsSyncOk<T> = { ok: true; value: T };
export type SettingsSyncResult<T> = SettingsSyncOk<T> | SettingsSyncError;
type MutationOk = { envRev: number; rev: number };
type ParsedIntent = { id: string; repo: string; version: string; enabled: boolean };
type ParsedTheme = { name: string; repo: string; version: string };
type ParsedFile = { path: string; sha256: string; body: Uint8Array };
type ParsedPluginData = { pluginId: string; pluginVersion: string; sha256: string; body: Uint8Array };
type ParsedSnapshot = {
	files: ParsedFile[];
	intents: ParsedIntent[];
	themes: ParsedTheme[];
	pluginData: ParsedPluginData[];
};

class StoreAbort extends Error {
	constructor(readonly status: number, readonly error: string) {
		super(error);
		this.name = "StoreAbort";
	}
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StoreAbort(400, "invalid_json");
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) if (!set.has(key)) throw new StoreAbort(400, "invalid_json");
}

function boundedString(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
		throw new StoreAbort(400, "invalid_json");
	}
	return value;
}

function requireSha(value: unknown): string {
	if (typeof value !== "string" || !isSha256Hex(value)) throw new StoreAbort(400, "invalid_json");
	return value;
}

function decodeBody(value: unknown): Uint8Array {
	if (typeof value !== "string") throw new StoreAbort(400, "invalid_json");
	let bytes: Uint8Array;
	try {
		bytes = value === "" ? new Uint8Array(0) : base64ToBytes(value);
	} catch {
		throw new StoreAbort(400, "invalid_json");
	}
	if (bytes.byteLength > MAX_SETTINGS_FILE_BYTES) throw new StoreAbort(413, "oversized");
	return bytes;
}

function quarantineJson(body: Uint8Array): void {
	try {
		JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
	} catch {
		throw new StoreAbort(400, "invalid_json");
	}
}

export function sanitizeConfigKey(key: string): string | null {
	if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTINGS_CONFIG_KEY_LENGTH) return null;
	if (key === "." || key === ".." || key.includes("/") || key.includes("\\") || key.includes("\0")) return null;
	return key;
}

function requireConfigKey(key: string): string {
	const result = sanitizeConfigKey(key);
	if (result === null) throw new StoreAbort(400, "invalid_config_key");
	return result;
}

function pathHasTraversal(path: string): boolean {
	if (!path || path.length > MAX_SETTINGS_PATH_LENGTH || path.includes("\0") || path.includes("\\")
		|| path.startsWith("/") || path.endsWith("/")) return true;
	return path.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

export function isAllowlistedSettingsFile(path: string): boolean {
	if (typeof path !== "string" || pathHasTraversal(path)) return false;
	if (ROOT_JSON_FILES[path]) return true;
	const snippet = /^snippets\/([^/]+)\.css$/.exec(path);
	return Boolean(snippet?.[1]);
}

export function isAllowlistedPluginDataId(pluginId: string): boolean {
	return typeof pluginId === "string"
		&& pluginId.length > 0
		&& pluginId.length <= MAX_SETTINGS_ID_LENGTH
		&& !FORBIDDEN_PLUGIN_IDS[pluginId]
		&& pluginId !== "."
		&& pluginId !== ".."
		&& !pluginId.includes("/")
		&& !pluginId.includes("\\")
		&& !pluginId.includes("\0");
}

function requirePluginId(value: unknown): string {
	if (typeof value !== "string") throw new StoreAbort(400, "invalid_json");
	if (FORBIDDEN_PLUGIN_IDS[value]) throw new StoreAbort(400, "forbidden_plugin");
	if (!isAllowlistedPluginDataId(value)) throw new StoreAbort(400, "invalid_json");
	return value;
}

function requireThemeName(value: unknown): string {
	const name = boundedString(value, MAX_SETTINGS_ID_LENGTH);
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new StoreAbort(400, "invalid_json");
	}
	return name;
}

function parseIntent(value: unknown): ParsedIntent {
	const input = record(value);
	exactKeys(input, ["id", "repo", "version", "enabled"]);
	const id = requirePluginId(input.id);
	const repo = boundedString(input.repo, MAX_SETTINGS_REPO_LENGTH);
	const version = boundedString(input.version, MAX_SETTINGS_VERSION_LENGTH);
	if (typeof input.enabled !== "boolean") throw new StoreAbort(400, "invalid_json");
	return { id, repo, version, enabled: input.enabled };
}

function parseTheme(value: unknown): ParsedTheme {
	const input = record(value);
	exactKeys(input, ["name", "repo", "version"]);
	return {
		name: requireThemeName(input.name),
		repo: boundedString(input.repo, MAX_SETTINGS_REPO_LENGTH),
		version: boundedString(input.version, MAX_SETTINGS_VERSION_LENGTH),
	};
}

function parseFile(value: unknown): ParsedFile {
	const input = record(value);
	exactKeys(input, ["path", "sha256", "bodyBase64"]);
	if (typeof input.path !== "string" || !isAllowlistedSettingsFile(input.path)) {
		throw new StoreAbort(400, "path_not_allowed");
	}
	const body = decodeBody(input.bodyBase64);
	if (input.path.endsWith(".json")) quarantineJson(body);
	return { path: input.path, sha256: requireSha(input.sha256), body };
}

function parsePluginData(value: unknown): ParsedPluginData {
	const input = record(value);
	exactKeys(input, ["pluginId", "pluginVersion", "sha256", "bodyBase64"]);
	const body = decodeBody(input.bodyBase64);
	quarantineJson(body);
	return {
		pluginId: requirePluginId(input.pluginId),
		pluginVersion: boundedString(input.pluginVersion, MAX_SETTINGS_VERSION_LENGTH),
		sha256: requireSha(input.sha256),
		body,
	};
}

function parseArray(value: unknown, maximum: number): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new StoreAbort(400, "invalid_json");
	if (value.length > maximum) throw new StoreAbort(413, "too_many_entries");
	return value;
}

function assertUnique<T>(entries: T[], key: (entry: T) => string): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		const identity = key(entry);
		if (seen.has(identity)) throw new StoreAbort(400, "duplicate_entry");
		seen.add(identity);
	}
}

function parseSnapshot(value: unknown): ParsedSnapshot {
	const input = record(value);
	exactKeys(input, ["files", "intents", "themes", "pluginData"]);
	const files = parseArray(input.files, MAX_SETTINGS_FILES).map(parseFile);
	const intents = parseArray(input.intents, MAX_SETTINGS_INTENTS).map(parseIntent);
	const themes = parseArray(input.themes, MAX_SETTINGS_THEMES).map(parseTheme);
	const pluginData = parseArray(input.pluginData, MAX_SETTINGS_PLUGIN_DATA).map(parsePluginData);
	assertUnique(files, (entry) => entry.path);
	assertUnique(intents, (entry) => entry.id);
	assertUnique(themes, (entry) => entry.name);
	assertUnique(pluginData, (entry) => entry.pluginId);
	const intentById = new Map(intents.map((entry) => [entry.id, entry]));
	for (const entry of pluginData) {
		if (intentById.get(entry.pluginId)?.version !== entry.pluginVersion) {
			throw new StoreAbort(409, "plugin_version_mismatch");
		}
	}
	const bodyBytes = files.reduce((total, entry) => total + entry.body.byteLength, 0)
		+ pluginData.reduce((total, entry) => total + entry.body.byteLength, 0);
	if (bodyBytes > MAX_SETTINGS_ENVIRONMENT_BODY_BYTES) throw new StoreAbort(413, "environment_too_large");
	return { files, intents, themes, pluginData };
}

function safeRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function storedBody(value: ArrayBuffer | Uint8Array, declaredSize: number): Uint8Array {
	const body = value instanceof Uint8Array ? value : new Uint8Array(value);
	if (!Number.isSafeInteger(declaredSize) || declaredSize !== body.byteLength || body.byteLength > MAX_SETTINGS_FILE_BYTES) {
		throw new StoreAbort(500, "settings_corrupt");
	}
	return body;
}

export class SettingsSyncStore {
	private initialized = false;

	constructor(private readonly storage: SettingsDurableStorage) {}

	private ensureSchema(): void {
		if (this.initialized) return;
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_env (
			config_key TEXT PRIMARY KEY,
			env_rev INTEGER NOT NULL
		)`);
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_files (
			config_key TEXT NOT NULL,
			path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size INTEGER NOT NULL,
			rev INTEGER NOT NULL,
			body BLOB NOT NULL,
			PRIMARY KEY (config_key, path)
		)`);
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_intents (
			config_key TEXT NOT NULL,
			id TEXT NOT NULL,
			repo TEXT NOT NULL,
			version TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			rev INTEGER NOT NULL,
			PRIMARY KEY (config_key, id)
		)`);
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_themes (
			config_key TEXT NOT NULL,
			name TEXT NOT NULL,
			repo TEXT NOT NULL,
			version TEXT NOT NULL,
			rev INTEGER NOT NULL,
			PRIMARY KEY (config_key, name)
		)`);
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_tombstones (
			config_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			rev INTEGER NOT NULL,
			deleted_at INTEGER NOT NULL,
			PRIMARY KEY (config_key, kind, id)
		)`);
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS settings_plugin_data (
			config_key TEXT NOT NULL,
			plugin_id TEXT NOT NULL,
			plugin_version TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size INTEGER NOT NULL,
			rev INTEGER NOT NULL,
			body BLOB NOT NULL,
			PRIMARY KEY (config_key, plugin_id)
		)`);
		this.initialized = true;
	}

	private result<T>(operation: () => T): SettingsSyncResult<T> {
		try {
			return { ok: true, value: operation() };
		} catch (error) {
			if (error instanceof StoreAbort) return { ok: false, status: error.status, error: error.error };
			throw error;
		}
	}

	private environmentRevision(configKey: string): number | null {
		const row = this.storage.sql.exec<{ env_rev: number }>(
			"SELECT env_rev FROM settings_env WHERE config_key = ?",
			configKey,
		).toArray()[0];
		if (!row) return null;
		if (!safeRevision(row.env_rev)) throw new StoreAbort(500, "settings_corrupt");
		return row.env_rev;
	}

	private nextRevision(configKey: string): number {
		const current = this.environmentRevision(configKey);
		if (current === null) throw new StoreAbort(409, "not_seeded");
		if (current === Number.MAX_SAFE_INTEGER) throw new StoreAbort(409, "revision_exhausted");
		const next = current + 1;
		this.storage.sql.exec("UPDATE settings_env SET env_rev = ? WHERE config_key = ?", next, configKey);
		return next;
	}

	private rows<T extends Record<string, SqlStorageValue>>(query: string, configKey: string): T[] {
		return this.storage.sql.exec<T>(query, configKey).toArray();
	}

	private currentBodyBytes(configKey: string): number {
		const fileSizes = this.rows<{ size: number }>("SELECT size FROM settings_files WHERE config_key = ?", configKey);
		const pluginSizes = this.rows<{ size: number }>("SELECT size FROM settings_plugin_data WHERE config_key = ?", configKey);
		let total = 0;
		for (const row of [...fileSizes, ...pluginSizes]) {
			if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_SETTINGS_FILE_BYTES) {
				throw new StoreAbort(500, "settings_corrupt");
			}
			total += row.size;
			if (total > MAX_SETTINGS_ENVIRONMENT_BODY_BYTES) throw new StoreAbort(500, "settings_corrupt");
		}
		return total;
	}

	private assertUniqueCapacity(table: string, column: string, configKey: string, identity: string, maximum: number): void {
		const existing = this.storage.sql.exec<Record<string, SqlStorageValue>>(
			`SELECT ${column} FROM ${table} WHERE config_key = ?`,
			configKey,
		).toArray();
		if (existing.length > maximum) throw new StoreAbort(500, "settings_corrupt");
		if (existing.length === maximum && !existing.some((row) => row[column] === identity)) {
			throw new StoreAbort(413, "too_many_entries");
		}
	}

	getEnvironment(key: string): SettingsSyncResult<SettingsGetBody> {
		return this.result(() => {
			this.ensureSchema();
			const configKey = requireConfigKey(key);
			const envRev = this.environmentRevision(configKey);
			if (envRev === null) return { seeded: false as const };

			const fileRows = this.rows<{ path: string; sha256: string; size: number; rev: number; body: ArrayBuffer }>(
				"SELECT path, sha256, size, rev, body FROM settings_files WHERE config_key = ?",
				configKey,
			);
			const intentRows = this.rows<{ id: string; repo: string; version: string; enabled: number; rev: number }>(
				"SELECT id, repo, version, enabled, rev FROM settings_intents WHERE config_key = ?",
				configKey,
			);
			const themeRows = this.rows<{ name: string; repo: string; version: string; rev: number }>(
				"SELECT name, repo, version, rev FROM settings_themes WHERE config_key = ?",
				configKey,
			);
			const tombstoneRows = this.rows<{ kind: string; id: string; rev: number; deleted_at: number }>(
				"SELECT kind, id, rev, deleted_at FROM settings_tombstones WHERE config_key = ?",
				configKey,
			);
			const pluginRows = this.rows<{ plugin_id: string; plugin_version: string; sha256: string; size: number; rev: number; body: ArrayBuffer }>(
				"SELECT plugin_id, plugin_version, sha256, size, rev, body FROM settings_plugin_data WHERE config_key = ?",
				configKey,
			);
			if (fileRows.length > MAX_SETTINGS_FILES || intentRows.length > MAX_SETTINGS_INTENTS
				|| themeRows.length > MAX_SETTINGS_THEMES || tombstoneRows.length > MAX_SETTINGS_TOMBSTONES
				|| pluginRows.length > MAX_SETTINGS_PLUGIN_DATA) throw new StoreAbort(500, "settings_corrupt");

			let bodyBytes = 0;
			const files = fileRows.map((row): SettingsFileRow => {
				const body = storedBody(row.body, row.size);
				bodyBytes += body.byteLength;
				if (!isAllowlistedSettingsFile(row.path) || !isSha256Hex(row.sha256) || !safeRevision(row.rev)) {
					throw new StoreAbort(500, "settings_corrupt");
				}
				return { path: row.path, sha256: row.sha256, size: row.size, rev: row.rev, bodyBase64: bytesToBase64(body) };
			}).sort((a, b) => a.path.localeCompare(b.path));
			const pluginData = pluginRows.map((row): SettingsPluginDataRow => {
				const body = storedBody(row.body, row.size);
				bodyBytes += body.byteLength;
				if (!isAllowlistedPluginDataId(row.plugin_id) || row.plugin_version.length > MAX_SETTINGS_VERSION_LENGTH
					|| !isSha256Hex(row.sha256) || !safeRevision(row.rev)) throw new StoreAbort(500, "settings_corrupt");
				return { pluginId: row.plugin_id, pluginVersion: row.plugin_version, sha256: row.sha256,
					size: row.size, rev: row.rev, bodyBase64: bytesToBase64(body) };
			}).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
			if (bodyBytes > MAX_SETTINGS_ENVIRONMENT_BODY_BYTES) throw new StoreAbort(500, "settings_corrupt");

			const intents = intentRows.map((row): SettingsIntentRow => {
				if (!isAllowlistedPluginDataId(row.id) || row.repo.length > MAX_SETTINGS_REPO_LENGTH
					|| row.version.length > MAX_SETTINGS_VERSION_LENGTH || !safeRevision(row.rev)
					|| (row.enabled !== 0 && row.enabled !== 1)) throw new StoreAbort(500, "settings_corrupt");
				return { id: row.id, repo: row.repo, version: row.version, enabled: row.enabled === 1, rev: row.rev };
			}).sort((a, b) => a.id.localeCompare(b.id));
			const themes = themeRows.map((row): SettingsThemeRow => {
				if (row.name.length === 0 || row.name.length > MAX_SETTINGS_ID_LENGTH || row.repo.length > MAX_SETTINGS_REPO_LENGTH
					|| row.version.length > MAX_SETTINGS_VERSION_LENGTH || !safeRevision(row.rev)) {
					throw new StoreAbort(500, "settings_corrupt");
				}
				return { name: row.name, repo: row.repo, version: row.version, rev: row.rev };
			}).sort((a, b) => a.name.localeCompare(b.name));
			const tombstones = tombstoneRows.map((row): SettingsTombstoneRow => {
				if ((row.kind !== "plugin" && row.kind !== "theme") || row.id.length === 0
					|| row.id.length > MAX_SETTINGS_ID_LENGTH || !safeRevision(row.rev)
					|| !Number.isSafeInteger(row.deleted_at) || row.deleted_at < 0) throw new StoreAbort(500, "settings_corrupt");
				return { kind: row.kind, id: row.id, rev: row.rev, deletedAt: row.deleted_at };
			}).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
			return { seeded: true as const, envRev, files, intents, themes, tombstones, pluginData };
		});
	}

	seed(key: string, snapshot: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const parsed = parseSnapshot(snapshot);
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				if (this.environmentRevision(configKey) !== null) throw new StoreAbort(409, "already_seeded");
				this.storage.sql.exec("INSERT INTO settings_env (config_key, env_rev) VALUES (?, ?)", configKey, 1);
				this.replaceLiveRows(configKey, parsed, 1);
				return { envRev: 1, rev: 1 };
			});
		});
	}

	replace(key: string, snapshot: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const parsed = parseSnapshot(snapshot);
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				const current = this.environmentRevision(configKey);
				const rev = current === null ? 1 : this.checkedNextRevision(current);
				const tombstones = new Set(this.rows<{ kind: string; id: string }>(
					"SELECT kind, id FROM settings_tombstones WHERE config_key = ?",
					configKey,
				).map((row) => `${row.kind}:${row.id}`));
				for (const intent of parsed.intents) tombstones.delete(`plugin:${intent.id}`);
				for (const theme of parsed.themes) tombstones.delete(`theme:${theme.name}`);
				const livePlugins = new Set(parsed.intents.map((entry) => entry.id));
				const liveThemes = new Set(parsed.themes.map((entry) => entry.name));
				for (const row of this.rows<{ id: string }>("SELECT id FROM settings_intents WHERE config_key = ?", configKey)) {
					if (!livePlugins.has(row.id)) tombstones.add(`plugin:${row.id}`);
				}
				for (const row of this.rows<{ name: string }>("SELECT name FROM settings_themes WHERE config_key = ?", configKey)) {
					if (!liveThemes.has(row.name)) tombstones.add(`theme:${row.name}`);
				}
				if (tombstones.size > MAX_SETTINGS_TOMBSTONES) throw new StoreAbort(413, "too_many_entries");
				if (current === null) this.storage.sql.exec("INSERT INTO settings_env (config_key, env_rev) VALUES (?, ?)", configKey, rev);
				else this.storage.sql.exec("UPDATE settings_env SET env_rev = ? WHERE config_key = ?", rev, configKey);
				for (const row of this.rows<{ id: string }>("SELECT id FROM settings_intents WHERE config_key = ?", configKey)) {
					if (!livePlugins.has(row.id)) this.writeTombstone(configKey, "plugin", row.id, rev);
				}
				for (const row of this.rows<{ name: string }>("SELECT name FROM settings_themes WHERE config_key = ?", configKey)) {
					if (!liveThemes.has(row.name)) this.writeTombstone(configKey, "theme", row.name, rev);
				}
				this.replaceLiveRows(configKey, parsed, rev);
				return { envRev: rev, rev };
			});
		});
	}

	putFile(key: string, path: unknown, sha256: unknown, bodyBase64: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const file = parseFile({ path, sha256, bodyBase64 });
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				this.assertUniqueCapacity("settings_files", "path", configKey, file.path, MAX_SETTINGS_FILES);
				const prior = this.storage.sql.exec<{ size: number }>(
					"SELECT size FROM settings_files WHERE config_key = ? AND path = ?",
					configKey,
					file.path,
				).toArray()[0]?.size ?? 0;
				if (this.currentBodyBytes(configKey) - prior + file.body.byteLength > MAX_SETTINGS_ENVIRONMENT_BODY_BYTES) {
					throw new StoreAbort(413, "environment_too_large");
				}
				const rev = this.nextRevision(configKey);
				this.upsertFile(configKey, file, rev);
				return { envRev: rev, rev };
			});
		});
	}

	deleteFile(key: string, path: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			if (typeof path !== "string" || !isAllowlistedSettingsFile(path)) throw new StoreAbort(400, "path_not_allowed");
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				const rev = this.nextRevision(configKey);
				this.storage.sql.exec("DELETE FROM settings_files WHERE config_key = ? AND path = ?", configKey, path);
				return { envRev: rev, rev };
			});
		});
	}

	putIntent(key: string, value: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const intent = parseIntent(value);
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				this.assertUniqueCapacity("settings_intents", "id", configKey, intent.id, MAX_SETTINGS_INTENTS);
				const rev = this.nextRevision(configKey);
				this.upsertIntent(configKey, intent, rev);
				return { envRev: rev, rev };
			});
		});
	}

	putTombstone(key: string, value: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const input = record(value);
			exactKeys(input, ["kind", "id"]);
			if (input.kind !== "plugin" && input.kind !== "theme") throw new StoreAbort(400, "invalid_json");
			const kind = input.kind;
			const id = kind === "plugin" ? requirePluginId(input.id) : requireThemeName(input.id);
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				const identity = `${kind}\0${id}`;
				const existing = this.rows<{ kind: string; id: string }>(
					"SELECT kind, id FROM settings_tombstones WHERE config_key = ?",
					configKey,
				);
				if (existing.length > MAX_SETTINGS_TOMBSTONES) throw new StoreAbort(500, "settings_corrupt");
				if (existing.length === MAX_SETTINGS_TOMBSTONES
					&& !existing.some((row) => `${row.kind}\0${row.id}` === identity)) throw new StoreAbort(413, "too_many_entries");
				const rev = this.nextRevision(configKey);
				this.writeTombstone(configKey, kind, id, rev);
				return { envRev: rev, rev };
			});
		});
	}

	putPluginData(key: string, value: unknown): SettingsSyncResult<MutationOk> {
		return this.result(() => {
			const configKey = requireConfigKey(key);
			const entry = parsePluginData(value);
			this.ensureSchema();
			return this.storage.transactionSync(() => {
				this.assertPluginDataGate(configKey, entry.pluginId, entry.pluginVersion);
				this.assertUniqueCapacity("settings_plugin_data", "plugin_id", configKey, entry.pluginId, MAX_SETTINGS_PLUGIN_DATA);
				const prior = this.storage.sql.exec<{ size: number }>(
					"SELECT size FROM settings_plugin_data WHERE config_key = ? AND plugin_id = ?",
					configKey,
					entry.pluginId,
				).toArray()[0]?.size ?? 0;
				if (this.currentBodyBytes(configKey) - prior + entry.body.byteLength > MAX_SETTINGS_ENVIRONMENT_BODY_BYTES) {
					throw new StoreAbort(413, "environment_too_large");
				}
				const rev = this.nextRevision(configKey);
				this.upsertPluginData(configKey, entry, rev);
				return { envRev: rev, rev };
			});
		});
	}

	private checkedNextRevision(current: number): number {
		if (!safeRevision(current)) throw new StoreAbort(500, "settings_corrupt");
		if (current === Number.MAX_SAFE_INTEGER) throw new StoreAbort(409, "revision_exhausted");
		return current + 1;
	}

	private assertPluginDataGate(configKey: string, pluginId: string, pluginVersion: string): void {
		if (this.storage.sql.exec<{ rev: number }>(
			"SELECT rev FROM settings_tombstones WHERE config_key = ? AND kind = ? AND id = ?",
			configKey,
			"plugin",
			pluginId,
		).toArray()[0]) throw new StoreAbort(409, "plugin_tombstoned");
		const live = this.storage.sql.exec<{ version: string }>(
			"SELECT version FROM settings_intents WHERE config_key = ? AND id = ?",
			configKey,
			pluginId,
		).toArray()[0];
		if (!live || live.version !== pluginVersion) throw new StoreAbort(409, "plugin_version_mismatch");
	}

	private replaceLiveRows(configKey: string, snapshot: ParsedSnapshot, rev: number): void {
		this.storage.sql.exec("DELETE FROM settings_files WHERE config_key = ?", configKey);
		this.storage.sql.exec("DELETE FROM settings_intents WHERE config_key = ?", configKey);
		this.storage.sql.exec("DELETE FROM settings_themes WHERE config_key = ?", configKey);
		this.storage.sql.exec("DELETE FROM settings_plugin_data WHERE config_key = ?", configKey);
		for (const file of snapshot.files) this.upsertFile(configKey, file, rev);
		for (const intent of snapshot.intents) this.upsertIntent(configKey, intent, rev);
		for (const theme of snapshot.themes) this.upsertTheme(configKey, theme, rev);
		for (const entry of snapshot.pluginData) this.upsertPluginData(configKey, entry, rev);
	}

	private upsertFile(configKey: string, file: ParsedFile, rev: number): void {
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO settings_files (config_key, path, sha256, size, rev, body) VALUES (?, ?, ?, ?, ?, ?)",
			configKey, file.path, file.sha256, file.body.byteLength, rev, ownedBuffer(file.body),
		);
	}

	private upsertIntent(configKey: string, intent: ParsedIntent, rev: number): void {
		this.storage.sql.exec("DELETE FROM settings_tombstones WHERE config_key = ? AND kind = ? AND id = ?", configKey, "plugin", intent.id);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO settings_intents (config_key, id, repo, version, enabled, rev) VALUES (?, ?, ?, ?, ?, ?)",
			configKey, intent.id, intent.repo, intent.version, intent.enabled ? 1 : 0, rev,
		);
	}

	private upsertTheme(configKey: string, theme: ParsedTheme, rev: number): void {
		this.storage.sql.exec("DELETE FROM settings_tombstones WHERE config_key = ? AND kind = ? AND id = ?", configKey, "theme", theme.name);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO settings_themes (config_key, name, repo, version, rev) VALUES (?, ?, ?, ?, ?)",
			configKey, theme.name, theme.repo, theme.version, rev,
		);
	}

	private upsertPluginData(configKey: string, entry: ParsedPluginData, rev: number): void {
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO settings_plugin_data (config_key, plugin_id, plugin_version, sha256, size, rev, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
			configKey, entry.pluginId, entry.pluginVersion, entry.sha256, entry.body.byteLength, rev, ownedBuffer(entry.body),
		);
	}

	private writeTombstone(configKey: string, kind: "plugin" | "theme", id: string, rev: number): void {
		if (kind === "plugin") {
			this.storage.sql.exec("DELETE FROM settings_intents WHERE config_key = ? AND id = ?", configKey, id);
			this.storage.sql.exec("DELETE FROM settings_plugin_data WHERE config_key = ? AND plugin_id = ?", configKey, id);
		} else {
			this.storage.sql.exec("DELETE FROM settings_themes WHERE config_key = ? AND name = ?", configKey, id);
		}
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO settings_tombstones (config_key, kind, id, rev, deleted_at) VALUES (?, ?, ?, ?, ?)",
			configKey, kind, id, rev, Date.now(),
		);
	}
}

function mutationResponse(result: SettingsSyncResult<MutationOk>): Response {
	return result.ok
		? Response.json({ ok: true, envRev: result.value.envRev, rev: result.value.rev }, { headers: { "cache-control": "no-store" } })
		: Response.json({ error: result.error }, { status: result.status, headers: { "cache-control": "no-store" } });
}

function errorResponse(error: string, status: number): Response {
	return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

async function readJsonObject(request: Request, maxBytes: number): Promise<SettingsSyncResult<Record<string, unknown>>> {
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBytes(request, maxBytes);
	} catch (error) {
		if (error instanceof BoundedBodyError && error.kind === "body_too_large") {
			return { ok: false, status: 413, error: "request_too_large" };
		}
		if (error instanceof BoundedBodyError && error.kind === "invalid_content_length") {
			return { ok: false, status: 400, error: "invalid_content_length" };
		}
		return { ok: false, status: 400, error: "invalid_json" };
	}
	try {
		return { ok: true, value: record(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes))) };
	} catch {
		return { ok: false, status: 400, error: "invalid_json" };
	}
}

function boundedGetResponse(result: SettingsSyncResult<SettingsGetBody>): Response {
	if (!result.ok) return errorResponse(result.error, result.status);
	const body = JSON.stringify(result.value);
	if (new TextEncoder().encode(body).byteLength > MAX_SETTINGS_GET_RESPONSE_BYTES) {
		return errorResponse("environment_too_large", 413);
	}
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}


async function declaredBodyHashMatches(value: unknown): Promise<boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
	if (!("sha256" in value) || !("bodyBase64" in value)) return true;
	if (typeof value.sha256 !== "string" || typeof value.bodyBase64 !== "string") return true;
	try {
		const bytes = value.bodyBase64 === "" ? new Uint8Array(0) : base64ToBytes(value.bodyBase64);
		return await sha256Hex(bytes) === value.sha256;
	} catch {
		return true;
	}
}

async function requestBodyHashesMatch(
	action: string | undefined,
	body: Record<string, unknown>,
): Promise<boolean> {
	if (action === "file" || action === "plugin-data") return declaredBodyHashMatches(body);
	if (action !== "seed" && action !== "replace") return true;
	for (const [key, maximum] of [
		["files", MAX_SETTINGS_FILES],
		["pluginData", MAX_SETTINGS_PLUGIN_DATA],
	] as const) {
		const values = body[key];
		if (!Array.isArray(values) || values.length > maximum) continue;
		for (const value of values) {
			if (!await declaredBodyHashMatches(value)) return false;
		}
	}
	return true;
}

/** Dispatches the already-authorized, generation-fenced vault runtime route. */
export async function handleSettingsSyncRequest(
	store: SettingsSyncStore,
	request: Request,
	configKey: string,
	action?: string,
): Promise<Response> {
	const formatDeclarations = new URL(request.url).searchParams.getAll("settingsFormatVersion");
	if (formatDeclarations.length !== 1 || formatDeclarations[0] !== String(SETTINGS_FORMAT_VERSION)) {
		return Response.json({
			error: "update_required",
			reason: "settings_format_mismatch",
			clientSettingsFormatVersion: formatDeclarations.length === 1 ? formatDeclarations[0] : null,
			serverSettingsFormatVersion: SETTINGS_FORMAT_VERSION,
		}, { status: 426, headers: { "cache-control": "no-store" } });
	}
	if (request.method === "GET" && action === undefined) return boundedGetResponse(store.getEnvironment(configKey));
	if (request.method === "DELETE" && action === "file") {
		const path = new URL(request.url).searchParams.get("path");
		if (path === null) return errorResponse("invalid_json", 400);
		return mutationResponse(store.deleteFile(configKey, path));
	}
	const snapshotMutation = request.method === "PUT" && (action === "seed" || action === "replace");
	const itemMutation = request.method === "PUT" && (action === "file" || action === "intent"
		|| action === "tombstone" || action === "plugin-data");
	if (!snapshotMutation && !itemMutation) return errorResponse("not_found", 404);
	const body = await readJsonObject(
		request,
		snapshotMutation ? MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES : MAX_SETTINGS_ITEM_REQUEST_BYTES,
	);
	if (!body.ok) return errorResponse(body.error, body.status);
	if (!await requestBodyHashesMatch(action, body.value)) return errorResponse("hash_mismatch", 400);
	if (action === "seed") return mutationResponse(store.seed(configKey, body.value));
	if (action === "replace") return mutationResponse(store.replace(configKey, body.value));
	if (action === "file") return mutationResponse(store.putFile(configKey, body.value.path, body.value.sha256, body.value.bodyBase64));
	if (action === "intent") return mutationResponse(store.putIntent(configKey, body.value));
	if (action === "tombstone") return mutationResponse(store.putTombstone(configKey, body.value));
	return mutationResponse(store.putPluginData(configKey, body.value));
}
