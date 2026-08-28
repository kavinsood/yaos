import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { obsidianRequest } from "../../utils/http";
import {
	SETTINGS_SYNC_FORMAT_VERSION,
	SETTINGS_SYNC_MAX_AGGREGATE_BODY_BYTES,
	SETTINGS_SYNC_MAX_CONFIG_KEY_LENGTH,
	SETTINGS_SYNC_MAX_FILE_BYTES,
	SETTINGS_SYNC_MAX_FILES,
	SETTINGS_SYNC_MAX_ID_LENGTH,
	SETTINGS_SYNC_MAX_INTENTS,
	SETTINGS_SYNC_MAX_ITEM_REQUEST_BYTES,
	SETTINGS_SYNC_MAX_PATH_LENGTH,
	SETTINGS_SYNC_MAX_PLUGIN_DATA,
	SETTINGS_SYNC_MAX_REPO_LENGTH,
	SETTINGS_SYNC_MAX_RESPONSE_BYTES,
	SETTINGS_SYNC_MAX_SNAPSHOT_REQUEST_BYTES,
	SETTINGS_SYNC_MAX_THEMES,
	SETTINGS_SYNC_MAX_TOMBSTONES,
	SETTINGS_SYNC_MAX_VERSION_LENGTH,
	type SettingsSyncFile,
	type SettingsSyncFilePut,
	type SettingsSyncIntent,
	type SettingsSyncIntentPut,
	type SettingsSyncPluginData,
	type SettingsSyncPluginDataPut,
	type SettingsSyncSnapshot,
	type SettingsSyncState,
	type SettingsSyncTheme,
	type SettingsSyncTombstone,
	type SettingsSyncTombstonePut,
} from "./types";

export class SettingsSyncHttpError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = "SettingsSyncHttpError";
	}
}

export type SettingsSyncClientOptions = {
	host: string;
	deviceToken: string;
	vaultId: string;
	request?: (request: RequestUrlParam) => Promise<RequestUrlResponse>;
};

export class SettingsSyncClient {
	constructor(private readonly opts: SettingsSyncClientOptions) {}

	async getEnvironment(configDirKey: string): Promise<SettingsSyncState> {
		return parseSettingsSyncState(await this.request("GET", configDirKey));
	}
	async seed(configDirKey: string, snapshot: SettingsSyncSnapshot): Promise<unknown> {
		return this.request("PUT", configDirKey, "seed", snapshot);
	}
	async replace(configDirKey: string, snapshot: SettingsSyncSnapshot): Promise<unknown> {
		return this.request("PUT", configDirKey, "replace", snapshot);
	}
	async putFile(configDirKey: string, file: SettingsSyncFilePut): Promise<unknown> {
		return this.request("PUT", configDirKey, "file", file);
	}
	async deleteFile(configDirKey: string, path: string): Promise<unknown> {
		return this.request("DELETE", configDirKey, "file", { path }, { path });
	}
	async putIntent(configDirKey: string, intent: SettingsSyncIntentPut): Promise<unknown> {
		return this.request("PUT", configDirKey, "intent", intent);
	}
	async putTombstone(configDirKey: string, tombstone: SettingsSyncTombstonePut): Promise<unknown> {
		return this.request("PUT", configDirKey, "tombstone", tombstone);
	}
	async putPluginData(configDirKey: string, entry: SettingsSyncPluginDataPut): Promise<unknown> {
		return this.request("PUT", configDirKey, "plugin-data", entry);
	}

	private url(configDirKey: string, action?: string, query?: Record<string, string>): string {
		if (!configDirKey || configDirKey.length > SETTINGS_SYNC_MAX_CONFIG_KEY_LENGTH) {
			throw new Error("invalid settings config directory key");
		}
		const host = this.opts.host.replace(/\/$/, "");
		const path = `${host}/vault/${encodeURIComponent(this.opts.vaultId)}/settings-sync/${encodeURIComponent(configDirKey)}${action ? `/${action}` : ""}`;
		const params = new URLSearchParams({ settingsFormatVersion: String(SETTINGS_SYNC_FORMAT_VERSION) });
		for (const [name, value] of Object.entries(query ?? {})) params.append(name, value);
		return `${path}?${params.toString()}`;
	}

	private async request(method: "GET" | "PUT" | "DELETE", configDirKey: string, action?: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
		const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.deviceToken}` };
		let encodedBody: string | undefined;
		if (method !== "GET") {
			headers["Content-Type"] = "application/json";
			encodedBody = JSON.stringify(body ?? {});
			const limit = action === "seed" || action === "replace" ? SETTINGS_SYNC_MAX_SNAPSHOT_REQUEST_BYTES : SETTINGS_SYNC_MAX_ITEM_REQUEST_BYTES;
			if (utf8ByteLength(encodedBody) > limit) {
				throw new SettingsSyncHttpError(0, "request_too_large", "settings-sync request exceeds client bound");
			}
		}
		const response = await (this.opts.request ?? obsidianRequest)({
			url: this.url(configDirKey, action, query), method, headers,
			contentType: method === "GET" ? undefined : "application/json", body: encodedBody,
		});
		if (utf8ByteLength(response.text ?? "") > SETTINGS_SYNC_MAX_RESPONSE_BYTES) {
			throw new SettingsSyncHttpError(response.status, "response_too_large", "settings-sync response exceeds client bound");
		}
		if (response.status < 200 || response.status >= 300) throw readHttpError(response.status, response.json, response.text);
		if (response.status === 204) return undefined;
		return response.json ?? undefined;
	}
}

export function parseSettingsSyncState(value: unknown): SettingsSyncState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("response is not an object");
	const response = value as Record<string, unknown>;
	if (response.seeded === false) return { seeded: false };
	if (response.seeded !== true) invalid("response is missing seeded");
	const envRev = nonNegativeInteger(response.envRev, "envRev");
	const files = boundedArray(response.files, SETTINGS_SYNC_MAX_FILES, "files").map(parseFile);
	const intents = boundedArray(response.intents, SETTINGS_SYNC_MAX_INTENTS, "intents").map(parseIntent);
	const themes = boundedArray(response.themes, SETTINGS_SYNC_MAX_THEMES, "themes").map(parseTheme);
	const tombstones = boundedArray(response.tombstones, SETTINGS_SYNC_MAX_TOMBSTONES, "tombstones").map(parseTombstone);
	const pluginData = boundedArray(response.pluginData, SETTINGS_SYNC_MAX_PLUGIN_DATA, "pluginData").map(parsePluginData);
	assertUnique(files, (row) => row.path, "file path");
	assertUnique(intents, (row) => row.id, "plugin intent");
	assertUnique(themes, (row) => row.name, "theme");
	assertUnique(tombstones, (row) => `${row.kind}:${row.id}`, "tombstone");
	assertUnique(pluginData, (row) => row.pluginId, "plugin data");
	let decodedBytes = 0;
	for (const file of files) decodedBytes += file.size;
	for (const entry of pluginData) decodedBytes += entry.size;
	if (decodedBytes > SETTINGS_SYNC_MAX_AGGREGATE_BODY_BYTES) invalid("decoded body aggregate exceeds limit");
	return { seeded: true, envRev, files, intents, themes, tombstones, pluginData };
}

function parseFile(value: unknown): SettingsSyncFile {
	const row = objectRow(value, "file");
	const path = boundedString(row.path, 1, SETTINGS_SYNC_MAX_PATH_LENGTH, "file path");
	const sha256 = hashString(row.sha256, "file sha256");
	const size = nonNegativeInteger(row.size, "file size");
	const rev = nonNegativeInteger(row.rev, "file rev");
	const bodyBase64 = boundedString(row.bodyBase64, 0, base64MaxLength(SETTINGS_SYNC_MAX_FILE_BYTES), "file body");
	if (size !== decodedBase64Size(bodyBase64, "file body") || size > SETTINGS_SYNC_MAX_FILE_BYTES) invalid("file size does not match bounded body");
	return { path, sha256, size, rev, bodyBase64 };
}

function parseIntent(value: unknown): SettingsSyncIntent {
	const row = objectRow(value, "intent");
	if (typeof row.enabled !== "boolean") invalid("intent enabled is invalid");
	return { id: boundedString(row.id, 1, SETTINGS_SYNC_MAX_ID_LENGTH, "intent id"), repo: boundedString(row.repo, 1, SETTINGS_SYNC_MAX_REPO_LENGTH, "intent repo"), version: boundedString(row.version, 1, SETTINGS_SYNC_MAX_VERSION_LENGTH, "intent version"), enabled: row.enabled, rev: nonNegativeInteger(row.rev, "intent rev") };
}

function parseTheme(value: unknown): SettingsSyncTheme {
	const row = objectRow(value, "theme");
	return { name: boundedString(row.name, 1, SETTINGS_SYNC_MAX_ID_LENGTH, "theme name"), repo: boundedString(row.repo, 1, SETTINGS_SYNC_MAX_REPO_LENGTH, "theme repo"), version: boundedString(row.version, 1, SETTINGS_SYNC_MAX_VERSION_LENGTH, "theme version"), rev: nonNegativeInteger(row.rev, "theme rev") };
}

function parseTombstone(value: unknown): SettingsSyncTombstone {
	const row = objectRow(value, "tombstone");
	if (row.kind !== "plugin" && row.kind !== "theme") invalid("tombstone kind is invalid");
	return { kind: row.kind, id: boundedString(row.id, 1, SETTINGS_SYNC_MAX_ID_LENGTH, "tombstone id"), rev: nonNegativeInteger(row.rev, "tombstone rev"), deletedAt: nonNegativeInteger(row.deletedAt, "tombstone deletion time") };
}

function parsePluginData(value: unknown): SettingsSyncPluginData {
	const row = objectRow(value, "plugin data");
	const size = nonNegativeInteger(row.size, "plugin data size");
	const bodyBase64 = boundedString(row.bodyBase64, 0, base64MaxLength(SETTINGS_SYNC_MAX_FILE_BYTES), "plugin data body");
	if (size !== decodedBase64Size(bodyBase64, "plugin data body") || size > SETTINGS_SYNC_MAX_FILE_BYTES) invalid("plugin data size does not match bounded body");
	return { pluginId: boundedString(row.pluginId, 1, SETTINGS_SYNC_MAX_ID_LENGTH, "plugin data id"), pluginVersion: boundedString(row.pluginVersion, 1, SETTINGS_SYNC_MAX_VERSION_LENGTH, "plugin data version"), sha256: hashString(row.sha256, "plugin data sha256"), size, rev: nonNegativeInteger(row.rev, "plugin data rev"), bodyBase64 };
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} is not an object`);
	return value as Record<string, unknown>;
}
function boundedArray(value: unknown, limit: number, label: string): unknown[] {
	if (!Array.isArray(value) || value.length > limit) invalid(`${label} collection is invalid`);
	return value;
}
function boundedString(value: unknown, min: number, max: number, label: string): string {
	if (typeof value !== "string" || value.length < min || value.length > max) invalid(`${label} is invalid`);
	return value;
}
function hashString(value: unknown, label: string): string {
	const hash = boundedString(value, 64, 64, label);
	if (!/^[0-9a-f]{64}$/.test(hash)) invalid(`${label} is invalid`);
	return hash;
}
function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} is invalid`);
	return value as number;
}
function assertUnique<T>(rows: readonly T[], identity: (row: T) => string, label: string): void {
	const seen = new Set<string>();
	for (const row of rows) {
		const key = identity(row);
		if (seen.has(key)) invalid(`duplicate ${label}`);
		seen.add(key);
	}
}
function decodedBase64Size(value: string, label: string): number {
	if (value.length % 4 !== 0) invalid(`${label} is invalid base64`);
	let padding = 0;
	if (value.endsWith("==")) padding = 2;
	else if (value.endsWith("=")) padding = 1;
	const dataEnd = value.length - padding;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		const data = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
		if (index < dataEnd ? !data : code !== 61) invalid(`${label} is invalid base64`);
	}
	return (value.length / 4) * 3 - padding;
}
function base64MaxLength(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}
function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
		else bytes += 3;
	}
	return bytes;
}
function readHttpError(status: number, json: unknown, text: string): SettingsSyncHttpError {
	const response = typeof json === "object" && json !== null && !Array.isArray(json) ? json as Record<string, unknown> : null;
	const code = response && typeof response.error === "string" && response.error ? response.error : response && typeof response.code === "string" && response.code ? response.code : `http_${status}`;
	return new SettingsSyncHttpError(status, code, text || code);
}
function invalid(detail: string): never {
	throw new SettingsSyncHttpError(200, "invalid_response", `settings-sync ${detail}`);
}
