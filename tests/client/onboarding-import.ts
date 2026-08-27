import { strict as assert } from "node:assert";
import {
	LocalVaultImporter,
	type LocalFileRevision,
	type LocalInventoryEntry,
	type LocalVaultImportSink,
	type LocalVaultImportSinkInput,
	type LocalVaultImportSource,
} from "../../src/onboarding/localVaultImport";
import { MemoryLocalVaultImportStateStore } from "../../src/onboarding/localVaultImportStore";
import { fetchVaultProvisioningProof, readVaultProvisioningProof } from "../../src/onboarding/provisioningClient";
import { suite } from "../harness.ts";

const s = suite("onboarding-import");

interface FakeFile {
	content: string;
	mtime: number;
}

class FakeSource implements LocalVaultImportSource {
	readonly files = new Map<string, FakeFile>();

	set(path: string, content: string, mtime = Date.now()): void {
		this.files.set(path, { content, mtime });
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	async captureInventory(): Promise<readonly LocalInventoryEntry[]> {
		return [...this.files].map(([path, file]) => ({
			path,
			mtime: file.mtime,
			size: new TextEncoder().encode(file.content).byteLength,
		}));
	}

	async read(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) throw new Error("missing");
		return file.content;
	}

	async stat(path: string): Promise<LocalFileRevision | null> {
		const file = this.files.get(path);
		return file ? {
			mtime: file.mtime,
			size: new TextEncoder().encode(file.content).byteLength,
		} : null;
	}
}

class FakeSink implements LocalVaultImportSink {
	readonly commits: LocalVaultImportSinkInput[] = [];
	readonly failPaths = new Set<string>();
	active = 0;
	maxActive = 0;
	afterCommit: ((input: LocalVaultImportSinkInput) => void) | null = null;

	async importFile(input: LocalVaultImportSinkInput): Promise<{ bodyId: string }> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await Promise.resolve();
			if (this.failPaths.has(input.path)) throw new Error("simulated interruption");
			this.commits.push({ ...input });
			this.afterCommit?.(input);
			return { bodyId: input.bodyId };
		} finally {
			this.active--;
		}
	}
}

class BatchFakeSink extends FakeSink {
	readonly batches: number[] = [];

	async importFiles(
		inputs: readonly LocalVaultImportSinkInput[],
	): Promise<Array<{ bodyId: string }>> {
		this.batches.push(inputs.length);
		const results: Array<{ bodyId: string }> = [];
		for (const input of inputs) results.push(await this.importFile(input));
		return results;
	}
}

function importer(
	source: FakeSource,
	sink: FakeSink,
	store = new MemoryLocalVaultImportStateStore(),
	overrides: Partial<ConstructorParameters<typeof LocalVaultImporter>[3]> = {},
): LocalVaultImporter {
	let id = 0;
	return new LocalVaultImporter(source, sink, store, {
		vaultId: "vault",
		maxFileSizeBytes: 1024 * 1024,
		excludePatterns: [],
		configDir: ".obsidian",
		concurrency: 4,
		pageSize: 100,
		makeId: () => `stable-id-${++id}`,
		...overrides,
	});
}

s.test("interrupted import persists partial success and resumes only outstanding work", async () => {
	const source = new FakeSource();
	source.set("a.md", "# A", 1);
	source.set("b.md", "# B", 1);
	const sink = new FakeSink();
	sink.failPaths.add("b.md");
	const store = new MemoryLocalVaultImportStateStore();
	const first = await importer(source, sink, store).run();
	assert.equal(first.stage, "attention-required");
	assert.equal(first.items.find((item) => item.path === "a.md")?.status, "imported");
	assert.equal(first.items.find((item) => item.path === "b.md")?.status, "failed");

	sink.failPaths.clear();
	const resumed = await importer(source, sink, store).run();
	assert.equal(resumed.stage, "complete");
	assert.equal(sink.commits.filter((commit) => commit.path === "a.md").length, 1);
	assert.equal(sink.commits.filter((commit) => commit.path === "b.md").length, 1);
});
s.test("restart converts an in-flight durable checkpoint back to retryable work", async () => {
	const source = new FakeSource();
	source.set("restart.md", "# Restart", 1);
	const sink = new FakeSink();
	const store = new MemoryLocalVaultImportStateStore();
	const machine = importer(source, sink, store);
	const interrupted = await machine.capture();
	interrupted.stage = "importing";
	interrupted.items[0]!.status = "importing";
	await store.save(interrupted);

	const resumed = await importer(source, sink, store).run();
	assert.equal(resumed.stage, "complete");
	assert.equal(resumed.items[0]?.status, "imported");
	assert.equal(sink.commits.length, 1);
});


s.test("Unicode normalization and case collisions are explicit outstanding work", async () => {
	const source = new FakeSource();
	source.set("Notes/Café.md", "one", 1);
	source.set("notes/cafe\u0301.md", "two", 1);
	source.set("Project.md", "three", 1);
	source.set("project.md", "four", 1);
	const sink = new FakeSink();
	const store = new MemoryLocalVaultImportStateStore();
	const state = await importer(source, sink, store).run();
	assert.equal(state.stage, "attention-required");
	assert.equal(state.items.filter((item) => item.status === "collision").length, 4);
	assert.equal(sink.commits.length, 0);

	source.remove("notes/cafe\u0301.md");
	source.remove("project.md");
	const resolved = await importer(source, sink, store).run();
	assert.equal(resolved.stage, "complete");
	assert.deepEqual(sink.commits.map((commit) => commit.path).sort(), ["Notes/Café.md", "Project.md"]);
});

s.test("exclusions, byte size, and malformed frontmatter are validated before upload", async () => {
	const source = new FakeSource();
	source.set("private/skip.md", "skip", 1);
	source.set("large.md", "€€€", 1);
	source.set("bad.md", "---\ntitle: missing fence", 1);
	const state = await importer(source, new FakeSink(), undefined, {
		excludePatterns: ["private/"],
		maxFileSizeBytes: 8,
	}).run();
	assert.equal(state.items.find((item) => item.path === "private/skip.md")?.status, "excluded");
	assert.equal(state.items.find((item) => item.path === "large.md")?.status, "oversized");
	assert.equal(state.items.find((item) => item.path === "bad.md")?.status, "invalid-frontmatter");
});

s.test("an edit during upload is retried with the latest content and a fresh candidate", async () => {
	const source = new FakeSource();

	source.set("edited.md", "first", 1);
	const sink = new FakeSink();
	let edited = false;
	sink.afterCommit = (input) => {
		if (!edited && input.path === "edited.md") {
			edited = true;
			source.set("edited.md", "second", 2);
		}
	};
	const state = await importer(source, sink).run();
	assert.equal(state.stage, "complete");
	assert.deepEqual(sink.commits.map((commit) => commit.content), ["first", "second"]);
	assert.notEqual(sink.commits[0]?.candidateId, sink.commits[1]?.candidateId);
});
s.test("configured Markdown byte boundary accepts exact limit and rejects one byte over without sink writes", async () => {
	const limit = 1_500_000;
	const source = new FakeSource();
	source.set("near.md", "a".repeat(1_490_000), 1);
	source.set("exact.md", "b".repeat(limit), 1);
	source.set("over.md", "c".repeat(limit + 1), 1);
	source.set("unicode-exact.md", `${"€".repeat(499_999)}abc`, 1);
	source.set("unicode-over.md", `${"€".repeat(500_000)}x`, 1);
	const sink = new FakeSink();
	const state = await importer(source, sink, undefined, {
		maxFileSizeBytes: limit,
		pageSize: 10,
	}).run();
	assert.equal(state.items.find((item) => item.path === "near.md")?.status, "imported");
	assert.equal(state.items.find((item) => item.path === "exact.md")?.status, "imported");
	assert.equal(state.items.find((item) => item.path === "unicode-exact.md")?.status, "imported");
	assert.equal(state.items.find((item) => item.path === "over.md")?.status, "oversized");
	assert.equal(state.items.find((item) => item.path === "unicode-over.md")?.status, "oversized");
	assert.match(
		state.items.find((item) => item.path === "over.md")?.lastError ?? "",
		/file-size-1500001-exceeds-1500000/,
	);
	assert.deepEqual(
		sink.commits.map((commit) => commit.path).sort(),
		["exact.md", "near.md", "unicode-exact.md"],
		"rejected bodies never reach candidate or catalog creation",
	);
});

s.test("large captured inventory is paged with bounded concurrency and excludes later arrivals", async () => {
	const source = new FakeSource();
	for (let index = 0; index < 1505; index++) {
		source.set(`bulk/note-${String(index).padStart(4, "0")}.md`, `# ${index}`, 1);
	}
	const sink = new FakeSink();
	const machine = importer(source, sink, undefined, { concurrency: 7, pageSize: 128 });
	await machine.capture();
	source.set("bulk/after-boundary.md", "not in initial boundary", 2);
	const state = await machine.run();
	assert.equal(state.stage, "complete");
	assert.equal(state.items.length, 1505);
	assert.equal(sink.commits.length, 1505);
	assert.ok(sink.maxActive <= 7);
	assert.ok(sink.maxActive > 1);
	assert.equal(sink.commits.some((commit) => commit.path === "bulk/after-boundary.md"), false);
});

s.test("large initial import uses bounded bulk submissions instead of one request per note", async () => {
	const source = new FakeSource();
	for (let index = 0; index < 1000; index++) {
		source.set(`batched/note-${String(index).padStart(4, "0")}.md`, `# ${index}`, 1);
	}
	const sink = new BatchFakeSink();
	const state = await importer(source, sink, undefined, {
		concurrency: 8,
		pageSize: 1000,
	}).run();
	assert.equal(state.stage, "complete");
	assert.equal(sink.commits.length, 1000);
	assert.equal(sink.batches.reduce((sum, count) => sum + count, 0), 1000);
	assert.ok(sink.batches.every((count) => count > 0 && count <= 32));
	assert.ok(sink.batches.length <= 32, `expected at most 32 network batches, got ${sink.batches.length}`);
});


s.test("provisioning proof parser rejects incomplete or wrong-format responses", () => {
	assert.deepEqual(readVaultProvisioningProof({
		vaultId: "vault",
		vaultGeneration: "generation",
		provisionedAt: 1,
		schemaVersion: 4,
		storageFormatVersion: 1,
		protocolVersion: 1,
		runtimeEpoch: "epoch",
	}), {
		vaultId: "vault",
		vaultGeneration: "generation",
		provisionedAt: 1,
		schemaVersion: 4,
		storageFormatVersion: 1,
		protocolVersion: 1,
		runtimeEpoch: "epoch",
	});
	assert.throws(() => readVaultProvisioningProof({
		vaultId: "vault",
		vaultGeneration: "generation",
		provisionedAt: 1,
		schemaVersion: 3,
		storageFormatVersion: 1,
		protocolVersion: 1,
		runtimeEpoch: "epoch",
	}));
});



s.test("devices read provisioned status and never call a public provision route", async () => {
	let requestedUrl = "";
	let requestedMethod = "";
	const proof = await fetchVaultProvisioningProof({
		host: "https://sync.test/",
		deviceToken: "device-token",
		vaultId: "vault",
	}, async (request) => {
		requestedUrl = request.url;
		requestedMethod = request.method ?? "GET";
		return {
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {
				vaultId: "vault",
				vaultGeneration: "generation",
				provisionedAt: 1,
				schemaVersion: 4,
				storageFormatVersion: 1,
				protocolVersion: 1,
				runtimeEpoch: "epoch",
			},
			text: "",
		};
	});
	assert.equal(requestedUrl, "https://sync.test/vault/vault/status");
	assert.equal(requestedMethod, "GET");
	assert.equal(proof.vaultGeneration, "generation");
});

await s.done();
