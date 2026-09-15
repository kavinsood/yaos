import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(path.resolve("../excalidraw-cloudflare/package.json"));
const { chromium } = require("@playwright/test");

const baseElement = {
	id: "native-probe-element",
	type: "rectangle",
	x: 10,
	y: 20,
	width: 100,
	height: 80,
	angle: 0,
	strokeColor: "#1e1e1e",
	backgroundColor: "transparent",
	fillStyle: "solid",
	strokeWidth: 2,
	strokeStyle: "solid",
	roughness: 1,
	opacity: 100,
	groupIds: [],
	frameId: null,
	roundness: null,
	seed: 12345,
	version: 1,
	versionNonce: 100,
	isDeleted: false,
	boundElements: null,
	updated: 1,
	link: null,
	locked: false,
	index: "a0",
};

const browser = await chromium.launch({
	headless: true,
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const started = performance.now();
await page.goto("http://127.0.0.1:4179", { waitUntil: "networkidle" });
await page.locator("main[data-probe-ready=true]").waitFor();
const mountMs = performance.now() - started;

await page.evaluate((element) => {
	window.yaosProbe.clearEvents();
	window.yaosProbe.applyElements([element]);
}, baseElement);
await page.waitForTimeout(100);
const applied = await page.evaluate(() => window.yaosProbe.getElements());
assert.equal(applied.length, 1);
assert.equal(applied[0].id, baseElement.id);
assert.equal(applied[0].versionNonce, 100);

const remoteApplyEvents = await page.evaluate(() => window.yaosProbe.getEvents());

await page.evaluate(() => {
	window.yaosProbe.applyCollaborators(new Map([
		["session-device-a", {
			username: "Remote peer",
			pointer: { x: 30, y: 40, tool: "laser", laserColor: "#ff0000" },
			button: "down",
			selectedElementIds: { "native-probe-element": true },
		}],
	]));
});
await page.waitForTimeout(50);
const collaboratorCount = await page.evaluate(() => window.yaosProbe.getAppState()?.collaborators.size ?? -1);
assert.equal(collaboratorCount, 1);

await page.mouse.move(400, 300);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(50);
const pointerEvents = await page.evaluate(() => window.yaosProbe.getEvents().filter((event) => event.type.startsWith("pointer")));
assert.ok(pointerEvents.some((event) => event.type === "pointer"));
assert.ok(pointerEvents.some((event) => event.type === "pointer-up"));

const result = {
	component: "@excalidraw/excalidraw@0.18.0",
	mountMs: Math.round(mountMs * 100) / 100,
	remoteApply: {
		elementsObserved: applied.length,
		onChangeEventsWithin100ms: remoteApplyEvents.filter((event) => event.type === "change").length,
	},
	presence: { collaboratorCount, pointerCallbacksObserved: pointerEvents.length },
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
