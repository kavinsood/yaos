import { obsidianRequest } from "../utils/http";

export interface ServerCapabilities {
	claimed: boolean;
	attachments: boolean;
	snapshots: boolean;
	maxBlobUploadBytes?: number;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	schemaVersion: number | null;
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
