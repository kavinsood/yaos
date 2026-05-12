import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.YAOS_TEST_VAULT_ID || "yaos-provider-manual-connect";
const ROOM_ID = `${BASE_VAULT_ID}-manual-connect`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for provider manual-connect smoke test");
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(extra = {}) {
	return {
		Authorization: `Bearer ${TOKEN}`,
		...extra,
	};
}

async function getDebugPayload() {
	const res = await fetch(`${HOST}/vault/${encodeURIComponent(ROOM_ID)}/debug/recent`, {
		headers: authHeaders(),
	});
	const text = await res.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = text;
	}
	if (!res.ok) {
		throw new Error(`debug fetch failed (${res.status}): ${text}`);
	}
	return payload;
}

function parseSvEchoMessage(payload) {
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (parsed?.type !== "yaos/sv-echo" || parsed?.schema !== 1 || typeof parsed?.sv !== "string") {
		return null;
	}
	try {
		const binary = atob(parsed.sv);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		Y.decodeStateVector(bytes);
		return bytes;
	} catch {
		return null;
	}
}

function isStateVectorGe(a, b) {
	try {
		const svA = Y.decodeStateVector(a);
		const svB = Y.decodeStateVector(b);
		for (const [clientId, clock] of svB) {
			if ((svA.get(clientId) ?? 0) < clock) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function withProvider(label, callback) {
	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: {
			token: TOKEN,
			schemaVersion: "2",
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	let statusEvents = 0;
	let customHandlersReady = false;
	const svEchoes = [];
	provider.on("custom-message", (payload) => {
		if (!customHandlersReady) throw new Error(`${label}: custom-message before handler readiness marker`);
		const sv = parseSvEchoMessage(payload);
		if (sv) svEchoes.push(sv);
	});
	provider.on("status", () => {
		statusEvents++;
	});
	customHandlersReady = true;

	try {
		await callback({ ydoc, provider, getStatusEvents: () => statusEvents, getSvEchoes: () => svEchoes.slice() });
	} finally {
		provider.destroy();
		ydoc.destroy();
	}
}

async function waitForSync(provider, label) {
	await new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for sync`));
		}, 10_000);

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					settled = true;
					clearTimeout(timeout);
					reject(new Error(`${label}: server error ${msg.code}`));
				}
			} catch {
				// Ignore non-JSON Yjs frames.
			}
		});

		provider.on("sync", (synced) => {
			if (!synced || settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
		void provider.connect();
	});
}

async function waitForConnected(provider, label) {
	await new Promise((resolve, reject) => {
		if (provider.wsconnected) {
			resolve(undefined);
			return;
		}
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for connected status`));
		}, 10_000);
		provider.on("status", (event) => {
			if (settled || event.status !== "connected") return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
		void provider.connect();
	});
}

async function waitForSvEcho(getSvEchoes, label, minCount = 1) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (getSvEchoes().length >= minCount) return;
		await wait(50);
	}
	throw new Error(`${label}: timed out waiting for sv-echo custom-message`);
}

async function waitForDominatingSvEcho(getSvEchoes, candidateSv, label, minCount = 1) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const echoes = getSvEchoes();
		if (echoes.length >= minCount) {
			const dominating = echoes.find((sv) => isStateVectorGe(sv, candidateSv));
			if (dominating) return dominating;
		}
		await wait(50);
	}
	throw new Error(`${label}: timed out waiting for dominating sv-echo custom-message`);
}

async function main() {
	console.log(`Provider manual-connect smoke room: ${ROOM_ID}`);
	let writtenCandidateSv = null;

	await withProvider("initial connect", async ({ ydoc, provider, getSvEchoes }) => {
		await waitForSync(provider, "initial connect");
		await waitForSvEcho(getSvEchoes, "initial connect baseline echo");
		const baselineEchoCount = getSvEchoes().length;
		const sys = ydoc.getMap("sys");
		sys.set("initialized", true);
		sys.set("schemaVersion", 2);
		const text = ydoc.getText("manual-connect");
		text.insert(0, "manual connect smoke");
		writtenCandidateSv = Y.encodeStateVector(ydoc);
		await waitForDominatingSvEcho(
			getSvEchoes,
			writtenCandidateSv,
			"initial connect postApply echo",
			baselineEchoCount + 1,
		);
		const debug = await getDebugPayload();
		if ((debug?.svEcho?.baselineSent ?? 0) < 1) {
			throw new Error("initial connect: server debug did not count baseline sv-echo");
		}
		if ((debug?.svEcho?.postApplySent ?? 0) < 1) {
			throw new Error("initial connect: server debug did not count postApply sv-echo");
		}
		console.log("Initial manual connect synced, received baseline sv-echo, wrote state, and received dominating postApply sv-echo");
	});

	await withProvider("reconnect", async ({ ydoc, provider, getSvEchoes }) => {
		await waitForSync(provider, "reconnect first sync");
		await waitForSvEcho(getSvEchoes, "reconnect first baseline echo");
		if (writtenCandidateSv && !getSvEchoes().some((sv) => isStateVectorGe(sv, writtenCandidateSv))) {
			throw new Error("reconnect: baseline sv-echo did not dominate initial written candidate");
		}
		const debug = await getDebugPayload();
		if ((debug?.svEcho?.baselineSent ?? 0) < 2) {
			throw new Error("reconnect: server debug did not count fresh baseline sv-echo");
		}
		provider.disconnect();
		await wait(500);
		await waitForConnected(provider, "reconnect second connect");
		if (ydoc.getText("manual-connect").toString() !== "manual connect smoke") {
			throw new Error("reconnect: seeded text was not observed after reconnect");
		}
		console.log("Manual reconnect synced existing state; fresh provider received baseline sv-echo");
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
