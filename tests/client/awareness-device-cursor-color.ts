import { awarenessCursorUser, deviceCursorColor } from "../../src/utils/deviceCursorColor";
import { suite } from "../harness.ts";

const s = suite("awareness-device-cursor-color");
const HSL = /^hsl\((\d{1,3}), 72%, 52%\)$/;
const HSLA = /^hsla\((\d{1,3}), 72%, 52%, 0\.2\)$/;

s.test("device id produces a compatible colour pair", () => {
	const { color, colorLight } = deviceCursorColor("device-1");
	if (!HSL.test(color) || !HSLA.test(colorLight)) throw new Error("awareness colours use an unsupported shape");
	if (HSL.exec(color)![1] !== HSLA.exec(colorLight)![1]) throw new Error("caret and selection hues differ");
});

s.test("same name and different ids remain distinct", () => {
	const first = awarenessCursorUser("Mac", "device-aaa");
	const second = awarenessCursorUser("Mac", "device-bbb");
	if (first.name !== second.name) throw new Error("labels should match");
	if (first.id === second.id || first.color === second.color) throw new Error("device id did not distinguish awareness peers");
});

s.test("renaming a device preserves its colour", () => {
	const before = awarenessCursorUser("Mac", "device-same");
	const after = awarenessCursorUser("Studio", "device-same");
	if (before.name === after.name) throw new Error("rename did not change the label");
	if (before.color !== after.color || before.colorLight !== after.colorLight) throw new Error("rename changed the identity colour");
});

s.test("one principal keeps one colour while device instances remain distinct", () => {
	const laptop = awarenessCursorUser("Alice", "principal-alice", "alice-seed", "Laptop", "device-laptop");
	const phone = awarenessCursorUser("Alice", "principal-alice", "alice-seed", "Phone", "device-phone");
	if (laptop.id === phone.id || laptop.deviceId === phone.deviceId) throw new Error("device presence instances collapsed");
	if (laptop.principalId !== phone.principalId) throw new Error("one person split across principal identities");
	if (laptop.color !== phone.color || laptop.colorLight !== phone.colorLight) throw new Error("principal colour changed by device");
});

await s.done();
