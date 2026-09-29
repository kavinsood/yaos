import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { suite } from "../harness.ts";
import * as Y from "yjs";
import { decodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope.ts";
import { enroll, startDaemon, type Daemon } from "./daemon.ts";
import { claimServer, enrollPublic, mintPairingCode, PublicPeer, type Identity } from "./schema4.ts";
import { launchWrangler, type WranglerTarget } from "./wrangler.ts";

const tests = suite("G7 unresolved bootstrap on real Worker and CLI");
const experimentRoot = process.env.EXP_ROOT ?? "/Users/kavin/personal/obsidiansync/experiments";
const diagnosticWaitMs = 10_000;

async function findFile(directory: string, name: string): Promise<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const nested = await findFile(path, name);
			if (nested) return nested;
		}
	}
	return "";
}

function snapshot(databasePath: string): Record<string, unknown> {
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const root = database.prepare("SELECT encoded_state FROM documents WHERE document_id = 'root'").get();
		const rootDocument = new Y.Doc();
		if (root?.encoded_state instanceof Uint8Array) Y.applyUpdate(rootDocument, root.encoded_state);
		const rootPaths = Object.fromEntries(rootDocument.getMap("pathToId").entries());
		rootDocument.destroy();
		return {
			bootstrap: database.prepare("SELECT value_json FROM bootstrap_progress").all(),
			feedCursor: database.prepare("SELECT sequence FROM feed_cursor").all(),
			materializedPaths: database.prepare("SELECT body_id, path FROM materialized_paths").all(),
			documents: database.prepare("SELECT document_id, generation, dirty FROM documents").all(),
			outstanding: database.prepare("SELECT body_id, value_json FROM outstanding_settlements").all(),
			preserved: database.prepare("SELECT path, value_json FROM preserved_unresolved").all(),
			rootPaths,
		};
	} finally {
		database.close();
	}
}

async function feedAfter(identity: Identity, cursor: number): Promise<Record<string, unknown>> {
	const response = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/changes?after=${cursor}&limit=200`, {
		headers: { Authorization: `Bearer ${identity.deviceToken}` },
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(response.status, 200);
	const body: unknown = response.headers.get("content-type")?.startsWith(YAOS_BINARY_CONTENT_TYPE)
		? decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer()))
		: await response.json();
	return body as Record<string, unknown>;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	return false;
}

tests.test("stale bootstrap replays a never-materialized remote deletion before admitting independent local content", async () => {
	assert.ok(isAbsolute(experimentRoot), "EXP_ROOT must be absolute");
	const directory = await mkdtemp(join(tmpdir(), "yaos-g7-unresolved-"));
	const vaultPath = join(directory, "vault");
	const statePath = join(directory, "state");
	const source = "unresolved-source.md";
	const target = "unresolved-renamed.md";
	const localText = "local independent content with no baseline\n";
	const remoteText = "remote canonical with no local baseline\n";
	const captures: Record<string, unknown> = {};
	const evidencePath = join(experimentRoot, "logs/p0k", `G7-unresolved-${process.env.G7_REPRO_LABEL ?? "current"}-state.json`);
	let worker: WranglerTarget | null = null;
	let peer: PublicPeer | null = null;
	let daemon: Daemon | null = null;
	try {
		await mkdir(vaultPath);
		await writeFile(join(vaultPath, "origin.md"), "origin content\n");
		worker = await launchWrangler();
		const claimed = await claimServer(worker.host);
		const enrollment = await enroll(vaultPath, { xdgStateHome: statePath, host: worker.host, pairingCode: claimed.pairingCode });
		assert.equal((await enrollment.waitForExit()).code, 0, enrollment.dump());
		const enrollmentPath = await findFile(statePath, "enrollment.json");
		assert.ok(enrollmentPath);
		const enrollmentState = JSON.parse(await readFile(enrollmentPath, "utf8")) as { membership: Identity };
		const identity = enrollmentState.membership;
		const peerIdentity = await enrollPublic(worker.host, await mintPairingCode(identity, "device"), "G7 public peer");
		peer = await PublicPeer.connect(peerIdentity);
		daemon = startDaemon({ vaultPath, vaultId: claimed.vaultId, xdgStateHome: statePath, reconcileIntervalMs: 1_500 });
		await daemon.waitForReady();
		assert.equal((await daemon.stop()).code, 0, daemon.dump());
		daemon = null;
		const databasePath = join(dirname(enrollmentPath), "client.sqlite");
		captures.beforeOfflineChanges = snapshot(databasePath);
		const cursorDatabase = new DatabaseSync(databasePath, { readOnly: true });
		const oldCursor = Number(cursorDatabase.prepare("SELECT sequence FROM feed_cursor").get()?.sequence ?? 0);
		cursorDatabase.close();
		const bodyId = await peer.create(source, remoteText);
		assert.ok(await waitFor(() => peer!.read(source).then((content) => content === remoteText), 15_000));
		await peer.delete(source);
		assert.ok(await waitFor(() => peer!.read(source).then((content) => content === null), 15_000));
		const beforeRestart = snapshot(databasePath);
		assert.ok(!(beforeRestart.materializedPaths as Array<{ body_id: string }>).some((entry) => entry.body_id === bodyId));
		captures.beforeRestart = beforeRestart;
		captures.oldCursor = oldCursor;
		captures.remoteBodyId = bodyId;
		captures.feedBeforeRestart = await feedAfter(identity, oldCursor);
		await writeFile(join(vaultPath, source), localText);
		daemon = startDaemon({ vaultPath, vaultId: claimed.vaultId, xdgStateHome: statePath, reconcileIntervalMs: 1_500 });
		await daemon.waitForReady();
		captures.afterReady = snapshot(databasePath);
		const observed = await waitFor(() => daemon!.preservedUnresolved().some((line) => line.includes(source)), diagnosticWaitMs);
		captures.observedPreservedUnresolved = observed;
		captures.afterDiagnosticWait = snapshot(databasePath);
		captures.feedAfterRestartFromOldCursor = await feedAfter(identity, oldCursor);
		captures.daemonDump = daemon.dump();
		captures.localContent = await readFile(join(vaultPath, source), "utf8");
		captures.remoteContent = await peer.read(source);
		process.stdout.write(JSON.stringify(captures, null, 2) + "\n");
		assert.equal(captures.localContent, localText, "independent local text must survive exactly");
		assert.equal(captures.remoteContent, null, "unseen deletion must not silently become a fresh local publication");
		assert.ok(observed, `missing preserved-unresolved diagnostic after ${diagnosticWaitMs}ms\n${daemon.dump()}`);
		assert.ok((captures.afterDiagnosticWait as { preserved: Array<{ path: string }> }).preserved.some((entry) => entry.path === source), "preservation must be durable, not a fabricated diagnostic");
		await rename(join(vaultPath, source), join(vaultPath, target));
		assert.ok(await waitFor(() => peer!.read(target).then((content) => content === localText), 15_000));
		assert.equal(await peer.read(source), null, "renaming preserved content must not revive the old remote path");
		assert.equal(await readFile(join(vaultPath, target), "utf8"), localText);
	} finally {
		await mkdir(dirname(evidencePath), { recursive: true });
		await writeFile(evidencePath, JSON.stringify(captures, null, 2) + "\n");
		if (daemon) await daemon.stop();
		peer?.close();
		if (worker) await worker.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

await tests.done();
