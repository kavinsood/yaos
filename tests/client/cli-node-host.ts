import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { promises as fs, chmodSync, lstatSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { build } from "esbuild";
import type { TFile } from "obsidian";
import type { NodeApp as NodeAppInstance } from "../../packages/cli/src/nodeApp";
import { processFileCheckedReplacement } from "../../packages/cli/src/fs";
import { suite } from "../harness.ts";

const hostSuite = suite("cli-node-host");
const hostLoader = createJiti(import.meta.url, {
	alias: {
		obsidian: fileURLToPath(new URL("../../packages/cli/src/obsidian-shim.ts", import.meta.url)),
		"@shared": fileURLToPath(new URL("../../server/src/shared", import.meta.url)),
	},
});
const { NodeApp, MAX_MARKDOWN_FILE_BYTES, DEFAULT_PROCESS_RETAINED_BYTES } = await hostLoader.import<typeof import("../../packages/cli/src/nodeApp")>(
	fileURLToPath(new URL("../../packages/cli/src/nodeApp.ts", import.meta.url)),
);

async function fixture(test: (host: NodeAppInstance, root: string, file: TFile) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(nodePath.join(tmpdir(), "yaos-cli-host-"));
	try {
		const host = await NodeApp.create(root, { maximumPendingMutationBytes: 64 * 1024 * 1024 });
		const file = await host.vault.create("note.md", "before\n");
		await test(host, root, file);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

hostSuite.test("live lookups and walks share stable physical file handles", () => fixture(async (host, root, file) => {
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	assert.equal(host.vault.getMarkdownFiles()[0], file);
	host.index.forget("note.md");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	await fs.writeFile(nodePath.join(root, "note.md"), "external in-place edit\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	assert.equal(file.stat.size, Buffer.byteLength("external in-place edit\n"));
}));

hostSuite.test("external atomic replacement invalidates captured handles and blocks stale writers", () => fixture(async (host, root, file) => {
	await fs.writeFile(nodePath.join(root, "replacement"), "external replacement\n");
	await fs.rename(nodePath.join(root, "replacement"), nodePath.join(root, "note.md"));
	const replacement = host.vault.getAbstractFileByPath("note.md");
	assert.notEqual(replacement, file);
	assert.equal(host.vault.getAbstractFileByPath("note.md"), replacement);
	let callbacks = 0;
	await assert.rejects(host.vault.process(file, () => { callbacks += 1; return "stale"; }), /identity changed/);
	await assert.rejects(host.vault.modify(file, "stale"), /identity changed/);
	assert.equal(callbacks, 0);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "external replacement\n");
}));

hostSuite.test("own atomic rewrites, binary and adapter writes retain handle identity", () => fixture(async (host, _root, file) => {
	await host.vault.modify(file, "modified\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	assert.equal(await host.vault.process(file, (content) => `${content}processed\n`), "modified\nprocessed\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	await host.vault.modifyBinary(file, new TextEncoder().encode("binary\n").buffer as ArrayBuffer);
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	await host.vault.adapter.write("note.md", "adapter\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	await host.vault.adapter.writeBinary("note.md", new TextEncoder().encode("adapter binary\n").buffer as ArrayBuffer);
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
}));

hostSuite.test("own rename moves cached identity and all file metadata", () => fixture(async (host, _root, file) => {
	await host.fileManager.renameFile(file, "nested/renamed.txt");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), null);
	assert.equal(host.vault.getAbstractFileByPath("nested/renamed.txt"), file);
	assert.equal(file.basename, "renamed");
	assert.equal(file.extension, "txt");
	await host.vault.process(file, (content) => `${content}after rename\n`);
	assert.equal(await host.vault.read(file), "before\nafter rename\n");
}));

hostSuite.test("rename rejects a target created during the final preparation await and preserves both files", () => fixture(async (host, root, file) => {
	const assertWritable = host.assertWritable.bind(host);
	let targetChecks = 0;
	let hookCalls = 0;
	host.assertWritable = async (path, absolute) => {
		await assertWritable(path, absolute);
		if (path === "target.md" && ++targetChecks === 2) {
			writeFileSync(nodePath.join(root, "target.md"), "unknown target during await\n");
		}
	};
	await assert.rejects(host.fileManager.renameFile(file, "target.md", () => { hookCalls += 1; }), /File already exists/);
	assert.equal(hookCalls, 0);
	assert.equal(file.path, "note.md");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "before\n");
	assert.equal(await fs.readFile(nodePath.join(root, "target.md"), "utf8"), "unknown target during await\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
	await host.vault.process(file, (content) => `${content}queue released\n`);
	assert.equal(await host.vault.read(file), "before\nqueue released\n");
	assert.equal(await fs.readFile(nodePath.join(root, "target.md"), "utf8"), "unknown target during await\n");
}));

hostSuite.test("rename rejects a target created by beforeMutation and preserves source and target bytes", () => fixture(async (host, root, file) => {
	let hookCalls = 0;
	await assert.rejects(host.fileManager.renameFile(file, "target.md", () => {
		hookCalls += 1;
		writeFileSync(nodePath.join(root, "target.md"), "unknown target from hook\n");
	}), /File already exists/);
	assert.equal(hookCalls, 1);
	assert.equal(file.path, "note.md");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "before\n");
	assert.equal(await fs.readFile(nodePath.join(root, "target.md"), "utf8"), "unknown target from hook\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
}));

hostSuite.test("rename rejects a source replaced during the last preparation await", () => fixture(async (host, root, file) => {
	const assertWritable = host.assertWritable.bind(host);
	let targetChecks = 0;
	let hookCalls = 0;
	host.assertWritable = async (path, absolute) => {
		await assertWritable(path, absolute);
		if (path === "target.md" && ++targetChecks === 2) {
			renameSync(nodePath.join(root, "note.md"), nodePath.join(root, "saved-source.md"));
			writeFileSync(nodePath.join(root, "note.md"), "unknown replacement source\n");
		}
	};
	await assert.rejects(host.fileManager.renameFile(file, "target.md", () => { hookCalls += 1; }), /identity changed/);
	assert.equal(hookCalls, 0);
	assert.equal(await fs.readFile(nodePath.join(root, "saved-source.md"), "utf8"), "before\n");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "unknown replacement source\n");
	assert.equal(host.vault.getAbstractFileByPath("target.md"), null);
	assert.equal(file.path, "note.md");
}));

hostSuite.test("rename revalidates source physical identity after beforeMutation", () => fixture(async (host, root, file) => {
	await assert.rejects(host.fileManager.renameFile(file, "target.md", () => {
		renameSync(nodePath.join(root, "note.md"), nodePath.join(root, "saved-source.md"));
		writeFileSync(nodePath.join(root, "note.md"), "unknown replacement source\n");
	}), /identity changed/);
	assert.equal(await fs.readFile(nodePath.join(root, "saved-source.md"), "utf8"), "before\n");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "unknown replacement source\n");
	assert.equal(host.vault.getAbstractFileByPath("target.md"), null);
	assert.equal(file.path, "note.md");
}));

hostSuite.test("own folder rename retains descendant handles", () => fixture(async (host, _root, _file) => {
	const folder = await host.vault.createFolder("folder");
	const child = await host.vault.create("folder/child.md", "child");
	await host.fileManager.renameFile(folder, "moved");
	assert.equal(host.vault.getAbstractFileByPath("moved/child.md"), child);
	assert.equal(child.path, "moved/child.md");
	assert.equal(host.vault.getAbstractFileByPath("folder/child.md"), null);
}));

hostSuite.test("folder rename does not adopt an externally replaced child as the old handle", () => fixture(async (host, root, _file) => {
	const folder = await host.vault.createFolder("folder");
	const child = await host.vault.create("folder/child.md", "old child");
	await fs.writeFile(nodePath.join(root, "replacement"), "external child");
	await fs.rename(nodePath.join(root, "replacement"), nodePath.join(root, "folder/child.md"));
	await host.fileManager.renameFile(folder, "moved");
	assert.notEqual(host.vault.getAbstractFileByPath("moved/child.md"), child);
	assert.equal(await fs.readFile(nodePath.join(root, "moved/child.md"), "utf8"), "external child");
	await assert.rejects(host.vault.process(child, () => "stale"));
}));

hostSuite.test("publication bookkeeping never adopts an unexpected external inode", () => fixture(async (host, root, file) => {
	const published = lstatSync(nodePath.join(root, "note.md"));
	await fs.writeFile(nodePath.join(root, "replacement"), "external after publication");
	await fs.rename(nodePath.join(root, "replacement"), nodePath.join(root, "note.md"));
	assert.throws(() => host.adoptWrittenFile(file.path, file, published), /Published file replaced externally/);
	assert.notEqual(host.vault.getAbstractFileByPath("note.md"), file);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "external after publication");
}));

hostSuite.test("delete then recreate never reuses the deleted logical handle", () => fixture(async (host, _root, file) => {
	await host.fileManager.trashFile(file);
	const created = await host.vault.create("note.md", "new file");
	assert.notEqual(created, file);
	await assert.rejects(host.vault.process(file, () => "stale"), /identity changed/);
	assert.equal(await host.vault.read(created), "new file");
}));

hostSuite.test("all own writers serialize with process exact read and preserve subsequent edits", () => fixture(async (host, _root, file) => {
	const modified = host.vault.modify(file, "first\n");
	const processed = host.vault.process(file, (content) => {
		assert.equal(content, "first\n");
		return `${content}second\n`;
	}, { retainedBytes: 2 * ("first\n".length + "second\n".length) });
	const adapter = host.vault.adapter.write("note.md", "third\n");
	const final = host.vault.process(file, (content) => `${content}fourth\n`, { retainedBytes: 2 * ("third\n".length + "fourth\n".length) });
	await Promise.all([modified, processed, adapter, final]);
	assert.equal(await host.vault.read(file), "third\nfourth\n");
	assert.equal(host.vault.getAbstractFileByPath("note.md"), file);
}));

hostSuite.test("exact raw snapshot mismatch rejects without writing or canonicalizing", () => fixture(async (host, root, file) => {
	await fs.writeFile(nodePath.join(root, "note.md"), "\ufeffbefore\r\n");
	let observedContent = "";
	await assert.rejects(host.vault.process(file, (content) => {
		observedContent = content;
		if (content !== "before\n") throw new Error("CAS mismatch");
		return "remote";
	}), /CAS mismatch/);
	assert.equal(observedContent, "\ufeffbefore\r\n");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "\ufeffbefore\r\n");
	assert.deepEqual(await fs.readdir(root), ["note.md"]);
}));

hostSuite.test("callback throw releases queue without changing data or mode", () => fixture(async (host, root, file) => {
	const path = nodePath.join(root, "note.md");
	chmodSync(path, 0o640);
	await assert.rejects(host.vault.process(file, () => { throw new Error("rejected"); }), /rejected/);
	assert.equal(await host.vault.read(file), "before\n");
	await host.vault.process(file, (content) => `${content}accepted\n`);
	assert.equal(lstatSync(path).mode & 0o777, 0o640);
	assert.deepEqual(await fs.readdir(root), ["note.md"]);
}));

hostSuite.test("observed external in-place mutation during transform is preserved", () => fixture(async (host, root, file) => {
	await assert.rejects(host.vault.process(file, () => {
		const writer = spawnSync(process.execPath, ["--input-type=module", "-e",
			"import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'external changed inputs\\n');",
			nodePath.join(root, "note.md")], { encoding: "utf8" });
		assert.equal(writer.status, 0, writer.stderr);
		return "stale proposed replacement\n";
	}), /source changed/);
	assert.equal(await host.vault.read(file), "external changed inputs\n");
	assert.deepEqual(await fs.readdir(root), ["note.md"]);
}));

hostSuite.test("observed external replacement during transform is preserved", () => fixture(async (host, root, file) => {
	await assert.rejects(host.vault.process(file, () => {
		writeFileSync(nodePath.join(root, "replacement"), "external replacement\n");
		renameSync(nodePath.join(root, "replacement"), nodePath.join(root, "note.md"));
		return "stale";
	}), /identity changed/);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "external replacement\n");
	assert.notEqual(host.vault.getAbstractFileByPath("note.md"), file);
}));

hostSuite.test("process bounds inputs and outputs and rejects asynchronous transforms", () => fixture(async (host, root, file) => {
	await assert.rejects(host.vault.process(file, () => "oversized".padEnd(MAX_MARKDOWN_FILE_BYTES + 1, "!")), /output type or size/);
	await assert.rejects(async () => {
		const result: unknown = Reflect.apply(host.vault.process, host.vault, [file, () => Promise.resolve("async")]);
		await result;
	}, /output type or size/);
	assert.equal(await host.vault.read(file), "before\n");
	let callbacks = 0;
	await assert.rejects(processFileCheckedReplacement(nodePath.join(root, "note.md"), () => {
		callbacks += 1;
		return "new";
	}, { maximumBytes: 2, root: host.rootRealPath, identity: lstatSync(nodePath.join(root, "note.md")), executor: host.criticalIo,
		assertCurrent: () => host.assertCurrentFile(file) }), /input size/);
	assert.equal(callbacks, 0);
}));

hostSuite.test("nofollow and fresh ancestor containment protect outside files", () => fixture(async (host, root, file) => {
	const outside = await fs.mkdtemp(nodePath.join(tmpdir(), "yaos-cli-outside-"));
	try {
		const outsidePath = nodePath.join(outside, "protected.md");
		await fs.writeFile(outsidePath, "protected\n");
		await fs.unlink(nodePath.join(root, "note.md"));
		symlinkSync(outsidePath, nodePath.join(root, "note.md"));
		await assert.rejects(host.vault.process(file, () => "unsafe"), /regular file/);
		const folder = await host.vault.createFolder("nested");
		const nested = await host.vault.create("nested/protected.md", "inside\n");
		assert.equal(host.vault.getAbstractFileByPath(nested.path), nested);
		renameSync(nodePath.join(root, folder.path), nodePath.join(root, "saved"));
		symlinkSync(outside, nodePath.join(root, "nested"));
		await assert.rejects(host.vault.process(nested, () => "unsafe"), /Symlink traversal/);
		await assert.rejects(host.vault.adapter.write("nested/protected.md", "unsafe"), /Symlink traversal/);
		assert.equal(await fs.readFile(outsidePath, "utf8"), "protected\n");
		assert.deepEqual(await fs.readdir(outside), ["protected.md"]);
	} finally {
		await fs.rm(outside, { recursive: true, force: true });
	}
}));

hostSuite.test("mutation admission is finite, FIFO, rejects rather than retaining waiters", () => fixture(async (_host, root) => {
	const host = await NodeApp.create(root, { maximumPendingMutations: 2 });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const order: string[] = [];
	const first = host.mutate(async () => { order.push("first"); await gate; });
	const second = host.mutate(() => { order.push("second"); });
	await assert.rejects(host.mutate(() => { order.push("rejected"); }), /admission full/);
	release();
	await Promise.all([first, second]);
	await host.mutate(() => { order.push("third"); });
	assert.deepEqual(order, ["first", "second", "third"]);
}));

hostSuite.test("helper deadline keeps host queue fenced until exit and propagates failure", () => fixture(async (_host, root) => {
	let exited = false;
	let mutationRan = false;
	const host = await NodeApp.create(root, { deadlineMs: 100,
		helperSource: "setInterval(() => {}, 1000)",
		onSpawn: (child) => {
			const kill = child.kill.bind(child);
			child.kill = (signal) => { setTimeout(() => kill(signal), 150); return true; };
			child.on("close", () => { exited = true; });
		},
	});
	const file = host.vault.getAbstractFileByPath("note.md") as TFile;
	const processed = host.vault.process(file, () => "unsafe", { retainedBytes: 2 * "unsafe".length });
	const queued = host.mutate(() => { mutationRan = true; });
	const rejected = Promise.all([assert.rejects(processed, /deadline/), assert.rejects(queued, /deadline/), assert.rejects(host.failure, /deadline/)]);
	await new Promise((resolve) => setTimeout(resolve, 190));
	assert.equal(exited, false);
	assert.equal(mutationRan, false);
	assert.equal(host.mutationDiagnostics.active, 1);
	assert.equal(host.mutationDiagnostics.pending, 2);
	assert.equal(host.mutationDiagnostics.failed, true);
	await rejected;
	assert.equal(exited, true);
	assert.equal(host.mutationDiagnostics.active, 0);
	assert.equal(host.mutationDiagnostics.pending, 0);
	assert.equal(host.mutationDiagnostics.failed, true);
	await assert.rejects(host.vault.adapter.write("note.md", "unsafe"), /deadline/);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "before\n");
}));

hostSuite.test("payload admission and diagnostics do not retain rejected writes", () => fixture(async (_host, root) => {
	const host = await NodeApp.create(root, { maximumPendingMutationBytes: 16 });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const held = host.mutate(() => gate, 15);
	await assert.rejects(host.vault.adapter.write("note.md", "too large"), /admission full/);
	assert.equal(host.mutationDiagnostics.payloadBytes, 15);
	assert.equal(host.mutationDiagnostics.pending, 1);
	assert.equal(host.mutationDiagnostics.rejected, 1);
	release();
	await held;
	assert.equal(host.mutationDiagnostics.payloadBytes, 0);
	await host.vault.adapter.write("note.md", "small");
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "small");
	assert.equal(host.mutationDiagnostics.pending, 0);
}));

hostSuite.test("process uses cached identity, not main synchronous probes or bookkeeping", () => fixture(async (host, _root, file) => {
	const residualProbe = (): never => { throw new Error("main synchronous probe would block"); };
	host.assertCurrentFile = residualProbe;
	host.assertWritableSync = residualProbe;
	host.assertWritableParentSync = residualProbe;
	host.statSyncEntry = residualProbe;
	host.abstractFileFor = residualProbe;
	host.adoptWrittenFile = residualProbe;
	host.makeTFile = residualProbe;
	assert.equal(await host.vault.process(file, (content) => `${content}supervised\n`), "before\nsupervised\n");
	assert.equal(file.stat.size, Buffer.byteLength("before\nsupervised\n", "utf8"));
	assert.throws(() => host.vault.getAbstractFileByPath("note.md"), /main synchronous probe/);
}));

hostSuite.test("small stale source cannot admit 64 large transform captures under 32 MiB", () => fixture(async (_host, root) => {
	const host = await NodeApp.create(root);
	const file = host.vault.getAbstractFileByPath("note.md") as TFile;
	file.stat.size = 0;
	const expected = "e".repeat(5 * 1024 * 1024 - 32);
	const next = "n".repeat(5 * 1024 * 1024 - 32);
	const retainedBytes = 2 * (expected.length + next.length);
	let callbacks = 0;
	const transform = (source: string): string => {
		callbacks += 1;
		assert.equal(source, "before\n");
		assert.equal(expected.length, next.length);
		return next;
	};
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const held = host.mutate(() => gate);
	try {
		assert(DEFAULT_PROCESS_RETAINED_BYTES > host.mutationDiagnostics.maximumPayloadBytes);
		const opaque = Array.from({ length: 64 }, () => assert.rejects(host.vault.process(file, transform), /admission full/));
		await Promise.all(opaque);
		assert.equal(host.mutationDiagnostics.pending, 1);
		assert.equal(host.mutationDiagnostics.payloadBytes, 0);
		assert.equal(host.mutationDiagnostics.rejected, 64);
		const accepted = host.vault.process(file, transform, { retainedBytes });
		const rejected = Array.from({ length: 63 }, () => assert.rejects(host.vault.process(file, transform, { retainedBytes }), /admission full/));
		await Promise.all(rejected);
		assert.equal(host.mutationDiagnostics.pending, 2);
		assert.equal(host.mutationDiagnostics.payloadBytes, retainedBytes);
		assert.equal(host.mutationDiagnostics.rejected, 127);
		assert.equal(callbacks, 0);
		release();
		await held;
		assert.equal(await accepted, next);
		assert.equal(callbacks, 1);
		assert.equal(host.mutationDiagnostics.pending, 0);
		assert.equal(host.mutationDiagnostics.payloadBytes, 0);
	} finally {
		release();
		await held;
	}
}));

hostSuite.test("string writers charge UTF-16 retained payload while binary writers charge byteLength", () => fixture(async (_host, root) => {
	const host = await NodeApp.create(root, { maximumPendingMutationBytes: 8 });
	const file = host.vault.getAbstractFileByPath("note.md") as TFile;
	const text = "abcde";
	assert.equal(Buffer.byteLength(text, "utf8"), 5);
	await assert.rejects(host.vault.modify(file, text), /admission full/);
	await assert.rejects(host.vault.create("new.md", text), /admission full/);
	await assert.rejects(host.vault.adapter.write("note.md", text), /admission full/);
	assert.equal(host.mutationDiagnostics.pending, 0);
	assert.equal(host.mutationDiagnostics.payloadBytes, 0);
	assert.equal(host.mutationDiagnostics.rejected, 3);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "before\n");
	const binary = new Uint8Array([1, 2, 3, 4, 5]).buffer;
	await host.vault.modifyBinary(file, binary);
	await host.vault.createBinary("new.bin", binary);
	await host.vault.adapter.writeBinary("note.md", binary);
	assert.deepEqual(await fs.readFile(nodePath.join(root, "note.md")), Buffer.from(binary));
	assert.equal(host.mutationDiagnostics.pending, 0);
}));

hostSuite.test("bundled Node host process admits declared captures under the default 32 MiB cap", () => fixture(async (_host, root) => {
	const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
	const bundled = await build({ stdin: {
		contents: 'import assert from "node:assert/strict"; import { NodeApp } from "./packages/cli/src/nodeApp"; const host = await NodeApp.create(process.argv[2]); const file = host.vault.getAbstractFileByPath("note.md"); const expected = "before\\n"; const next = "bundled declared\\n"; assert.equal(host.mutationDiagnostics.maximumPayloadBytes, 32 * 1024 * 1024); await assert.rejects(host.vault.process(file, () => next), /retained bytes requested/); await host.vault.process(file, current => { assert.equal(current, expected); return next; }, { retainedBytes: 2 * (expected.length + next.length) }); assert.equal(await host.vault.read(file), next); assert.equal(host.mutationDiagnostics.payloadBytes, 0); console.log("bundled declared process passed");',
		resolveDir: repositoryRoot, sourcefile: "host-bundle-smoke.ts", loader: "ts",
	}, alias: {
		obsidian: nodePath.join(repositoryRoot, "packages/cli/src/obsidian-shim.ts"),
		"@shared": nodePath.join(repositoryRoot, "server/src/shared"),
	}, bundle: true, write: false, format: "esm", platform: "node", target: "node24" });
	const artifact = nodePath.join(root, "host-smoke.mjs");
	await fs.writeFile(artifact, bundled.outputFiles[0]!.contents);
	const result = spawnSync(process.execPath, [artifact, root], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: "" } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /bundled declared process passed/);
	assert.equal(await fs.readFile(nodePath.join(root, "note.md"), "utf8"), "bundled declared\n");
}));

await hostSuite.done();
