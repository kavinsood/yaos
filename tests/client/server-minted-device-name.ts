import {
	defaultDeviceName,
	type DevicePlatform,
} from "../../src/utils/defaultDeviceName";
import { readSource, suite } from "../harness.ts";

const s = suite("server-minted-device-name");
const platform = (overrides: Partial<DevicePlatform>): DevicePlatform => ({
	isAndroidApp: false,
	isIosApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
	isLinux: false,
	isMobile: false,
	...overrides,
});

s.section("Platform defaults are stable and human-readable");
{
	s.check(defaultDeviceName(platform({ isAndroidApp: true })) === "Android", "Android phone default");
	s.check(defaultDeviceName(platform({ isAndroidApp: true, isTablet: true })) === "Android tablet", "Android tablet default");
	s.check(defaultDeviceName(platform({ isIosApp: true, isPhone: true })) === "iPhone", "iPhone default");
	s.check(defaultDeviceName(platform({ isIosApp: true, isTablet: true })) === "iPad", "iPad default");
	s.check(defaultDeviceName(platform({ isMacOS: true })) === "Mac", "Mac default");
	s.check(defaultDeviceName(platform({ isWin: true })) === "Windows", "Windows default");
	s.check(defaultDeviceName(platform({ isLinux: true })) === "Linux", "Linux default");
	s.check(defaultDeviceName(platform({})) === "Desktop", "unknown desktop default");
}

s.section("Enrollment owns the durable device name");
{
	const controller = readSource("src/runtime/setupLinkController.ts");
	s.check(controller.includes('typeof enrolled.deviceName !== "string"'), "enrollment requires the server-returned device name");
	s.check(controller.includes("settings.deviceName = enrolled.deviceName"), "server-returned name becomes the persisted device name");
	const main = readSource("src/main.ts");
	s.check(main.includes("defaultDeviceName(Platform)"), "startup initializes a platform default before enrollment");
	s.check(!main.includes("Date.now().toString(36)"), "startup does not create timestamp device names");
}

await s.done();
