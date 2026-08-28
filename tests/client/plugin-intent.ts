import {
	compareDottedVersion,
	detectPluginInstallCapability,
	planPluginApply,
	type PluginInstallCapability,
	type PluginIntent,
} from "../../src/sync/settingsSync/pluginIntent";
import { suite } from "../harness.ts";

const s = suite("plugin-intent");
const CAPABLE: PluginInstallCapability = {
	installPlugin: true,
	enablePluginAndSave: true,
	setEnable: true,
	communityEnabled: true,
};
const CALENDAR: PluginIntent = {
	id: "calendar",
	repo: "liamcain/obsidian-calendar-plugin",
	version: "1.5.10",
	enabled: true,
};
const MANIFEST = {
	id: "calendar",
	minAppVersion: "0.9.11",
	isDesktopOnly: false as boolean | undefined,
};

s.section("capability detection");
{
	const capability = detectPluginInstallCapability({
		installPlugin: async () => undefined,
		enablePluginAndSave: async () => true,
		setEnable: async () => undefined,
		isEnabled: () => true,
	});
	s.check(capability.installPlugin, "install function is detected");
	s.check(capability.enablePluginAndSave, "enable-and-save function is detected");
	s.check(capability.setEnable, "restricted-mode setter is detected");
	s.check(capability.communityEnabled, "enabled community plugins are detected");
	const missing = detectPluginInstallCapability({});
	s.check(!missing.installPlugin && !missing.communityEnabled, "missing host methods fail closed");
}

s.section("apply order gates");
{
	const common = {
		intent: CALENDAR,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	};
	s.check(planPluginApply({ ...common, capability: { ...CAPABLE, installPlugin: false } }).kind === "unsupported-api", "missing install API is unsupported");
	s.check(planPluginApply({ ...common, capability: { ...CAPABLE, communityEnabled: false } }).kind === "restricted", "restricted mode blocks apply");
	s.check(planPluginApply({ ...common, capability: CAPABLE, manifest: { ...MANIFEST, id: "wrong" } }).kind === "unknown-id", "manifest id mismatch is rejected");
}

s.section("platform and application version gates");
{
	const common = {
		intent: CALENDAR,
		capability: CAPABLE,
		installedVersion: null,
		alreadyEnabled: false,
		manifest: { ...MANIFEST, isDesktopOnly: true },
		apiVersion: "1.12.7",
	};
	s.check(planPluginApply({ ...common, isMobile: true }).kind === "desktop-only", "desktop-only plugin is skipped on mobile");
	s.check(planPluginApply({ ...common, isMobile: false }).kind === "install-then-enable", "desktop-only plugin installs on desktop");
	s.check(planPluginApply({ ...common, isMobile: false, manifest: { ...MANIFEST, minAppVersion: "1.13.0" } }).kind === "min-app-version", "newer minimum app version is refused");
}

s.section("catalog pin actions");
{
	const common = {
		intent: CALENDAR,
		capability: CAPABLE,
		alreadyEnabled: false,
		manifest: MANIFEST,
		isMobile: false,
		apiVersion: "1.12.7",
	};
	s.check(planPluginApply({ ...common, installedVersion: null }).kind === "install-then-enable", "missing enabled plugin installs then enables");
	s.check(planPluginApply({ ...common, installedVersion: "1.5.9", alreadyEnabled: true }).kind === "install-then-enable", "wrong installed version is repinned");
	s.check(planPluginApply({ ...common, installedVersion: "1.5.10" }).kind === "enable-only", "matching disabled plugin only enables");
	s.check(planPluginApply({ ...common, installedVersion: "1.5.10", alreadyEnabled: true }).kind === "already-current", "matching enabled plugin is current");
	s.check(planPluginApply({ ...common, intent: { ...CALENDAR, enabled: false }, installedVersion: null }).kind === "install-only", "disabled intent still downloads pinned code");
}

s.section("dotted version compare");
{
	s.check(compareDottedVersion("1.12.7", "1.12.7") === 0, "equal versions compare equally");
	s.check(compareDottedVersion("1.12.7", "1.13.0") < 0, "older version compares lower");
	s.check(compareDottedVersion("1.13.0", "1.12.7") > 0, "newer version compares higher");
	s.check(compareDottedVersion("1.2.3.4", "1.2.3.3") > 0, "four-part dotted versions retain donor behavior");
	s.check(compareDottedVersion("not-a-version", "1.0.0") < 0, "invalid version refuses as older");
}

await s.done();
