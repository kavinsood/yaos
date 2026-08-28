import { canApplyPluginData, canPutPluginData } from "../../src/sync/settingsSync/dataJsonGate";
import { suite } from "../harness.ts";

const s = suite("settings-sync-data-json-gate");
const PLUGIN_ID = "obsidian-excalidraw-plugin";

s.section("local binary and pinned version differ");
{
	s.check(!canApplyPluginData({
		pluginId: PLUGIN_ID,
		localManifestVersion: "1.5",
		intentVersion: "1.6",
		pluginVersion: "1.6",
		tombstoned: false,
	}), "older local binary does not apply newer data");
	s.check(!canPutPluginData({
		pluginId: PLUGIN_ID,
		localManifestVersion: "1.5",
		intentVersion: "1.6",
		pluginVersion: "1.5",
		tombstoned: false,
	}), "older local binary does not upload data against a newer pin");
}

s.section("stored producer tag differs");
{
	const mismatch = {
		pluginId: PLUGIN_ID,
		localManifestVersion: "1.6",
		intentVersion: "1.6",
		pluginVersion: "1.5",
		tombstoned: false,
	};
	s.check(!canApplyPluginData(mismatch), "new binary refuses older producer data");
	s.check(!canPutPluginData(mismatch), "wrong producer tag cannot be uploaded");
}

s.section("all three versions must match");
{
	const matched = {
		pluginId: PLUGIN_ID,
		localManifestVersion: "1.6",
		intentVersion: "1.6",
		pluginVersion: "1.6",
		tombstoned: false,
	};
	s.check(canPutPluginData(matched), "matching versions may upload");
	s.check(canApplyPluginData(matched), "matching versions may apply");
	s.check(canPutPluginData({ ...matched, enabled: false }), "disabled intent does not block matching upload");
	s.check(canApplyPluginData({ ...matched, enabled: false }), "disabled intent does not block matching apply");
	s.check(!canPutPluginData({ ...matched, localManifestVersion: "1.5", enabled: true }), "enabled does not relax upload mismatch");
	s.check(!canApplyPluginData({ ...matched, localManifestVersion: "1.5", enabled: true }), "enabled does not relax apply mismatch");
	s.check(!canPutPluginData({ ...matched, tombstoned: true }), "tombstoned plugin cannot upload");
	s.check(!canApplyPluginData({ ...matched, tombstoned: true }), "tombstoned plugin cannot apply");
}

await s.done();
