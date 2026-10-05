export type PluginDataGateInput = {
	pluginId: string;
	localManifestVersion: string | null | undefined;
	intentVersion: string | null | undefined;
	pluginVersion: string | null | undefined;
	tombstoned: boolean;
	enabled?: boolean;
};

export function canPutPluginData(input: PluginDataGateInput): boolean {
	return versionsMatch(input);
}

export function canApplyPluginData(input: PluginDataGateInput): boolean {
	return versionsMatch(input);
}

function versionsMatch(input: PluginDataGateInput): boolean {
	if (input.tombstoned) return false;
	const local = input.localManifestVersion;
	const pin = input.intentVersion;
	const entry = input.pluginVersion;
	if (typeof local !== "string" || local.length === 0) return false;
	if (typeof pin !== "string" || pin.length === 0) return false;
	if (typeof entry !== "string" || entry.length === 0) return false;
	return local === pin && pin === entry;
}
