import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const yaosRoot = resolve(directory, "../../..");
const wrangler = resolve(yaosRoot, "server/node_modules/.bin/wrangler");
const persistTo = resolve(directory, ".runtime-state");
const port = 18_987;
const origin = `http://127.0.0.1:${port}`;
const authority = { vaultGeneration: "runtime-vault-1", authorizationEpoch: 4, drawingEpoch: 1 };
const require = createRequire(resolve(yaosRoot, "package.json"));
const { WebSocket } = require("ws");

await rm(persistTo, { recursive: true, force: true });
await mkdir(persistTo, { recursive: true });

const logs = [];
let worker = startWorker();
try {
	await waitUntilReady();
	await post("/initialize", authority);

	const elements = Array.from({ length: 2_000 }, (_, index) => ({
		id: `element-${index}`,
		version: 1,
		versionNonce: 10_000 + index,
		type: "rectangle",
		x: index,
		y: index,
		isDeleted: index % 17 === 0,
	}));
	const batches = chunk(elements, 200);
	const start = performance.now();
	for (let index = 0; index < batches.length; index += 1) {
		const receipt = await post("/batch", mutation(`seed-${index}`, batches[index]));
		assert.equal(receipt.sequence, index + 1);
	}
	const sqliteWriteMs = performance.now() - start;

	const duplicate = await post("/batch", mutation("seed-0", batches[0]));
	assert.equal(duplicate.sequence, 1, "durable receipt must make retry idempotent");
	const equivocation = await fetch(`${origin}/batch`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(mutation("seed-0", [{ ...elements[0], version: 2 }])),
	});
	assert.equal(equivocation.status, 409);

	const equalVersionWinner = await post("/batch", mutation("tie", [{ ...elements[0], versionNonce: 1, x: 999 }]));
	assert.deepEqual(equalVersionWinner.acceptedElementIds, ["element-0"]);
	const replay = await get("/replay?after=10");
	assert.equal(replay.events.length, 1);

	const received = [];
	const socketA = await connect("session-a", "actor-a", "device-a", "A", "%23112233");
	const socketB = await connect("session-b", "actor-a", "device-b", "A", "%23112233");
	socketB.on("message", (data) => received.push(JSON.parse(String(data))));
	socketA.send(JSON.stringify({ type: "presence", payload: { pointer: { x: 3, y: 4 }, selectedElementIds: ["element-1"] } }));
	await waitFor(() => received.length === 1, 3_000, "presence delivery");
	assert.equal(received[0].sessionId, "session-a");
	assert.equal(received[0].identity.actorId, "actor-a");

	worker.kill("SIGTERM");
	await onceExit(worker, 5_000);
	worker = startWorker();
	await waitUntilReady();
	const afterRestart = await get("/snapshot");
	assert.equal(afterRestart.sequence, 11);
	assert.equal(afterRestart.elements.length, 2_000);
	assert.equal(afterRestart.elements.find((element) => element.id === "element-0").x, 999);

	const socketAfterRestart = await connect("session-c", "actor-c", "device-c", "C", "%23445566");
	const authorityReplacement = await post("/authority", { ...authority, authorizationEpoch: 5 });
	assert.equal(authorityReplacement.socketsClosed, 1);
	socketAfterRestart.terminate();

	const compact = await post("/compact", {});
	assert.equal(compact.compactedThrough, 11);
	assert.equal((await get("/replay?after=0")).events.length, 0);

	console.log(JSON.stringify({
		status: "ok",
		runtime: "wrangler local / Miniflare / workerd",
		sqlite: { elements: 2_000, batches: batches.length, writeMs: Number(sqliteWriteMs.toFixed(1)) },
		persistenceRestart: "passed",
		operationReceipts: "passed",
		equalVersionLowestNonceWinner: "passed",
		hibernatableSocketAPI: "passed",
		multiDeviceSameActor: "passed",
		authorityRevocationCloseInvocations: "passed (one hibernatable socket enumerated; Miniflare client close delivery not asserted)",
		compaction: "passed",
	}, null, 2));
} finally {
	if (worker.exitCode === null) worker.kill("SIGTERM");
	await onceExit(worker, 5_000);
	await rm(persistTo, { recursive: true, force: true });
}

function startWorker() {
	const child = spawn(wrangler, ["dev", "--config", resolve(directory, "wrangler.toml"), "--port", String(port), "--inspector-port", String(port + 1), "--persist-to", persistTo, "--log-level", "warn"], {
		cwd: yaosRoot,
		env: { ...process.env, WRANGLER_LOG_PATH: resolve(persistTo, "wrangler.log") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => logs.push(String(chunk)));
	child.stderr.on("data", (chunk) => logs.push(String(chunk)));
	return child;
}

async function waitUntilReady() {
	await waitFor(async () => {
		try {
			const response = await fetch(`${origin}/snapshot`);
			return response.status === 409 || response.ok;
		} catch {
			return false;
		}
	}, 15_000, `worker readiness\n${logs.join("")}`);
}

async function post(path, body) {
	const response = await fetch(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const value = await response.json();
	assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`);
	return value;
}

async function get(path) {
	const response = await fetch(`${origin}${path}`);
	const value = await response.json();
	assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`);
	return value;
}

function mutation(operationId, elements) {
	return { operationId, sessionId: "runtime-session", actorId: "runtime-actor", authority, elements };
}

function connect(sessionId, actorId, deviceId, displayName, color) {
	return new Promise((resolveSocket, reject) => {
		const url = `ws://127.0.0.1:${port}/presence?sessionId=${sessionId}&actorId=${actorId}&deviceId=${deviceId}&displayName=${displayName}&color=${color}`;
		const socket = new WebSocket(url);
		socket.once("open", () => resolveSocket(socket));
		socket.once("error", reject);
	});
}

async function waitFor(predicate, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`timed out waiting for ${description}\n${logs.join("")}`);
}

function onceExit(child, timeoutMs = 5_000) {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolveExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolveExit();
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

function chunk(values, size) {
	const result = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
