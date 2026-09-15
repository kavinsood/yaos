import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const repository = path.resolve(directory, "../../../../");
const cloudflareRoot = path.join(repository, "excalidraw-cloudflare");
const require = createRequire(path.join(cloudflareRoot, "package.json"));
const { chromium } = require("@playwright/test");
const backend = (process.argv[2] ?? "https://yaos-excalidraw-spike-20260909.kavin.me.cloudflare.dev").replace(/\/$/, "");
const localBase = "http://127.0.0.1:4181";
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const vaultId = `e2e-vault-${suffix}`;
const roomId = `e2e-room-${suffix}`;
const actorId = `e2e-actor-${suffix}`;

const request = async (requestPath, options = {}) => {
	const response = await fetch(`${backend}${requestPath}`, {
		...options,
		headers: { "content-type": "application/json", ...(options.headers ?? {}) },
	});
	const body = await response.json();
	return { status: response.status, body };
};

const post = (requestPath, body) => request(requestPath, { method: "POST", body: JSON.stringify(body) });

const rectangle = (overrides = {}) => ({
	id: "shared-rectangle",
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
	updated: Date.now(),
	link: null,
	locked: false,
	index: "a0",
	...overrides,
});

const waitForServer = async () => {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(localBase);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("vite_start_timeout");
};

const waitForSnapshot = async (predicate, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const snapshot = await request(`/rooms/${roomId}/snapshot`);
		if (snapshot.status === 200 && predicate(snapshot.body)) return snapshot.body;
		await new Promise((resolve) => setTimeout(resolve, 75));
	}
	throw new Error("snapshot_condition_timeout");
};

const peerUrl = (sessionId, displayName) => {
	const url = new URL(localBase);
	for (const [key, value] of Object.entries({ backend, vaultId, roomId, actorId, actorRevision: "1", sessionId, displayName })) {
		url.searchParams.set(key, value);
	}
	return String(url);
};

const viteBinary = path.join(cloudflareRoot, "node_modules", ".bin", "vite");
const vite = spawn(viteBinary, ["--config", path.join(directory, "vite.config.mjs")], {
	cwd: directory,
	env: { ...process.env, YAOS_SPIKE_BACKEND: backend },
	stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
vite.stdout.on("data", (chunk) => { viteOutput += String(chunk); });
vite.stderr.on("data", (chunk) => { viteOutput += String(chunk); });

let browser;
try {
	assert.equal((await request("/health")).status, 200);
	assert.equal((await post(`/authorities/${vaultId}/reset`, { actorId })).status, 200);
	await waitForServer();

	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	});
	const contextA = await browser.newContext({ viewport: { width: 1100, height: 760 } });
	const contextB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	const browserErrors = [];
	for (const [peer, page] of [["A", pageA], ["B", pageB]]) {
		page.on("pageerror", (error) => browserErrors.push(`${peer}: ${error.message}`));
		page.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`${peer} console: ${message.text()}`);
		});
	}

	const mountStarted = performance.now();
	await Promise.all([
		pageA.goto(peerUrl("session-a", "Alice desktop"), { waitUntil: "domcontentloaded" }),
		pageB.goto(peerUrl("session-b", "Alice tablet"), { waitUntil: "domcontentloaded" }),
	]);
	await Promise.all([
		pageA.locator("main[data-room-ready=true]").waitFor(),
		pageB.locator("main[data-room-ready=true]").waitFor(),
	]);
	const mountTwoContextsMs = performance.now() - mountStarted;

	const initial = rectangle();
	await pageA.evaluate((elements) => window.yaosE2E.applyLocalElements(elements), [initial]);
	const initialSnapshot = await waitForSnapshot((snapshot) => snapshot.elements.some((element) => element.id === initial.id));
	await pageB.waitForFunction((id) => window.yaosE2E.getElements().some((element) => element.id === id), initial.id);
	assert.equal(initialSnapshot.sequence, 1);
	assert.equal((await pageB.evaluate(() => window.yaosE2E.getElements()))[0].version, 1);

	const peerAWinner = rectangle({ version: 7, versionNonce: 100, x: 100, updated: Date.now() + 1 });
	const peerBLoser = rectangle({ version: 7, versionNonce: 200, x: 200, updated: Date.now() + 2 });
	const conflictStarted = performance.now();
	await Promise.all([
		pageA.evaluate((elements) => window.yaosE2E.applyLocalElements(elements), [peerAWinner]),
		pageB.evaluate((elements) => window.yaosE2E.applyLocalElements(elements), [peerBLoser]),
	]);
	const conflictSnapshot = await waitForSnapshot((snapshot) => {
		const element = snapshot.elements.find((candidate) => candidate.id === initial.id);
		return element?.version === 7 && element.versionNonce === 100;
	});
	await Promise.all([
		pageA.waitForFunction((id) => window.yaosE2E.getElements().find((element) => element.id === id)?.versionNonce === 100, initial.id),
		pageB.waitForFunction((id) => window.yaosE2E.getElements().find((element) => element.id === id)?.versionNonce === 100, initial.id),
	]);
	const equalVersionConvergenceMs = performance.now() - conflictStarted;
	assert.equal(conflictSnapshot.elements.find((element) => element.id === initial.id).x, 100);

	const pageAMetricsBeforeDelete = await pageA.evaluate(() => window.yaosE2E.getMetrics());
	const pageBMetricsBeforeDelete = await pageB.evaluate(() => window.yaosE2E.getMetrics());
	const deleted = rectangle({ version: 8, versionNonce: 300, x: 100, isDeleted: true, updated: Date.now() + 3 });
	await pageA.evaluate((elements) => window.yaosE2E.applyLocalElements(elements), [deleted]);
	await waitForSnapshot((snapshot) => snapshot.elements.find((element) => element.id === initial.id)?.isDeleted === true);
	await pageB.waitForFunction((id) => window.yaosE2E.getElements().find((element) => element.id === id)?.isDeleted === true, initial.id);
	const pageAMetricsAfterDelete = await pageA.evaluate(() => window.yaosE2E.getMetrics());
	const pageBMetricsAfterDelete = await pageB.evaluate(() => window.yaosE2E.getMetrics());
	assert.equal(pageAMetricsAfterDelete.outboundOperations - pageAMetricsBeforeDelete.outboundOperations, 1);
	assert.equal(pageBMetricsAfterDelete.outboundOperations - pageBMetricsBeforeDelete.outboundOperations, 0);
	assert.ok(pageBMetricsAfterDelete.remoteApplyCallbacks > pageBMetricsBeforeDelete.remoteApplyCallbacks);

	const beforeDisconnectSequence = await pageB.evaluate(() => window.yaosE2E.getSequence());
	await pageB.evaluate(() => window.yaosE2E.disconnect());
	await pageB.waitForFunction(() => window.yaosE2E.getSocketState() === WebSocket.CLOSED);
	const reconnected = rectangle({ version: 9, versionNonce: 400, x: 900, isDeleted: false, updated: Date.now() + 4 });
	await pageA.evaluate((elements) => window.yaosE2E.applyLocalElements(elements), [reconnected]);
	const reconnectSnapshot = await waitForSnapshot((snapshot) => snapshot.elements.find((element) => element.id === initial.id)?.version === 9);
	assert.ok(reconnectSnapshot.sequence > beforeDisconnectSequence);
	assert.equal((await pageB.evaluate(() => window.yaosE2E.getElements())).find((element) => element.id === initial.id).version, 8);
	const reconnectStarted = performance.now();
	await pageB.evaluate(() => window.yaosE2E.reconnect());
	await pageB.waitForFunction((id) => window.yaosE2E.getElements().find((element) => element.id === id)?.version === 9, initial.id);
	const reconnectReplayMs = performance.now() - reconnectStarted;
	assert.equal((await pageB.evaluate(() => window.yaosE2E.getElements())).find((element) => element.id === initial.id).x, 900);

	await Promise.all([
		pageA.evaluate(() => window.yaosE2E.sendPresence({ x: 12, y: 34, tool: "laser" })),
		pageB.evaluate(() => window.yaosE2E.sendPresence({ x: 56, y: 78, tool: "pointer" })),
	]);
	await Promise.all([
		pageA.waitForFunction(() => window.yaosE2E.getCollaborators().some(([sessionId]) => sessionId === "session-b")),
		pageB.waitForFunction(() => window.yaosE2E.getCollaborators().some(([sessionId]) => sessionId === "session-a")),
	]);
	const collaboratorsA = await pageA.evaluate(() => window.yaosE2E.getCollaborators());
	const collaboratorsB = await pageB.evaluate(() => window.yaosE2E.getCollaborators());
	const presenceEventsB = await pageB.evaluate(() => window.yaosE2E.getEvents().filter((event) => event.type === "presence"));
	const observedA = presenceEventsB.find((event) => event.detail.sessionId === "session-a");
	assert.equal(observedA.detail.actorId, actorId);
	assert.equal(observedA.detail.displayName, "Alice desktop");
	assert.notEqual(observedA.detail.sessionId, "spoofed-session");
	assert.notEqual(observedA.detail.actorId, "spoofed-actor");

	assert.deepEqual(browserErrors, []);
	const finalSnapshot = await request(`/rooms/${roomId}/snapshot`);
	const metricsA = await pageA.evaluate(() => window.yaosE2E.getMetrics());
	const metricsB = await pageB.evaluate(() => window.yaosE2E.getMetrics());
	const result = {
		date: new Date().toISOString(),
		backend,
		component: "@excalidraw/excalidraw@0.18.0",
		browser: "system Google Chrome",
		vaultId,
		roomId,
		checks: {
			bootstrap: `two isolated browser contexts joined at sequence 0; first native onChange committed sequence ${initialSnapshot.sequence}`,
			mutationConvergence: "peer A mutation reached the Drawing DO and peer B through monotonic replay polling",
			equalVersionConflict: "concurrent version 7 records converged on Excalidraw-native lower versionNonce 100 in server and both React scenes",
			deletion: "version 8 native tombstone remained in the DO snapshot and both getSceneElementsIncludingDeleted() views",
			reconnectReplay: `peer B resumed from sequence ${beforeDisconnectSequence} and recovered sequence ${reconnectSnapshot.sequence}`,
			echoSuppression: `peer B observed remote updateScene/onChange without emitting an operation (${pageBMetricsAfterDelete.outboundOperations - pageBMetricsBeforeDelete.outboundOperations} writes)`,
			presenceIdentity: "same actor used distinct session-a/session-b collaborators; spoofed payload identity was overwritten by socket attachment",
		},
		timingsMs: {
			mountTwoContexts: Math.round(mountTwoContextsMs * 100) / 100,
			equalVersionConvergence: Math.round(equalVersionConvergenceMs * 100) / 100,
			reconnectReplay: Math.round(reconnectReplayMs * 100) / 100,
		},
		final: {
			sequence: finalSnapshot.body.sequence,
			elements: finalSnapshot.body.elements.length,
			metricsA,
			metricsB,
			collaboratorSessionsA: collaboratorsA.map(([sessionId]) => sessionId),
			collaboratorSessionsB: collaboratorsB.map(([sessionId]) => sessionId),
			browserErrors,
		},
	};
	await writeFile(path.join(directory, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	if (viteOutput) process.stderr.write(`\nVite output:\n${viteOutput}\n`);
	throw error;
} finally {
	await browser?.close();
	vite.kill("SIGTERM");
}
