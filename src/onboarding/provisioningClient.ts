import { obsidianRequest } from "../utils/http";

export interface VaultProvisioningProof {
	vaultId: string;
	vaultGeneration: string;
	provisionedAt: number;
	schemaVersion: 4;
	storageFormatVersion: 1;
	protocolVersion: 1;
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
	if (record.schemaVersion !== 4 || record.storageFormatVersion !== 1 || record.protocolVersion !== 1) {
		throw new Error("vault status has incompatible product versions");
	}
	return {
		vaultId: requiredString(record.vaultId, "vaultId"),
		vaultGeneration: requiredString(record.vaultGeneration, "vaultGeneration"),
		provisionedAt: requiredNonNegativeInteger(record.provisionedAt, "provisionedAt"),
		schemaVersion: 4,
		storageFormatVersion: 1,
		protocolVersion: 1,
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
