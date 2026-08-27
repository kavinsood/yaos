/**
 * Two-phase deployed-worker durability check.
 *
 * Run with YAOS_TEST_MODE=seed, redeploy the Worker, then rerun with
 * YAOS_TEST_MODE=validate and the same YAOS_TEST_VAULT_ID. Set
 * YAOS_TEST_FILE_COUNT for a large cold-load check; the default is one file.
 * run-live.ts also executes the seed phase against its local Worker.
 */
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { readField } from "../mocks/readField.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import {
	deviceBearerHeaders,
	fetchSocketTicket,
	requireLiveIdentity,
} from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const host = identity.host;
const room = identity.vaultId;
const mode = process.env.YAOS_TEST_MODE ?? "seed";
const fileCount = Number.parseInt(process.env.YAOS_TEST_FILE_COUNT ?? "1", 10);
const expectExactPathCount = process.env.YAOS_TEST_EXACT_PATH_COUNT !== "false";
if (mode !== "seed" && mode !== "validate") {
	throw new Error(`YAOS_TEST_MODE must be "seed" or "validate" (got ${JSON.stringify(mode)})`);
}
if (!Number.isInteger(fileCount) || fileCount < 1) {
	throw new Error(`YAOS_TEST_FILE_COUNT must be a positive integer (got ${JSON.stringify(process.env.YAOS_TEST_FILE_COUNT)})`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Device {
	readonly doc: Y.Doc;
	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
	readonly sys: Y.Map<unknown>;
	createFile(path: string, content: string): void;
	readFile(path: string): string | null;
	disconnect(): void;
}

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}


function testPath(index: number): string {
	return fileCount === 1
		? "redeploy-test.md"
		: `redeploy-test/file-${String(index).padStart(4, "0")}.md`;
}

function testContent(index: number): string {
	return `YAOS redeploy durability test\nindex=${index}\nvault=${room}\nschema=${SCHEMA_VERSION}`;
}

async function connectDevice(label: string): Promise<Device> {
	const { ticket } = await fetchSocketTicket(identity);
	return new Promise<Device>((resolvePromise, rejectPromise) => {
		const doc = new Y.Doc();
		const pathToId = doc.getMap<string>("pathToId");
		const idToText = doc.getMap<Y.Text>("idToText");
		const meta = doc.getMap("meta");
		const sys = doc.getMap("sys");
		const provider = new YSyncProvider(host, room, doc, {
			prefix: `/vault/sync/${encodeURIComponent(room)}`,
			params: { ticket, schemaVersion: String(SCHEMA_VERSION) },
			WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
			connect: false,
		});
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			provider.destroy();
			doc.destroy();
			rejectPromise(new Error(`${label}: timed out waiting for sync`));
		}, 30_000);

		onFatalFrame(provider, (frame) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			provider.destroy();
			doc.destroy();
			rejectPromise(new Error(`${label}: server rejected connection: ${describeFatalFrame(frame)}`));
		});
		provider.on("sync", (synced: boolean) => {
			if (!synced || settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise({
				doc,
				pathToId,
				idToText,
				meta,
				sys,
				createFile(path: string, content: string): void {
					const fileId = pathToId.get(path) ?? `redeploy:${path}`;
					doc.transact(() => {
						pathToId.set(path, fileId);
						let text = idToText.get(fileId);
						if (!text) {
							text = new Y.Text();
							idToText.set(fileId, text);
						}
						text.delete(0, text.length);
						text.insert(0, content);
						meta.set(fileId, { path, deleted: false, mtime: Date.now() });
					}, "disk-sync");
				},
				readFile(path: string): string | null {
					const fileId = pathToId.get(path);
					return fileId ? idToText.get(fileId)?.toString() ?? null : null;
				},
				disconnect(): void {
					provider.destroy();
					doc.destroy();
				},
			});
		});
		void provider.connect();
	});
}

async function fetchDebug(): Promise<unknown> {
	const response = await fetch(
		`${host}/vault/${encodeURIComponent(room)}/debug/recent`,
		{ headers: deviceBearerHeaders(identity) },
	);
	if (!response.ok) {
		throw new Error(`debug endpoint failed (${response.status}): ${await response.text()}`);
	}
	return await response.json();
}

function checkDebugState(debug: unknown, phase: "seed" | "validate"): void {
	const activePathCount = readField(debug, "documentSummary", "activePathCount");
	const activePathsWithText = readField(debug, "documentSummary", "activePathsWithText");
	check(readField(debug, "documentLoaded") === true, `${phase}: server document is loaded`);
	check(readField(debug, "persistence", "status") === "healthy", `${phase}: persistence is healthy`);
	check(readField(debug, "persistence", "pendingPersistence") === false, `${phase}: no persistence write is pending`);
	check(
		typeof activePathCount === "number" && (expectExactPathCount ? activePathCount === fileCount : activePathCount >= fileCount),
		`${phase}: activePathCount ${expectExactPathCount ? "===" : ">="} ${fileCount} (got ${String(activePathCount)})`,
	);
	check(
		typeof activePathsWithText === "number" && (expectExactPathCount ? activePathsWithText === fileCount : activePathsWithText >= fileCount),
		`${phase}: activePathsWithText ${expectExactPathCount ? "===" : ">="} ${fileCount} (got ${String(activePathsWithText)})`,
	);
	check(readField(debug, "documentSummary", "activePathsMissingFromPathToId") === 0, `${phase}: no active paths are missing from pathToId`);
	check(readField(debug, "documentSummary", "activePathsMissingText") === 0, `${phase}: no active paths are missing text`);
	check(readField(debug, "documentSummary", "pathToIdWithoutActiveMeta") === 0, `${phase}: no orphaned pathToId entries`);
}

async function main(): Promise<void> {
	console.log(`\nLive redeploy durability check — ${mode.toUpperCase()}`);
	console.log(`Host: ${host}`);
	console.log(`Vault: ${room}`);
	console.log(`Files: ${fileCount}\n`);

	if (mode === "seed") {
		const seeder = await connectDevice("Seeder");
		seeder.doc.transact(() => {
			seeder.sys.set("initialized", true);
			seeder.sys.set("schemaVersion", SCHEMA_VERSION);
		});
		for (let index = 0; index < fileCount; index++) {
			seeder.createFile(testPath(index), testContent(index));
		}
		for (let index = 0; index < fileCount; index++) {
			check(seeder.readFile(testPath(index)) === testContent(index), `seed: ${testPath(index)} is present locally`);
		}
		await sleep(3_000);
		seeder.disconnect();
		checkDebugState(await fetchDebug(), "seed");
		console.log("\nSeed complete. Redeploy the Worker, then rerun with YAOS_TEST_MODE=validate and the same vault ID.");
	} else {
		const reader = await connectDevice("Cold-load reader");
		try {
			checkDebugState(await fetchDebug(), "validate");
			const sampleIndexes = [0, Math.floor(fileCount / 2), fileCount - 1]
				.filter((index, position, indexes) => indexes.indexOf(index) === position);
			for (const index of sampleIndexes) {
				check(reader.readFile(testPath(index)) === testContent(index), `validate: fresh client received ${testPath(index)}`);
			}
		} finally {
			reader.disconnect();
		}
	}

	console.log(`\nLive redeploy durability: ${passed} passed, ${failed} failed`);
	if (failed > 0) throw new Error(`${failed} live redeploy durability check(s) failed`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
