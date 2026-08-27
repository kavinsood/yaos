import { randomBase64Url } from "./base64url";
import {
	CONFIG_FORMAT,
	PAIRING_CODE_TTL_MS,
	type DevicePublic,
	type DeviceRecord,
	type OperatorSessionRecord,
	type PairingCodePublic,
	type PairingCodeRecord,
	type PairingPurpose,
	type VaultRecord,
	findHashedRecord,
	isUsableVaultId,
	toDevicePublic,
	toPairingPublic,
	uniqueDeviceName,
} from "./identity";
import { json } from "./routes/http";

const CONFIG_FORMAT_KEY = "configFormat";
const CLAIMED_KEY = "claimed";
const OPERATOR_RECOVERY_HASH_KEY = "operatorRecoveryHash";
const TICKET_SIGNING_KEY = "ticketSigningKey";
const UPDATE_PROVIDER_KEY = "updateProvider";
const UPDATE_REPO_URL_KEY = "updateRepoUrl";
const UPDATE_REPO_BRANCH_KEY = "updateRepoBranch";
const DEVICES_KEY = "devices";
const PAIRING_CODES_KEY = "pairingCodes";
const VAULTS_KEY = "vaults";
const SESSIONS_KEY = "operatorSessions";
const PENDING_DESTROYS_KEY = "pendingVaultDestroys";
const MAX_PENDING_DESTROYS = 256;
const MAX_PENDING_DESTROY_ERROR_LENGTH = 512;

export interface PendingDestroyRecord {
	vaultId: string;
	requestedAt: number;
	roomComplete: boolean;
	r2Complete: boolean;
	lastError: string | null;
}

type UpdateProvider = "github" | "gitlab" | "unknown";

export interface StoredServerConfig {
	configFormat: number | null;
	claimed: boolean;
	operatorRecoveryHash: string | null;
	ticketSigningKey: string | null;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
}

export interface ConsoleState {
	vaults: VaultRecord[];
	devices: DevicePublic[];
	pairingCodes: PairingCodePublic[];
	pendingDestroys: PendingDestroyRecord[];
}

function normalizeUpdateProvider(value: unknown): UpdateProvider | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateProvider");
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "github" || raw === "gitlab" || raw === "unknown") return raw;
	throw new Error("invalid updateProvider");
}

function normalizeUpdateRepoUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoUrl");
	const raw = value.trim();
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.pathname.split("/").filter(Boolean).length < 2) {
		throw new Error("invalid updateRepoUrl");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeUpdateRepoBranch(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoBranch");
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) {
		throw new Error("invalid updateRepoBranch");
	}
	return raw;
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function boundedDestroyError(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, MAX_PENDING_DESTROY_ERROR_LENGTH) : null;
}

function asPendingDestroys(value: unknown): PendingDestroyRecord[] {
	if (!Array.isArray(value)) return [];
	const records: PendingDestroyRecord[] = [];
	for (const item of value) {
		if (
			typeof item !== "object"
			|| item === null
			|| typeof (item as Partial<PendingDestroyRecord>).vaultId !== "string"
			|| typeof (item as Partial<PendingDestroyRecord>).requestedAt !== "number"
		) {
			continue;
		}
		const record = item as Partial<PendingDestroyRecord>;
		records.push({
			vaultId: record.vaultId!,
			requestedAt: record.requestedAt!,
			roomComplete: record.roomComplete === true,
			r2Complete: record.r2Complete === true,
			lastError: boundedDestroyError(record.lastError),
		});
		if (records.length >= MAX_PENDING_DESTROYS) break;
	}
	return records;
}

export class ServerConfig {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/__yaos/config") return json(await this.readConfig());
		if (request.method === "GET" && pathname === "/__yaos/console") return json(await this.readConsole());
		if (request.method !== "POST") return json({ error: "not found" }, 404);

		switch (pathname) {
			case "/__yaos/claim": return this.handleClaim(request);
			case "/__yaos/update-metadata": return this.handleUpdateMetadata(request);
			case "/__yaos/enroll": return this.handleEnroll(request);
			case "/__yaos/create-pairing-code": return this.handleCreatePairingCode(request);
			case "/__yaos/authorize-device": return this.handleAuthorizeDevice(request);
			case "/__yaos/create-session": return this.handleCreateSession(request);
			case "/__yaos/verify-session": return this.handleVerifySession(request);
			case "/__yaos/revoke-session": return this.handleRevokeSession(request);
			case "/__yaos/verify-operator": return this.handleVerifyOperator(request);
			case "/__yaos/revoke-device": return this.handleRevokeDevice(request);
			case "/__yaos/rename-device": return this.handleRenameDevice(request);
			case "/__yaos/verify-device": return this.handleVerifyDevice(request);
			case "/__yaos/create-vault": return this.handleCreateVault(request);
			case "/__yaos/touch-device": return this.handleTouchDevice(request);
			case "/__yaos/rename-vault": return this.handleRenameVault(request);
			case "/__yaos/destroy-vault": return this.handleDestroyVault(request);
			case "/__yaos/update-destroy-vault": return this.handleUpdateDestroyVault(request);
			case "/__yaos/revoke-pairing": return this.handleRevokePairing(request);
			default: return json({ error: "not found" }, 404);
		}
	}

	private async handleClaim(request: Request): Promise<Response> {
		let body: {
			operatorRecoveryHash?: string;
			ticketSigningKey?: string;
			vaultId?: string;
			vaultName?: string;
			pairingCodeHash?: string;
			pairingPurpose?: PairingPurpose;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.operatorRecoveryHash !== "string" || !body.operatorRecoveryHash) {
			return json({ error: "missing operatorRecoveryHash" }, 400);
		}
		if (typeof body.ticketSigningKey !== "string" || !body.ticketSigningKey) {
			return json({ error: "missing ticketSigningKey" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		if (typeof body.pairingCodeHash !== "string" || !body.pairingCodeHash) {
			return json({ error: "missing pairingCodeHash" }, 400);
		}
		const now = Date.now();
		const pairingExp = now + PAIRING_CODE_TTL_MS;
		const vaultId = body.vaultId.trim();
		const vaultName = typeof body.vaultName === "string" && body.vaultName.trim()
			? body.vaultName.trim().slice(0, 80)
			: "Personal";
		const purpose: PairingPurpose = body.pairingPurpose === "invite" ? "invite" : "device";

		return this.state.storage.transaction(async (txn) => {
			const claimed = await txn.get<boolean>(CLAIMED_KEY);
			const format = await txn.get<number>(CONFIG_FORMAT_KEY);
			if (claimed === true && format !== CONFIG_FORMAT) {
				return json({ error: "server_format_unsupported" }, 409);
			}
			if (claimed === true || format !== undefined) {
				return json({ error: "already_claimed" }, 403);
			}
			const vault: VaultRecord = { vaultId, name: vaultName, createdAt: now };
			const pairing: PairingCodeRecord = {
				codeId: randomBase64Url(12),
				codeHash: body.pairingCodeHash!,
				vaultId,
				exp: pairingExp,
				maxUses: 1,
				uses: 0,
				purpose,
				createdAt: now,
			};
			await txn.put(CONFIG_FORMAT_KEY, CONFIG_FORMAT);
			await txn.put(CLAIMED_KEY, true);
			await txn.put(OPERATOR_RECOVERY_HASH_KEY, body.operatorRecoveryHash!);
			await txn.put(TICKET_SIGNING_KEY, body.ticketSigningKey!);
			await txn.put(VAULTS_KEY, [vault]);
			await txn.put(DEVICES_KEY, []);
			await txn.put(PAIRING_CODES_KEY, [pairing]);
			await txn.put(SESSIONS_KEY, []);
			await txn.put(PENDING_DESTROYS_KEY, []);
			return json({ ok: true, vaultId, vaultName, pairingExp });
		});
	}

	private async handleUpdateMetadata(request: Request): Promise<Response> {
		let body: { updateProvider?: unknown; updateRepoUrl?: unknown; updateRepoBranch?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		let updateProvider: UpdateProvider | null;
		let updateRepoUrl: string | null;
		let updateRepoBranch: string | null;
		try {
			updateProvider = normalizeUpdateProvider(body.updateProvider);
			updateRepoUrl = normalizeUpdateRepoUrl(body.updateRepoUrl);
			updateRepoBranch = normalizeUpdateRepoBranch(body.updateRepoBranch);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "invalid metadata" }, 400);
		}
		await this.state.storage.transaction(async (txn) => {
			if (updateProvider !== null) await txn.put(UPDATE_PROVIDER_KEY, updateProvider);
			if (updateRepoUrl !== null) await txn.put(UPDATE_REPO_URL_KEY, updateRepoUrl);
			if (updateRepoBranch !== null) await txn.put(UPDATE_REPO_BRANCH_KEY, updateRepoBranch);
		});
		return json({ ok: true, config: await this.readConfig() });
	}

	private async handleEnroll(request: Request): Promise<Response> {
		let body: { pairingCodeHash?: string; deviceId?: string; deviceTokenHash?: string; deviceName?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.pairingCodeHash || !body.deviceId || !body.deviceTokenHash) {
			return json({ error: "invalid enroll" }, 400);
		}
		const desiredName = typeof body.deviceName === "string" && body.deviceName.trim()
			? body.deviceName.trim().slice(0, 50)
			: "unnamed-device";
		return this.state.storage.transaction(async (txn) => {
			const codes = asArray<PairingCodeRecord>(await txn.get(PAIRING_CODES_KEY));
			const match = findHashedRecord(codes, body.pairingCodeHash!, (code) => code.codeHash);
			if (!match) return json({ error: "unknown_code", message: "This pairing code is not recognized." }, 404);
			const now = Date.now();
			if (match.exp <= now) return json({ error: "expired_code", message: "This pairing code has expired. Ask for a new one." }, 410);
			if (match.uses >= 1) return json({ error: "used_code", message: "This pairing code was already used." }, 409);
			const vaults = asArray<VaultRecord>(await txn.get(VAULTS_KEY));
			if (!vaults.some((vault) => vault.vaultId === match.vaultId)) return json({ error: "unknown_vault" }, 404);
			const devices = asArray<DeviceRecord>(await txn.get(DEVICES_KEY));
			if (devices.some((device) => device.deviceId === body.deviceId || device.tokenHash === body.deviceTokenHash)) {
				return json({ error: "device_exists" }, 409);
			}
			const name = uniqueDeviceName(
				desiredName,
				devices.filter((device) => device.vaultId === match.vaultId).map((device) => device.name),
			);
			const device: DeviceRecord = {
				deviceId: body.deviceId!,
				vaultId: match.vaultId,
				tokenHash: body.deviceTokenHash!,
				name,
				enrolledAt: now,
			};
			devices.push(device);
			await txn.put(DEVICES_KEY, devices);
			await txn.put(PAIRING_CODES_KEY, codes.filter((code) => code !== match && code.exp > now && code.uses < 1));
			return json({ ok: true, vaultId: device.vaultId, deviceId: device.deviceId, deviceName: name });
		});
	}

	private async handleCreatePairingCode(request: Request): Promise<Response> {
		let body: { vaultId?: string; codeHash?: string; purpose?: PairingPurpose };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.vaultId || !body.codeHash) {
			return json({ error: "invalid pairing code" }, 400);
		}
		const now = Date.now();
		const exp = now + PAIRING_CODE_TTL_MS;
		return this.state.storage.transaction(async (txn) => {
			const vaults = asArray<VaultRecord>(await txn.get(VAULTS_KEY));
			if (!vaults.some((vault) => vault.vaultId === body.vaultId)) return json({ error: "unknown_vault" }, 404);
			const codes = asArray<PairingCodeRecord>(await txn.get(PAIRING_CODES_KEY))
				.filter((code) => code.exp > now && code.uses < 1);
			codes.push({
				codeId: randomBase64Url(12),
				codeHash: body.codeHash!,
				vaultId: body.vaultId!,
				exp,
				maxUses: 1,
				uses: 0,
				purpose: body.purpose === "invite" ? "invite" : "device",
				createdAt: now,
			});
			await txn.put(PAIRING_CODES_KEY, codes);
			return json({ ok: true, exp });
		});
	}

	private async handleAuthorizeDevice(request: Request): Promise<Response> {
		let body: { tokenHash?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "unauthorized" }, 401);
		}
		if (!body.tokenHash) return json({ error: "unauthorized" }, 401);
		const devices = asArray<DeviceRecord>(await this.state.storage.get(DEVICES_KEY));
		const device = findHashedRecord(devices, body.tokenHash, (record) => record.tokenHash);
		if (!device || (body.vaultId !== undefined && device.vaultId !== body.vaultId)) {
			return json({ error: "unauthorized" }, 401);
		}
		return json({ ok: true, device: toDevicePublic(device) });
	}

	private async handleCreateSession(request: Request): Promise<Response> {
		let body: { sessionHash?: string; exp?: number };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const now = Date.now();
		if (!body.sessionHash || typeof body.exp !== "number" || body.exp <= now) {
			return json({ error: "invalid session" }, 400);
		}
		return this.state.storage.transaction(async (txn) => {
			const sessions = asArray<OperatorSessionRecord>(await txn.get(SESSIONS_KEY))
				.filter((session) => session.exp > now);
			sessions.push({ sessionHash: body.sessionHash!, exp: body.exp!, createdAt: now });
			await txn.put(SESSIONS_KEY, sessions);
			return json({ ok: true });
		});
	}

	private async handleVerifySession(request: Request): Promise<Response> {
		let body: { sessionHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ ok: false }, 401);
		}
		if (!body.sessionHash) return json({ ok: false }, 401);
		const sessions = asArray<OperatorSessionRecord>(await this.state.storage.get(SESSIONS_KEY));
		const match = findHashedRecord(sessions, body.sessionHash, (session) => session.sessionHash);
		return match && match.exp > Date.now() ? json({ ok: true }) : json({ ok: false }, 401);
	}
	private async handleRevokeSession(request: Request): Promise<Response> {
		let body: { sessionHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.sessionHash) return json({ error: "invalid session" }, 400);
		const now = Date.now();
		return this.state.storage.transaction(async (txn) => {
			const sessions = asArray<OperatorSessionRecord>(await txn.get(SESSIONS_KEY));
			const match = findHashedRecord(sessions, body.sessionHash!, (session) => session.sessionHash);
			const next = sessions.filter((session) => session.exp > now && session !== match);
			await txn.put(SESSIONS_KEY, next);
			return match ? json({ ok: true }) : json({ error: "unknown_session" }, 404);
		});
	}


	private async handleVerifyOperator(request: Request): Promise<Response> {
		let body: { operatorRecoveryHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ ok: false }, 401);
		}
		const stored = await this.state.storage.get<string>(OPERATOR_RECOVERY_HASH_KEY);
		if (
			typeof body.operatorRecoveryHash !== "string" || typeof stored !== "string"
			|| !findHashedRecord([{ hash: stored }], body.operatorRecoveryHash, (record) => record.hash)
		) {
			return json({ ok: false }, 401);
		}
		return json({ ok: true });
	}

	private async handleRevokeDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.deviceId) return json({ error: "invalid deviceId" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const devices = asArray<DeviceRecord>(await txn.get(DEVICES_KEY));
			const next = devices.filter((device) => device.deviceId !== body.deviceId);
			if (next.length === devices.length) return json({ error: "unknown_device" }, 404);
			await txn.put(DEVICES_KEY, next);
			return json({ ok: true });
		});
	}

	private async handleRenameDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!body.deviceId) return json({ error: "invalid deviceId" }, 400);
		if (name.length < 1 || name.length > 50) return json({ error: "invalid name" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const devices = asArray<DeviceRecord>(await txn.get(DEVICES_KEY));
			const device = devices.find((record) => record.deviceId === body.deviceId);
			if (!device) return json({ error: "unknown_device" }, 404);
			device.name = uniqueDeviceName(
				name,
				devices.filter((record) => record.vaultId === device.vaultId && record !== device).map((record) => record.name),
			);
			await txn.put(DEVICES_KEY, devices);
			return json({ ok: true, device: toDevicePublic(device) });
		});
	}

	private async handleVerifyDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "unauthorized" }, 401);
		}
		if (!body.deviceId || !body.vaultId) return json({ error: "unauthorized" }, 401);
		const devices = asArray<DeviceRecord>(await this.state.storage.get(DEVICES_KEY));
		return devices.some((device) => device.deviceId === body.deviceId && device.vaultId === body.vaultId)
			? json({ ok: true })
			: json({ error: "unauthorized" }, 401);
	}

	private async handleCreateVault(request: Request): Promise<Response> {
		let body: { vaultId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		const vaultId = body.vaultId.trim();
		const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Vault";
		return this.state.storage.transaction(async (txn) => {
			const vaults = asArray<VaultRecord>(await txn.get(VAULTS_KEY));
			const pendingDestroys = asPendingDestroys(await txn.get(PENDING_DESTROYS_KEY));
			if (pendingDestroys.some((record) => record.vaultId === vaultId)) {
				return json({ error: "vault_destroy_pending" }, 409);
			}
			if (vaults.some((vault) => vault.vaultId === vaultId)) return json({ error: "vault_exists" }, 409);
			const vault: VaultRecord = { vaultId, name, createdAt: Date.now() };
			vaults.push(vault);
			await txn.put(VAULTS_KEY, vaults);
			return json({ ok: true, vault });
		});
	}

	private async handleTouchDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.deviceId || !body.vaultId) return json({ error: "invalid device" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const devices = asArray<DeviceRecord>(await txn.get(DEVICES_KEY));
			const device = devices.find((record) => record.deviceId === body.deviceId && record.vaultId === body.vaultId);
			if (!device) return json({ error: "unknown_device" }, 404);
			device.lastSeenAt = Date.now();
			await txn.put(DEVICES_KEY, devices);
			return json({ ok: true });
		});
	}

	private async handleRenameVault(request: Request): Promise<Response> {
		let body: { vaultId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!body.vaultId) return json({ error: "invalid vaultId" }, 400);
		if (name.length < 1 || name.length > 80) return json({ error: "invalid name" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const vaults = asArray<VaultRecord>(await txn.get(VAULTS_KEY));
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			vault.name = name;
			await txn.put(VAULTS_KEY, vaults);
			return json({ ok: true, vault });
		});
	}

	private async handleDestroyVault(request: Request): Promise<Response> {
		let body: { vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		const vaultId = body.vaultId.trim();
		return this.state.storage.transaction(async (txn) => {
			const pendingDestroys = asPendingDestroys(await txn.get(PENDING_DESTROYS_KEY));
			const pending = pendingDestroys.find((record) => record.vaultId === vaultId);
			if (pending) return json({ ok: true, pending });

			const vaults = asArray<VaultRecord>(await txn.get(VAULTS_KEY));
			const nextVaults = vaults.filter((vault) => vault.vaultId !== vaultId);
			if (nextVaults.length === vaults.length) return json({ error: "unknown_vault" }, 404);
			if (pendingDestroys.length >= MAX_PENDING_DESTROYS) {
				return json({ error: "pending_destroy_capacity" }, 503);
			}

			const record: PendingDestroyRecord = {
				vaultId,
				requestedAt: Date.now(),
				roomComplete: false,
				r2Complete: false,
				lastError: null,
			};
			const devices = asArray<DeviceRecord>(await txn.get(DEVICES_KEY)).filter((device) => device.vaultId !== vaultId);
			const codes = asArray<PairingCodeRecord>(await txn.get(PAIRING_CODES_KEY)).filter((code) => code.vaultId !== vaultId);
			await txn.put(PENDING_DESTROYS_KEY, [...pendingDestroys, record]);
			await txn.put(VAULTS_KEY, nextVaults);
			await txn.put(DEVICES_KEY, devices);
			await txn.put(PAIRING_CODES_KEY, codes);
			return json({ ok: true, pending: record });
		});
	}

	private async handleUpdateDestroyVault(request: Request): Promise<Response> {
		let body: {
			vaultId?: string;
			roomComplete?: boolean;
			r2Complete?: boolean;
			lastError?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.vaultId !== "string"
			|| typeof body.roomComplete !== "boolean"
			|| typeof body.r2Complete !== "boolean"
		) {
			return json({ error: "invalid pending destroy update" }, 400);
		}
		return this.state.storage.transaction(async (txn) => {
			const pendingDestroys = asPendingDestroys(await txn.get(PENDING_DESTROYS_KEY));
			const pending = pendingDestroys.find((record) => record.vaultId === body.vaultId);
			if (!pending) return json({ error: "unknown_pending_destroy" }, 404);

			pending.roomComplete ||= body.roomComplete!;
			pending.r2Complete ||= body.r2Complete!;
			pending.lastError = boundedDestroyError(body.lastError);
			if (pending.roomComplete && pending.r2Complete) {
				await txn.put(
					PENDING_DESTROYS_KEY,
					pendingDestroys.filter((record) => record !== pending),
				);
				return json({ ok: true, completed: true });
			}
			await txn.put(PENDING_DESTROYS_KEY, pendingDestroys);
			return json({ ok: false, completed: false, pending }, 202);
		});
	}

	private async handleRevokePairing(request: Request): Promise<Response> {
		let body: { codeId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.codeId) return json({ error: "invalid codeId" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const codes = asArray<PairingCodeRecord>(await txn.get(PAIRING_CODES_KEY));
			const next = codes.filter((code) => code.codeId !== body.codeId);
			if (next.length === codes.length) return json({ error: "unknown_code" }, 404);
			await txn.put(PAIRING_CODES_KEY, next);
			return json({ ok: true });
		});
	}

	private async readConsole(): Promise<ConsoleState> {
		const now = Date.now();
		const vaults = asArray<VaultRecord>(await this.state.storage.get(VAULTS_KEY));
		const devices = asArray<DeviceRecord>(await this.state.storage.get(DEVICES_KEY));
		const codes = asArray<PairingCodeRecord>(await this.state.storage.get(PAIRING_CODES_KEY));
		const pendingDestroys = asPendingDestroys(await this.state.storage.get(PENDING_DESTROYS_KEY));
		return {
			vaults,
			devices: devices.map(toDevicePublic),
			pairingCodes: codes.filter((code) => code.uses < 1 && code.exp > now).map(toPairingPublic),
			pendingDestroys,
		};
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const configFormat = await this.state.storage.get<number>(CONFIG_FORMAT_KEY);
		const claimed = await this.state.storage.get<boolean>(CLAIMED_KEY);
		const operatorRecoveryHash = await this.state.storage.get<string>(OPERATOR_RECOVERY_HASH_KEY);
		const ticketSigningKey = await this.state.storage.get<string>(TICKET_SIGNING_KEY);
		const updateProvider = await this.state.storage.get<UpdateProvider>(UPDATE_PROVIDER_KEY);
		const updateRepoUrl = await this.state.storage.get<string>(UPDATE_REPO_URL_KEY);
		const updateRepoBranch = await this.state.storage.get<string>(UPDATE_REPO_BRANCH_KEY);
		const isCurrent = configFormat === CONFIG_FORMAT;
		return {
			configFormat: typeof configFormat === "number" ? configFormat : null,
			claimed: claimed === true,
			operatorRecoveryHash: isCurrent && typeof operatorRecoveryHash === "string" && operatorRecoveryHash.length > 0 ? operatorRecoveryHash : null,
			ticketSigningKey: isCurrent && typeof ticketSigningKey === "string" && ticketSigningKey.length > 0 ? ticketSigningKey : null,
			updateProvider: updateProvider === "github" || updateProvider === "gitlab" || updateProvider === "unknown" ? updateProvider : null,
			updateRepoUrl: typeof updateRepoUrl === "string" && updateRepoUrl.length > 0 ? updateRepoUrl : null,
			updateRepoBranch: typeof updateRepoBranch === "string" && updateRepoBranch.length > 0 ? updateRepoBranch : null,
		};
	}
}

export default ServerConfig;
