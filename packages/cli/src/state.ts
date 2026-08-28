import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import type { VaultProvisioningProof } from "../../../src/onboarding/provisioningClient";
import { ConfigError, resolveStateDirectoryOverride } from "./config";
import { ensureDirectoryDurable, writeFileAtomic } from "./fs";

export const ENROLLMENT_FORMAT = 1 as const;

export interface PendingEnrollment {
	readonly host: string;
	readonly pairingCode: string;
	readonly enrollmentRequestId: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly deviceName: string;
	readonly createdAt: number;
}

export interface EnrollmentMembership {
	readonly host: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly deviceName: string;
	readonly originImport: boolean;
	readonly originImportPending: boolean;
}

export interface EnrollmentState {
	readonly format: typeof ENROLLMENT_FORMAT;
	readonly realVaultPath: string;
	readonly folderKey: string;
	readonly host: string;
	readonly pending: PendingEnrollment | null;
	readonly membership: EnrollmentMembership | null;
	readonly provisioningProof: VaultProvisioningProof | null;
}

export interface StatePaths {
	readonly dir: string;
	readonly lockFile: string;
	readonly enrollmentFile: string;
	readonly databaseFile: string;
}

export class StateIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateIdentityError";
	}
}
export class StateProvisioningMismatchError extends StateIdentityError {
	constructor(message: string) {
		super(message);
		this.name = "StateProvisioningMismatchError";
	}
}

export class StateGenerationMismatchError extends StateProvisioningMismatchError {
	constructor(message: string) {
		super(message);
		this.name = "StateGenerationMismatchError";
	}
}


function safeBasename(vaultPath: string): string {
	const cleaned = nodePath.basename(vaultPath).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned || "vault";
}

export function folderKeyFor(realVaultPath: string): string {
	return createHash("sha256").update(realVaultPath).digest("hex");
}

export function resolveStatePaths(realVaultPath: string, env: NodeJS.ProcessEnv = process.env): StatePaths {
	const override = resolveStateDirectoryOverride(env);
	let dir = override;
	if (dir === undefined) {
		const xdg = (env.XDG_STATE_HOME ?? "").trim();
		const root = xdg ? nodePath.resolve(xdg) : nodePath.join(os.homedir(), ".local", "state");
		const folderKey = folderKeyFor(realVaultPath);
		dir = nodePath.join(root, "yaos", "headless", `${safeBasename(realVaultPath)}-${folderKey.slice(0, 16)}`);
	}
	return {
		dir,
		lockFile: nodePath.join(dir, "daemon.lock"),
		enrollmentFile: nodePath.join(dir, "enrollment.json"),
		databaseFile: nodePath.join(dir, "client.sqlite"),
	};
}

export async function prepareStatePaths(realVaultPath: string, env: NodeJS.ProcessEnv = process.env): Promise<StatePaths> {
	const paths = resolveStatePaths(realVaultPath, env);
	try {
		await ensureDirectoryDurable(paths.dir);
		await fs.chmod(paths.dir, 0o700);
	} catch (error) {
		throw new ConfigError(`State directory is not accessible: ${paths.dir} (${String(error)})`);
	}
	return paths;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StateIdentityError(`Enrollment state ${field} is not an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new StateIdentityError(`Enrollment state omitted ${field}`);
	}
	return value;
}

function readPending(value: unknown): PendingEnrollment | null {
	if (value === null) return null;
	const pending = record(value, "pending");
	const createdAt = pending.createdAt;
	if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) {
		throw new StateIdentityError("Enrollment state pending.createdAt is invalid");
	}
	return {
		host: requiredString(pending.host, "pending.host"),
		pairingCode: requiredString(pending.pairingCode, "pending.pairingCode"),
		enrollmentRequestId: requiredString(pending.enrollmentRequestId, "pending.enrollmentRequestId"),
		deviceId: requiredString(pending.deviceId, "pending.deviceId"),
		deviceToken: requiredString(pending.deviceToken, "pending.deviceToken"),
		deviceName: typeof pending.deviceName === "string" ? pending.deviceName : "",
		createdAt: createdAt as number,
	};
}

function readMembership(value: unknown): EnrollmentMembership | null {
	if (value === null) return null;
	const membership = record(value, "membership");
	if (typeof membership.originImport !== "boolean" || typeof membership.originImportPending !== "boolean") {
		throw new StateIdentityError("Enrollment state has invalid origin import authority");
	}
	return {
		host: requiredString(membership.host, "membership.host"),
		vaultId: requiredString(membership.vaultId, "membership.vaultId"),
		vaultGeneration: requiredString(membership.vaultGeneration, "membership.vaultGeneration"),
		deviceId: requiredString(membership.deviceId, "membership.deviceId"),
		deviceToken: requiredString(membership.deviceToken, "membership.deviceToken"),
		deviceName: requiredString(membership.deviceName, "membership.deviceName"),
		originImport: membership.originImport,
		originImportPending: membership.originImportPending,
	};
}

function readProof(value: unknown): VaultProvisioningProof | null {
	if (value === null) return null;
	const proof = record(value, "provisioningProof");
	if (proof.schemaVersion !== 4 || proof.storageFormatVersion !== 1 || proof.protocolVersion !== 1) {
		throw new StateProvisioningMismatchError("Enrollment state has incompatible provisioning proof");
	}
	const provisionedAt = proof.provisionedAt;
	if (!Number.isSafeInteger(provisionedAt) || (provisionedAt as number) < 0) {
		throw new StateIdentityError("Enrollment state provisioningProof.provisionedAt is invalid");
	}
	return {
		vaultId: requiredString(proof.vaultId, "provisioningProof.vaultId"),
		vaultGeneration: requiredString(proof.vaultGeneration, "provisioningProof.vaultGeneration"),
		provisionedAt: provisionedAt as number,
		schemaVersion: 4,
		storageFormatVersion: 1,
		protocolVersion: 1,
		runtimeEpoch: requiredString(proof.runtimeEpoch, "provisioningProof.runtimeEpoch"),
	};
}

export async function readEnrollmentState(paths: StatePaths): Promise<EnrollmentState | null> {
	let text: string;
	try {
		text = await fs.readFile(paths.enrollmentFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new StateIdentityError(`Enrollment state is invalid JSON: ${String(error)}`);
	}
	const state = record(value, "root");
	if (state.format !== ENROLLMENT_FORMAT) throw new StateIdentityError("Enrollment state format is unsupported");
	return {
		format: ENROLLMENT_FORMAT,
		realVaultPath: requiredString(state.realVaultPath, "realVaultPath"),
		folderKey: requiredString(state.folderKey, "folderKey"),
		host: requiredString(state.host, "host"),
		pending: readPending(state.pending),
		membership: readMembership(state.membership),
		provisioningProof: readProof(state.provisioningProof),
	};
}

export function validateStateIdentity(state: EnrollmentState, realVaultPath: string, host?: string): void {
	if (state.realVaultPath !== realVaultPath || state.folderKey !== folderKeyFor(realVaultPath)) {
		throw new StateIdentityError("Enrollment state belongs to a different real vault path");
	}
	if (host !== undefined && state.host !== host) {
		throw new StateIdentityError("Enrollment state belongs to a different YAOS host");
	}
	const membership = state.membership;
	if (membership && membership.host !== state.host) {
		throw new StateIdentityError("Enrollment membership host does not match its state directory");
	}
	const proof = state.provisioningProof;
	if (membership && proof && (proof.vaultId !== membership.vaultId || proof.vaultGeneration !== membership.vaultGeneration)) {
		throw new StateGenerationMismatchError("Provisioning proof does not match enrollment membership");
	}
}

export async function writeEnrollmentState(paths: StatePaths, state: EnrollmentState): Promise<void> {
	await writeFileAtomic(paths.enrollmentFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await fs.chmod(paths.enrollmentFile, 0o600);
}

export function updateEnrollmentState(
	state: EnrollmentState,
	changes: Partial<Pick<EnrollmentState, "pending" | "membership" | "provisioningProof">>,
): EnrollmentState {
	return { ...state, ...changes };
}
