import { readSource, suite } from "../harness.ts";

const s = suite("server-minted-device-name");

s.section("Enrollment owns the default device identity");
{
	const controller = readSource("src/runtime/setupLinkController.ts");
	s.check(controller.includes('typeof enrolled.name !== "string"'), "enrollment requires the server-returned device name");
	s.check(controller.includes("settings.deviceName = enrolledName"), "server-returned name becomes the persisted device name");
	const main = readSource("src/main.ts");
	s.check(!main.includes("Date.now().toString(36)"), "startup does not create timestamp device names");
}

await s.done();
