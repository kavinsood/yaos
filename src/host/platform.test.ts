import { test } from "node:test";
import assert from "node:assert/strict";
import type { LifecycleEvent } from "../ports/platform";
import { BrowserPlatform, browserClock, platformInfoFrom } from "./platform";
import { deviceClassFor } from "./runtimeSupport";

test("platform info maps Obsidian flags and navigator facts onto device classes", () => {
	const phone = platformInfoFrom({ isMobile: true, isIosApp: true }, { hardwareConcurrency: 6, deviceMemory: 4 }, true);
	assert.equal(phone.os, "ios");
	assert.equal(deviceClassFor(phone), "phone");
	const old = platformInfoFrom({ isMobile: true, isAndroidApp: true }, { hardwareConcurrency: 2 }, true);
	assert.equal(deviceClassFor(old), "constrained");
	const tablet = platformInfoFrom({ isMobile: true, isTablet: true, isIosApp: true }, {}, false);
	assert.equal(deviceClassFor(tablet), "tablet");
	assert.equal(tablet.workerSupported, false);
	const mac = platformInfoFrom({ isMobile: false, isMacOS: true }, { hardwareConcurrency: 10 }, true);
	assert.equal(deviceClassFor(mac), "desktop");
});

test("lifecycle events come from visibilitychange, pagehide, freeze/resume, online/offline and detach when unused", () => {
	const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
	const win = new EventTarget();
	const nav = { onLine: true };
	const p = new BrowserPlatform(platformInfoFrom({ isMobile: false }, {}, true), doc, win, nav);
	const seen: LifecycleEvent[] = [];
	const off = p.onLifecycle((e) => seen.push(e));
	doc.visibilityState = "hidden";
	doc.dispatchEvent(new Event("visibilitychange"));
	assert.equal(p.isVisible(), false);
	win.dispatchEvent(new Event("pagehide"));
	doc.dispatchEvent(new Event("freeze"));
	doc.dispatchEvent(new Event("resume"));
	doc.visibilityState = "visible";
	doc.dispatchEvent(new Event("visibilitychange"));
	win.dispatchEvent(new Event("offline"));
	win.dispatchEvent(new Event("online"));
	assert.deepEqual(seen, ["hidden", "pagehide", "freeze", "resume", "visible", "offline", "online"]);
	off();
	win.dispatchEvent(new Event("pagehide"));
	assert.equal(seen.length, 7);
});

test("browser clock timers fire and clear; monotonic never decreases", async () => {
	const c = browserClock();
	let fired = 0;
	const h = c.setTimer(5, () => fired++);
	c.clearTimer(h);
	c.setTimer(1, () => fired += 10);
	const m1 = c.monotonic();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(fired, 10);
	assert.ok(c.monotonic() >= m1);
});
