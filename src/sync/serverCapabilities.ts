import { obsidianRequest } from "../utils/http";

export interface ServerCapabilities {
	claimed: boolean;
	attachments: boolean;
	snapshots: boolean;
	settingsSync?: boolean;
	settingsFormatVersion?: number;
	maxBlobUploadBytes?: number;
	serverVersion: string;
	schemaVersion: number | null;
	storageFormatVersion: number;
	protocolVersion: number;
	snapshotFormatVersion: number;
	recoveryJobs: boolean;
	updateProvider: "github" | "gitlab" | "unknown" | null;
	updateRepoUrl: string | null;
	updateRepoBranch?: string | null;
}

export async function fetchServerCapabilities(host: string, deviceToken?: string): Promise<ServerCapabilities> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/api/capabilities`,
		method: "GET",
		headers: deviceToken ? { Authorization: `Bearer ${deviceToken}` } : undefined,
	});
	if (res.status !== 200) {
		throw new Error(`capabilities request failed (${res.status})`);
	}
	return res.json as ServerCapabilities;
}
