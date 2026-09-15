import { obsidianRequest } from "../utils/http";
import {
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	STORAGE_FORMAT_VERSION,
} from "../sync/schema";

export interface VaultProvisioningProof {
	vaultId: string;
	vaultGeneration: string;
	provisionedAt: number;
	schemaVersion: typeof SCHEMA_VERSION;
	storageFormatVersion: typeof STORAGE_FORMAT_VERSION;
	protocolVersion: typeof PROTOCOL_VERSION;
	runtimeEpoch: string;
}

export interface VaultProvisioningInput {
	host: string;
	deviceToken: string;
	vaultId: string;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new Error(`vault status omitted ${field}`);
	return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`vault status omitted ${field}`);
	}
	return value as number;
}

export function readVaultProvisioningProof(value: unknown): VaultProvisioningProof {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("vault status is not an object");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== SCHEMA_VERSION
		|| record.storageFormatVersion !== STORAGE_FORMAT_VERSION
		|| record.protocolVersion !== PROTOCOL_VERSION) {
		throw new Error("vault status has incompatible product versions");
	}
	return {
		vaultId: requiredString(record.vaultId, "vaultId"),
		vaultGeneration: requiredString(record.vaultGeneration, "vaultGeneration"),
		provisionedAt: requiredNonNegativeInteger(record.provisionedAt, "provisionedAt"),
		schemaVersion: SCHEMA_VERSION,
		storageFormatVersion: STORAGE_FORMAT_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		runtimeEpoch: requiredString(record.runtimeEpoch, "runtimeEpoch"),
	};
}

/** Reads the operator-provisioned vault boundary; devices never provision storage. */
export async function fetchVaultProvisioningProof(
	input: VaultProvisioningInput,
	request: typeof obsidianRequest = obsidianRequest,
): Promise<VaultProvisioningProof> {
	const host = input.host.trim().replace(/\/$/, "");
	if (!host || !input.deviceToken.trim() || !input.vaultId.trim()) {
		throw new Error("host, device token, and vault ID are required to read vault status");
	}
	const response = await request({
		url: `${host}/vault/${encodeURIComponent(input.vaultId)}/status`,
		method: "GET",
		headers: { Authorization: `Bearer ${input.deviceToken.trim()}` },
	});
	if (response.status !== 200) {
		const value: unknown = response.json;
		const detail = value && typeof value === "object" && "error" in value ? value.error : null;
		throw new Error(`vault status failed (${response.status})${typeof detail === "string" ? `: ${detail}` : ""}`);
	}
	const proof = readVaultProvisioningProof(response.json);
	if (proof.vaultId !== input.vaultId) throw new Error("vault status identity mismatch");
	return proof;
}
