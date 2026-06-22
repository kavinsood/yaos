import { obsidianRequest } from "../utils/http";

export interface UpdateManifest {
	latestServerVersion: string;
	latestPluginVersion: string;
	releaseType: "compatible" | "guided-breaking" | "migration-required";
	migrationRequired: boolean;
	autoUpdateEligible: boolean;
	minCompatibleServerVersionForPlugin: string | null;
	minCompatiblePluginVersionForServer: string | null;
	latestPluginSchemaVersion?: number;
	latestServerMinSchemaVersion?: number;
	latestServerMaxSchemaVersion?: number;
	upgradeOrder: "either" | "server-first" | "plugin-first";
	releaseNotesUrl: string;
	upgradeGuideUrl: string;
}

export function isUpdateManifest(value: unknown): value is UpdateManifest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<UpdateManifest>;
	return typeof candidate.latestServerVersion === "string" &&
		typeof candidate.latestPluginVersion === "string" &&
		(candidate.releaseType === "compatible" ||
			candidate.releaseType === "guided-breaking" ||
			candidate.releaseType === "migration-required") &&
		typeof candidate.migrationRequired === "boolean" &&
		typeof candidate.autoUpdateEligible === "boolean" &&
		(candidate.minCompatibleServerVersionForPlugin === null ||
			typeof candidate.minCompatibleServerVersionForPlugin === "string") &&
		(candidate.minCompatiblePluginVersionForServer === null ||
			typeof candidate.minCompatiblePluginVersionForServer === "string") &&
		(candidate.latestPluginSchemaVersion === undefined ||
			typeof candidate.latestPluginSchemaVersion === "number") &&
		(candidate.latestServerMinSchemaVersion === undefined ||
			typeof candidate.latestServerMinSchemaVersion === "number") &&
		(candidate.latestServerMaxSchemaVersion === undefined ||
			typeof candidate.latestServerMaxSchemaVersion === "number") &&
		(candidate.upgradeOrder === "either" ||
			candidate.upgradeOrder === "server-first" ||
			candidate.upgradeOrder === "plugin-first") &&
		typeof candidate.releaseNotesUrl === "string" &&
		typeof candidate.upgradeGuideUrl === "string";
}

export async function fetchUpdateManifest(url: string): Promise<UpdateManifest> {
	const res = await obsidianRequest({
		url,
		method: "GET",
	});
	if (res.status !== 200) {
		throw new Error(`update manifest request failed (${res.status})`);
	}
	if (!isUpdateManifest(res.json)) {
		throw new Error("update manifest response was invalid");
	}
	return res.json;
}
