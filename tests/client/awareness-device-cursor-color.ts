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

await s.done();
