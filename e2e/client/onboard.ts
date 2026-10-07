/**
 * Reusable onboarding for client e2e runs against a real relay (ported from e2e/relay/smoke.ts).
 *
 *   const vault = await onboardVault("http://127.0.0.1:8787", { devices: 3, label: "multi" });
 *   // vault.devices[i].deviceToken -> createWsRelayPort({ baseUrl, credential: deviceToken, ... })
 *
 * Every call creates a FRESH vault:
 *  - an unclaimed server is claimed (a new operator recovery key is saved to the context file);
 *  - a claimed one is entered through operator login (key from the context file, or from
 *    opts.operatorContextFile = a JSON file with {operatorRecoveryKey}), then POST /operator/vaults.
 * Device 0 enrolls with the owner code; each further device enrolls with a fresh device pairing code
 * minted by device 0 (pairDevice() adds one later).
 *
 * Secrets (operator key, device tokens) are written ONLY to the 0600 context file
 * <logDir>/client-e2e-context-<host>.json, never to stdout. Use redact() before logging anything.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LOG_DIR = process.env.YAOS_E2E_LOG_DIR ?? "/Users/kavin/personal/obsidiansync/experiments/logs";

export interface OnboardDevice {
	readonly name: string;
	readonly deviceId: string;
	/** SECRET. */
	readonly deviceToken: string;
}

export interface OnboardedVault {
	readonly baseUrl: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly via: "claim" | "operator";
	readonly devices: OnboardDevice[];
}

export interface OnboardOptions {
	/** Devices to enroll (>= 1). Default 2. */
	readonly devices?: number;
	/** Used in the vault name and the context record. */
	readonly label?: string;
	readonly logDir?: string;
	/** JSON file with {operatorRecoveryKey} for a server claimed outside this machine. */
	readonly operatorContextFile?: string;
}

const SECRET_KEYS = new Set(["deviceToken", "operatorRecoveryKey", "ticket", "cookie", "pairingCode", "authorization", "credential"]);

/** Deep copy with secret-named fields replaced by "<redacted>". */
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.has(k) ? "<redacted>" : redact(v);
		return out;
	}
	return value;
}

const id = (bytes = 12) => randomBytes(bytes).toString("base64url");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function contextPath(baseUrl: string, logDir = DEFAULT_LOG_DIR): string {
	return join(logDir, `client-e2e-context-${new URL(baseUrl).host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

interface ContextFile { host?: string; operatorRecoveryKey?: string; vaults?: unknown[] }

function loadContext(path: string): ContextFile {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	return typeof parsed === "object" && parsed !== null ? parsed : {};
}

function saveContext(path: string, logDir: string, value: ContextFile): void {
	mkdirSync(logDir, { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

type JsonObject = Record<string, unknown>;

function obj(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

async function http(baseUrl: string, method: string, path: string, options: { token?: string; cookie?: string; json?: unknown } = {}):
	Promise<{ status: number; value: JsonObject; headers: Headers }> {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.cookie) headers.Cookie = options.cookie;
	// Operator routes and /claim require a same-origin Origin (relay D5, what a browser sends); harmless elsewhere.
	if (path === "/claim" || path.startsWith("/operator/")) headers.Origin = new URL(baseUrl).origin;
	let body: string | undefined;
	if (options.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(options.json);
	}
	const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
	const text = await response.text();
	let value: JsonObject = {};
	try {
		value = obj(text ? JSON.parse(text) : null);
	} catch {
		value = { raw: text.slice(0, 200) };
	}
	return { status: response.status, value, headers: response.headers };
}

const errorOf = (value: JsonObject) => (typeof value.error === "string" ? value.error : "");

/** POST /enroll with a pairing code; retries 202 (authorization fence pending). */
export async function enrollDevice(baseUrl: string, pairingCode: string, name: string):
	Promise<{ device: OnboardDevice; vaultId: string; vaultGeneration: string }> {
	const device: OnboardDevice = { name, deviceId: id(16), deviceToken: id(32) };
	const body = { pairingCode, enrollmentRequestId: id(16), deviceId: device.deviceId, deviceToken: device.deviceToken,
		deviceName: `client-e2e-${name}` };
	for (let attempt = 0; attempt < 10; attempt++) {
		const response = await http(baseUrl, "POST", "/enroll", { json: body });
		if (response.status === 202) {
			await sleep(1000);
			continue;
		}
		const { vaultId, vaultGeneration } = response.value;
		if (response.status !== 200 || response.value.deviceId !== device.deviceId || typeof vaultId !== "string" || typeof vaultGeneration !== "string") {
			throw new Error(`enroll ${name} failed ${response.status} ${errorOf(response.value)}`);
		}
		return { device, vaultId, vaultGeneration };
	}
	throw new Error(`enroll ${name}: authorization fence still pending`);
}

/** A device pairing code minted by an enrolled device. */
export async function devicePairingCode(baseUrl: string, vaultId: string, deviceToken: string): Promise<string> {
	const pairing = await http(baseUrl, "POST", `/vault/${encodeURIComponent(vaultId)}/auth/pairing-code`, { token: deviceToken,
		json: { purpose: "device" } });
	if (typeof pairing.value.pairingCode !== "string") throw new Error(`pairing code failed ${pairing.status} ${errorOf(pairing.value)}`);
	return pairing.value.pairingCode;
}

async function operatorLogin(baseUrl: string, key: string): Promise<string> {
	const response = await fetch(`${baseUrl}/operator/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(baseUrl).origin },
		body: JSON.stringify({ operatorRecoveryKey: key }) });
	await response.arrayBuffer();
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!response.ok || !cookie) throw new Error(`operator login failed (${response.status})`);
	return cookie;
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function recordVault(path: string, logDir: string, label: string, vault: OnboardedVault): void {
	const saved = loadContext(path);
	saveContext(path, logDir, {
		...saved,
		vaults: [...(saved.vaults ?? []), {
			label, vaultId: vault.vaultId, createdAt: new Date().toISOString(),
			devices: Object.fromEntries(vault.devices.map((d) => [d.name, d])),
		}],
	});
}

/** Fresh vault with `devices` enrolled devices (device 0 = owner). */
export async function onboardVault(baseUrlRaw: string, opts: OnboardOptions = {}): Promise<OnboardedVault> {
	const baseUrl = baseUrlRaw.replace(/\/+$/, "");
	const count = Math.max(1, opts.devices ?? 2);
	const label = opts.label ?? "client";
	const logDir = opts.logDir ?? DEFAULT_LOG_DIR;
	const path = contextPath(baseUrl, logDir);

	const caps = await http(baseUrl, "GET", "/api/capabilities");
	if (caps.status !== 200) throw new Error(`capabilities failed ${caps.status}`);
	if (caps.value.streams !== 1) throw new Error(`relay does not advertise streams=1 (got ${String(caps.value.streams)})`);
	const context = loadContext(path);
	let ownerCode: string;
	let via: OnboardedVault["via"];
	if (caps.value.claimed === false) {
		const operatorRecoveryKey = id(32);
		const claimed = await http(baseUrl, "POST", "/claim", { json: { operatorRecoveryKey } });
		if (claimed.status !== 200 || typeof claimed.value.pairingCode !== "string") {
			throw new Error(`claim failed ${claimed.status} ${errorOf(claimed.value)}`);
		}
		saveContext(path, logDir, { host: baseUrl, operatorRecoveryKey, vaults: [] });
		ownerCode = claimed.value.pairingCode;
		via = "claim";
	} else {
		let key = context.operatorRecoveryKey;
		if (!key && opts.operatorContextFile) {
			const external = obj(JSON.parse(readFileSync(opts.operatorContextFile, "utf8")));
			key = typeof external.operatorRecoveryKey === "string" ? external.operatorRecoveryKey : undefined;
		}
		if (!key) throw new Error(`${baseUrl} is claimed and no operator key is known (operatorContextFile)`);
		if (!context.operatorRecoveryKey) saveContext(path, logDir, { host: baseUrl, operatorRecoveryKey: key, vaults: context.vaults ?? [] });
		const cookie = await operatorLogin(baseUrl, key);
		const created = await http(baseUrl, "POST", "/operator/vaults", { cookie, json: { name: `client-e2e-${label}-${stamp()}` } });
		const vaultId = obj(created.value.vault).vaultId;
		if (created.status < 200 || created.status > 299 || typeof vaultId !== "string") {
			throw new Error(`create vault failed ${created.status} ${errorOf(created.value)}`);
		}
		const code = await http(baseUrl, "POST", `/operator/vaults/${encodeURIComponent(vaultId)}/owner-code`, { cookie,
			json: { purpose: "owner-bootstrap" } });
		if (typeof code.value.pairingCode !== "string") throw new Error(`owner-code failed ${code.status} ${errorOf(code.value)}`);
		ownerCode = code.value.pairingCode;
		via = "operator";
	}

	const owner = await enrollDevice(baseUrl, ownerCode, "D0");
	const devices: OnboardDevice[] = [owner.device];
	for (let i = 1; i < count; i++) {
		const code = await devicePairingCode(baseUrl, owner.vaultId, owner.device.deviceToken);
		const next = await enrollDevice(baseUrl, code, `D${i}`);
		if (next.vaultId !== owner.vaultId || next.vaultGeneration !== owner.vaultGeneration) throw new Error(`device D${i} joined a different vault`);
		devices.push(next.device);
	}
	const vault: OnboardedVault = { baseUrl, vaultId: owner.vaultId, vaultGeneration: owner.vaultGeneration, via, devices };
	recordVault(path, logDir, label, vault);
	return vault;
}

/** Console revoke (relay D7): DELETE /operator/vaults/:id/devices/:deviceId under an operator session. */
export async function revokeDevice(vault: OnboardedVault, deviceId: string, logDir = DEFAULT_LOG_DIR): Promise<void> {
	const key = loadContext(contextPath(vault.baseUrl, logDir)).operatorRecoveryKey;
	if (!key) throw new Error(`no operator key is known for ${vault.baseUrl}`);
	const cookie = await operatorLogin(vault.baseUrl, key);
	const r = await http(vault.baseUrl, "DELETE", `/operator/vaults/${encodeURIComponent(vault.vaultId)}/devices/${encodeURIComponent(deviceId)}`, { cookie });
	if (r.status !== 200 || r.value.ok !== true) throw new Error(`revoke failed ${r.status} ${errorOf(r.value)}`);
}

/** Enrolls one more device into an onboarded vault (pairing code minted by device 0). Mutates vault.devices. */
export async function pairDevice(vault: OnboardedVault, name: string, logDir = DEFAULT_LOG_DIR): Promise<OnboardDevice> {
	const owner = vault.devices[0];
	if (!owner) throw new Error("vault has no devices");
	const code = await devicePairingCode(vault.baseUrl, vault.vaultId, owner.deviceToken);
	const next = await enrollDevice(vault.baseUrl, code, name);
	if (next.vaultId !== vault.vaultId) throw new Error(`device ${name} joined a different vault`);
	vault.devices.push(next.device);
	recordVault(contextPath(vault.baseUrl, logDir), logDir, `${name}-added`, { ...vault, devices: [next.device] });
	return next.device;
}
