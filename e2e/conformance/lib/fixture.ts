/**
 * Fixture: operator login (key read from the --operator-context file, never printed, never written back),
 * fresh vaults via the operator console, device enrollment. Nothing here writes to disk.
 */
import { readFileSync } from "node:fs";
import type { Ctx } from "./context.ts";
import { memo, secret } from "./context.ts";
import { http, vaultPath } from "./http.ts";
import { id, sleep } from "./util.ts";

export interface Device { label: string; deviceId: string; token: string; deviceName: string }
export interface IssuedCode { kind: "owner" | "device"; code: string }
export interface Vault {
	key: string;
	vaultId: string;
	vaultGeneration: string;
	path: string;
	devices: Device[];
	owner: Device;
	/** In memory only (secrets). */
	codes: IssuedCode[];
}

export function operatorCookie(ctx: Ctx): Promise<string> {
	return memo(ctx, "operator-cookie", async () => {
		if (!ctx.operatorContextPath) throw new Error("server is claimed: pass --operator-context <json with operatorRecoveryKey>");
		const key = JSON.parse(readFileSync(ctx.operatorContextPath, "utf8")).operatorRecoveryKey;
		if (typeof key !== "string" || key.length < 32) throw new Error("operator context has no usable operatorRecoveryKey");
		secret(ctx, key);
		const response = await fetch(`${ctx.host}/operator/login`, { method: "POST",
			headers: { "Content-Type": "application/json", Origin: new URL(ctx.host).origin },
			body: JSON.stringify({ operatorRecoveryKey: key }), signal: AbortSignal.timeout(30000) });
		await response.arrayBuffer();
		const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
		if (!response.ok || !cookie) throw new Error(`operator login failed (${response.status})`);
		secret(ctx, cookie);
		secret(ctx, cookie.slice(cookie.indexOf("=") + 1));
		return cookie;
	});
}

export function newDeviceIdentity(ctx: Ctx, label: string, vaultKey: string): Device {
	const device = { label, deviceId: id(16), token: id(32), deviceName: `conformance-${ctx.label}-${vaultKey}-${label}` };
	secret(ctx, device.token);
	return device;
}

const ENROLL_FIELDS = ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"];

export function enrollBody(device: Device, pairingCode: string, enrollmentRequestId = id(16)) {
	return { pairingCode, enrollmentRequestId, deviceId: device.deviceId, deviceToken: device.token, deviceName: device.deviceName };
}

/** Enrolls with retry on 202 (authorization_fence_pending); records the first status in ctx.enrollLog. */
export async function enroll(ctx: Ctx, vaultKey: string, pairingCode: string, label: string):
	Promise<{ device: Device; vaultId: string; vaultGeneration: string; role: unknown }> {
	const device = newDeviceIdentity(ctx, label, vaultKey);
	const body = enrollBody(device, pairingCode);
	const statuses: number[] = [];
	for (let attempt = 0; attempt < 10; attempt++) {
		const response = await http(ctx, "POST", "/enroll", { json: body });
		statuses.push(response.status);
		if (response.status === 202) { await sleep(1000); continue; }
		const v = response.value ?? {};
		// D3 / §5 row 2.4: exactly the six fields the client's readEnrollment reads (no principalId: D6 is VAULT_READY only).
		const bodyOk = response.status === 200 && Object.keys(v).sort().join() === ENROLL_FIELDS.join()
			&& typeof v.host === "string" && v.deviceToken === device.token && v.deviceId === device.deviceId
			&& typeof v.vaultId === "string" && typeof v.deviceName === "string" && typeof v.vaultGeneration === "string";
		ctx.enrollLog.push({ vaultKey, device: label, firstStatus: statuses[0]!, statuses, ok: response.status === 200, bodyOk });
		if (response.status !== 200 || v.deviceId !== device.deviceId) {
			throw new Error(`enroll ${vaultKey}/${label} failed ${response.status} ${String(v.error ?? "")}`);
		}
		return { device, vaultId: v.vaultId, vaultGeneration: v.vaultGeneration, role: v.role };
	}
	ctx.enrollLog.push({ vaultKey, device: label, firstStatus: statuses[0]!, statuses, ok: false, bodyOk: false });
	throw new Error(`enroll ${vaultKey}/${label}: authorization fence still pending after 10 attempts`);
}

export async function devicePairingCode(ctx: Ctx, vault: Vault, by: Device = vault.owner): Promise<string> {
	const response = await http(ctx, "POST", `${vault.path}/auth/pairing-code`, { token: by.token, json: { purpose: "device" } });
	if (typeof response.value?.pairingCode !== "string") throw new Error(`pairing-code failed ${response.status} ${String(response.value?.error ?? "")}`);
	secret(ctx, response.value.pairingCode);
	return response.value.pairingCode;
}

export async function addDevice(ctx: Ctx, vault: Vault, label: string): Promise<Device> {
	const code = await devicePairingCode(ctx, vault);
	vault.codes.push({ kind: "device", code });
	const enrolled = await enroll(ctx, vault.key, code, label);
	if (enrolled.vaultId !== vault.vaultId) throw new Error(`device ${label} joined a different vault`);
	vault.devices.push(enrolled.device);
	ctx.vaultSummaries.find((v) => v.key === vault.key)?.devices.push(label);
	return enrolled.device;
}

/** Creates a fresh vault through the operator console and enrolls `labels` (first = owner via owner code). */
export async function createVault(ctx: Ctx, key: string, labels: string[]): Promise<Vault> {
	const cookie = await operatorCookie(ctx);
	const created = await http(ctx, "POST", "/operator/vaults", { cookie, json: { name: `conformance-${ctx.label}-${ctx.stamp}-${key}` } });
	const vaultId = created.value?.vault?.vaultId;
	if (created.status < 200 || created.status > 299 || typeof vaultId !== "string") {
		throw new Error(`create vault ${key} failed ${created.status} ${String(created.value?.error ?? "")}`);
	}
	const owner = await http(ctx, "POST", `/operator/vaults/${encodeURIComponent(vaultId)}/owner-code`, { cookie,
		json: { purpose: "owner-bootstrap" } });
	if (typeof owner.value?.pairingCode !== "string") throw new Error(`owner-code ${key} failed ${owner.status} ${String(owner.value?.error ?? "")}`);
	secret(ctx, owner.value.pairingCode);
	ctx.vaultSummaries.push({ key, vaultIdPrefix: vaultId.slice(0, 8), devices: [] });
	const first = await enroll(ctx, key, owner.value.pairingCode, labels[0] ?? "A");
	if (first.vaultId !== vaultId) throw new Error(`owner of ${key} joined a different vault`);
	const vault: Vault = { key, vaultId, vaultGeneration: first.vaultGeneration, path: vaultPath(vaultId), devices: [first.device],
		owner: first.device, codes: [{ kind: "owner", code: owner.value.pairingCode }] };
	ctx.vaultSummaries.find((v) => v.key === key)!.devices.push(first.device.label);
	for (const label of labels.slice(1)) await addDevice(ctx, vault, label);
	return vault;
}

/** Memoized fresh vault per key for this run. */
export function vault(ctx: Ctx, key: string, labels: string[] = ["A", "B"]): Promise<Vault> {
	return memo(ctx, `vault:${key}`, () => createVault(ctx, key, labels));
}

export function device(v: Vault, label: string): Device {
	const found = v.devices.find((d) => d.label === label);
	if (!found) throw new Error(`no device ${label} in vault ${v.key}`);
	return found;
}

/** Returns the labelled device, enrolling it on first use. */
export function ensureDevice(ctx: Ctx, v: Vault, label: string): Promise<Device> {
	return memo(ctx, `device:${v.key}:${label}`, async () => v.devices.find((d) => d.label === label) ?? addDevice(ctx, v, label));
}
