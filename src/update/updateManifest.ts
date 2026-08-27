import { obsidianRequest } from "../utils/http";

export interface UpdateManifest {
	latestServerVersion: string;
	latestPluginVersion: string;
	schemaVersion: number;
	storageFormatVersion: number;
	protocolVersion: number;
	snapshotFormatVersion: number;
	deploymentBoundary: "fresh" | "in-place";
	releaseNotesUrl: string;
}

export function isUpdateManifest(value: unknown): value is UpdateManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<UpdateManifest>;
	return typeof candidate.latestServerVersion === "string"
		&& typeof candidate.latestPluginVersion === "string"
		&& Number.isSafeInteger(candidate.schemaVersion)
		&& Number.isSafeInteger(candidate.storageFormatVersion)
		&& Number.isSafeInteger(candidate.protocolVersion)
		&& Number.isSafeInteger(candidate.snapshotFormatVersion)
		&& (candidate.deploymentBoundary === "fresh" || candidate.deploymentBoundary === "in-place")
		&& typeof candidate.releaseNotesUrl === "string";
}

export async function fetchUpdateManifest(url: string): Promise<UpdateManifest> {
	const response = await obsidianRequest({ url, method: "GET" });
	if (response.status !== 200) throw new Error(`update manifest request failed (${response.status})`);
	if (!isUpdateManifest(response.json)) throw new Error("update manifest response was invalid");
	return response.json;
}
