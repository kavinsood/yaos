import { strict as assert } from "node:assert";
import {
	BULK_CREATE_MAX_ITEMS,
	FreshAdmissionCancelledError,
	VaultMutationRequestError,
	VaultSync,
	splitByBulkCreateCaps,
	type VaultSyncOptions,
} from "../../src/sync/vaultSync";
import { bulkCreateClientCaps, parseBulkCreateServerCaps } from "../../src/sync/bulkCreateCaps";
import type { StoredAttachmentPublicationOperation } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault, testProvider, type MemoryVault } from "./helpers/fakeBulkCreateServer.ts";

installDomCrypto();
const s = suite("bulk-create-client");

function runtimeFor(
	vault: MemoryVault,
	server: FakeBulkCreateServer,
	extra: Partial<VaultSyncOptions> = {},
): VaultSync {
	return new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database, server: server.port(),
		providerFactory: testProvider, ...extra,
	});
}

const input = (name: string, content: string, reason = "test") => ({
	bodyId: `body-${name}`, path: `${name}.md`, content, candidateId: `candidate-${name}`, reason,
});

s.test("D5 fold: two creates for one path inside the window send one request with the newer text", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server, { createCollectorDelayMs: 30 });
	const first = runtime.commitFreshBody(input("note", "draft"));
	const second = runtime.commitFreshBody({ ...input("note", "draft plus more"), bodyId: "body-note-2", candidateId: "candidate-2" });
	await assert.rejects(first, FreshAdmissionCancelledError);
	const result = await second;
	assert.equal(server.calls.length, 1);
	assert.equal(server.calls[0]!.files.length, 1);
	assert.equal(result.bodyId, "body-note-2");
	assert.equal(server.bodyText("body-note-2"), "draft plus more");
	assert.equal(server.candidateCalls, 0, "the folded text travels inside the create");
	assert.equal(runtime.getFileId("note.md"), "body-note-2");
	await runtime.destroy();
});

s.test("D5 hold: edits during an in-flight create are sent only after its receipt", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server, { createCollectorDelayMs: 0 });
	server.hold();
	const created = runtime.commitFreshBody(input("note", "v1"));
	await until(() => server.calls.length === 1, { timeoutMs: 1_000, intervalMs: 1, message: "bulk request in flight" });
	const edited = runtime.commitFreshBody({ ...input("note", "v1 then v2"), bodyId: "ignored", candidateId: "ignored" });
	await runtime.retryPendingCandidates();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(server.candidateCalls, 0, "no candidate may reach the server before its file");
	server.release();
	const [first, second] = await Promise.all([created, edited]);
	assert.equal(first.bodyId, "body-note");
	assert.equal(second.bodyId, "body-note");
	assert.ok(second.receipt, "the held edit commits as a candidate for the created body");
	assert.deepEqual(server.events, ["bulk:note.md", "candidate:body-note"]);
	assert.equal(server.bodyText("body-note"), "v1 then v2");
	assert.equal(server.calls.length, 1);
	await runtime.destroy();
});

s.test("b3-int D5: typing into a new note within 50 ms of its create loses no keystroke and sends nothing before the create", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server, { createCollectorDelayMs: 20 });
	server.hold();
	const typed = "Hello, new note!";
	const started = Date.now();
	// The first save folds away (cancelled) once later keystrokes replace it.
	const create = runtime.commitFreshBody(input("fresh", typed.slice(0, 1))).then((value) => value, (error: unknown) => error);
	// The editor's bind retry waits on the create; it must not resolve before the receipt.
	let settled: boolean | null = null;
	void runtime.whenCreateSettled("fresh.md").then((value) => { settled = value; });
	const saves: Array<Promise<unknown>> = [];
	const issueTimes: number[] = [];
	// One save per keystroke, every 3 ms (all inside 50 ms): the early ones fold
	// into the unsent create, the later ones hold behind the in-flight create.
	for (let index = 2; index <= typed.length; index++) {
		await new Promise((resolve) => setTimeout(resolve, 3));
		const before = Date.now();
		saves.push(runtime.commitFreshBody({ ...input("fresh", typed.slice(0, index)), bodyId: `body-fresh-${index}`, candidateId: `candidate-fresh-${index}` })
			.then((value) => value, (error: unknown) => error));
		issueTimes.push(Date.now() - before);
	}
	assert.ok(Date.now() - started < 200, "typing loop is not throttled");
	assert.ok(Math.max(...issueTimes) < 5, `issuing a save never blocks (max ${Math.max(...issueTimes)} ms)`);
	await until(() => server.calls.length === 1, { timeoutMs: 1_000, intervalMs: 1, message: "create in flight" });
	await runtime.retryPendingCandidates();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(server.candidateCalls, 0, "nothing reaches the server before the create");
	assert.equal(settled, null, "the bind retry waits for the receipt");
	server.release();
	await create;
	const outcomes = await Promise.all(saves);
	assert.ok(outcomes.some((outcome) => !(outcome instanceof Error)), "the folded create and the held edits commit");
	await until(() => settled !== null, { timeoutMs: 1_000, intervalMs: 1, message: "bind retry released" });
	assert.equal(settled, true);
	assert.equal(server.events[0], "bulk:fresh.md", "the create is the first thing the server sees");
	assert.ok(server.events.slice(1).every((event) => event.startsWith("candidate:")));
	assert.equal(server.calls.length, 1, "one create request");
	assert.ok(server.candidateCalls >= 1, "some keystrokes were held behind the in-flight create (hold path exercised)");
	assert.ok(outcomes.some((outcome) => outcome instanceof FreshAdmissionCancelledError), "some keystrokes folded into the unsent create (fold path exercised)");
	const bodyId = runtime.getFileId("fresh.md")!;
	assert.ok(bodyId);
	assert.equal(server.bodyText(bodyId), typed, "every keystroke reached the server");
	await runtime.destroy();
});

s.test("b3-int D5: whenCreateSettled is false with no pending create and after destroy", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server, { createCollectorDelayMs: 10_000 });
	assert.equal(await runtime.whenCreateSettled("none.md"), false);
	const pending = runtime.commitFreshBody(input("late", "x")).catch(() => undefined);
	const waiting = runtime.whenCreateSettled("late.md");
	await runtime.destroy();
	assert.equal(await waiting, false);
	await pending;
});

s.test("mixed outcomes: exists-* route to reconcile, rejected items keep no local identity", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	server.seedExisting("same.md", "server-same", "shared text");
	server.seedExisting("diff.md", "server-diff", "their text");
	const owned: Array<{ path: string; existingBodyId: string | null; identical: boolean }> = [];
	const runtime = runtimeFor(vault, server, { onCreatePathOwned: (event) => { owned.push(event); } });
	const result = await runtime.commitFreshBodies([
		input("same", "shared text", "import"),
		input("diff", "my text", "import"),
		input("new", "fresh", "import"),
		{ ...input("bad", "x", "import"), path: "bad.txt" },
	]);
	assert.equal(server.calls.length, 1);
	assert.deepEqual(result.results.map((item) => [item.outcome, item.bodyId]), [
		["exists-identical", "server-same"],
		["exists-different", "server-diff"],
		["created", "body-new"],
		["rejected", "body-bad"],
	]);
	await until(() => owned.length === 2, { timeoutMs: 1_000, intervalMs: 1, message: "reconcile handoff" });
	assert.deepEqual(owned.sort((a, b) => a.path.localeCompare(b.path)), [
		{ path: "diff.md", existingBodyId: "server-diff", identical: false },
		{ path: "same.md", existingBodyId: "server-same", identical: true },
	]);
	assert.equal(runtime.getFileId("same.md"), "server-same", "the server root delta maps the existing owner");
	assert.equal(runtime.getFileId("new.md"), "body-new");
	assert.equal(runtime.getFileId("bad.txt"), undefined);
	assert.equal(vault.lifecycle.size, 0);
	assert.equal(vault.candidates.size, 0);
	assert.equal(server.bodyText("server-diff"), "their text", "exists-different never overwrites");
	await runtime.destroy();
});

s.test("caps: item and byte budgets split batches, and a 413 halves without loss", async () => {
	const counts = splitByBulkCreateCaps(Array.from({ length: BULK_CREATE_MAX_ITEMS + 1 }, (_, i) => i), () => 1)
		.map((chunk) => chunk.length);
	assert.deepEqual(counts, [BULK_CREATE_MAX_ITEMS, 1]);
	const mib = 1024 * 1024;
	assert.deepEqual(splitByBulkCreateCaps([1.5 * mib, 1.5 * mib, 1.5 * mib], (bytes) => bytes)
		.map((chunk) => chunk.length), [2, 1]);

	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server);
	const many = Array.from({ length: BULK_CREATE_MAX_ITEMS + 1 }, (_, i) => input(`n${i}`, `note ${i}`, "import"));
	const result = await runtime.commitFreshBodies(many);
	assert.deepEqual(server.calls.map((call) => call.files.length), [BULK_CREATE_MAX_ITEMS, 1]);
	assert.ok(result.results.every((item) => item.outcome === "created"));

	server.failNext(new VaultMutationRequestError(413, "bulk_create_too_large", "bulk create"));
	const before = server.calls.length;
	const halved = await runtime.commitFreshBodies(["h1", "h2", "h3", "h4"].map((name) => input(name, name, "import")));
	assert.deepEqual(server.calls.slice(before).map((call) => call.files.length), [4, 2, 2]);
	assert.ok(halved.results.every((item) => item.outcome === "created"));
	assert.equal(new Set(server.calls.slice(before).map((call) => call.batchId)).size, 3, "each half is its own batch");
	assert.equal(vault.lifecycle.size, 0);
	await runtime.destroy();
});

s.test("a note above 1.75 MB travels as ordered frames in one create", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = runtimeFor(vault, server, { createCollectorDelayMs: 0 });
	const line = "lorem ipsum dolor sit amet, consectetur adipiscing elit\n";
	const content = line.repeat(Math.ceil((2 * 1024 * 1024) / line.length));
	const result = await runtime.commitFreshBody(input("big", content));
	assert.equal(server.calls.length, 1);
	assert.ok(server.calls[0]!.files[0]!.updates.length > 1, "large content is framed");
	assert.equal(server.bodyText(result.bodyId), content);
	assert.equal(server.candidateCalls, 0);
	await runtime.destroy();
});

s.test("new attachments publish together through one bulk create and settle", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const hashes = ["a", "b", "c"].map((letter) => letter.repeat(64));
	for (const hash of hashes) server.blobs.add(hash);
	let singlePublications = 0;
	hashes.forEach((hash, index) => {
		const operation: StoredAttachmentPublicationOperation = {
			vaultId: "vault-1", vaultGeneration: "generation-1", rootEpoch: 1,
			mutation: { operationId: `att-op-${index}`, kind: "upsert", path: `files/${index}.png`,
				expectedRevision: null, hash, size: 10 + index, mime: "image/png" },
			localSequence: index + 1, createdAt: index, attempts: 0, lastAttemptAt: null,
		};
		vault.attachments.set(operation.mutation.operationId, operation);
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		server: server.port({ publishAttachment: async () => { singlePublications++; throw new Error("single route used"); } }),
		providerFactory: testProvider,
	});
	await runtime.initialize();
	await until(() => vault.attachments.size === 0, { timeoutMs: 2_000, intervalMs: 1, message: "attachments settle" });
	assert.equal(server.calls.length, 1);
	assert.equal(server.calls[0]!.attachments.length, 3);
	assert.equal(server.calls[0]!.files.length, 0);
	assert.equal(singlePublications, 0);
	for (let index = 0; index < 3; index++) {
		assert.equal(runtime.getProjectedAttachmentHead(`files/${index}.png`).revision, `att-op-${index}`);
	}
	await runtime.destroy();
});

s.test("caps follow the server: advertised caps split batches, a 413 body's caps re-split without loss", async () => {
	assert.deepEqual(bulkCreateClientCaps(null), { maxItems: 500, byteBudget: Math.floor(3.5 * 1024 * 1024) });
	assert.deepEqual(bulkCreateClientCaps({ maxItems: 100, maxBytes: 1024 * 1024 }), { maxItems: 100, byteBudget: 917_504 });
	assert.deepEqual(bulkCreateClientCaps({ maxItems: 9_999, maxBytes: 64 * 1024 * 1024 }).maxItems, 500, "never above the defaults");
	assert.equal(parseBulkCreateServerCaps({ maxItems: "3", maxBytes: 1 }), null, "malformed caps are ignored");
	assert.equal(parseBulkCreateServerCaps(undefined), null);

	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	let advertised: unknown = { maxItems: 3, maxBytes: 4 * 1024 * 1024 };
	const runtime = runtimeFor(vault, server, { bulkCreateCaps: () => advertised });
	const seven = await runtime.commitFreshBodies(Array.from({ length: 7 }, (_, i) => input(`c${i}`, `c ${i}`, "import")));
	assert.deepEqual(server.calls.map((call) => call.files.length), [3, 3, 1]);
	assert.ok(seven.results.every((item) => item.outcome === "created"));

	// The server lowered its cap since the capabilities were read: the 413 carries the new caps.
	advertised = undefined;
	server.failNext(new VaultMutationRequestError(413, "bulk_create_too_many_items", "bulk create", null, [],
		{ maxItems: 2, maxBytes: 4 * 1024 * 1024 }));
	let before = server.calls.length;
	const five = await runtime.commitFreshBodies(Array.from({ length: 5 }, (_, i) => input(`d${i}`, `d ${i}`, "import")));
	assert.deepEqual(server.calls.slice(before).map((call) => call.files.length), [5, 2, 2, 1], "split by the 413 caps, not halves");
	assert.ok(five.results.every((item) => item.outcome === "created"));
	before = server.calls.length;
	await runtime.commitFreshBodies(Array.from({ length: 3 }, (_, i) => input(`e${i}`, `e ${i}`, "import")));
	assert.deepEqual(server.calls.slice(before).map((call) => call.files.length), [2, 1], "learned caps persist");
	assert.equal(vault.lifecycle.size, 0);
	await runtime.destroy();
});

await s.done();
