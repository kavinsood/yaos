import { strict as assert } from "node:assert";
import { spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { build } from "esbuild";
import { NodeFsExecutor, NodeFsHostFailure } from "../../packages/cli/src/nodeFsExecutor";
import { NODE_FS_HELPER_SOURCE, type FileIdentity, type FileSnapshot, type NodeFsRequest } from "../../packages/cli/src/nodeFsHelper";
import { suite } from "../harness.ts";

const helperSuite = suite("cli-node-fs-helper");

async function fixture(test: (root: string, request: Extract<NodeFsRequest, { kind: "read" }>) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(nodePath.join(tmpdir(), "yaos-node-helper-"));
	const root = await fs.realpath(directory);
	try {
		const filename = nodePath.join(root, "note.md");
		await fs.writeFile(filename, "before\n", { mode: 0o640 });
		const stats = await fs.stat(filename);
		await test(root, { kind: "read", root, path: filename, maximumBytes: 1024, identity: { dev: stats.dev, ino: stats.ino } });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function replacement(request: Extract<NodeFsRequest, { kind: "read" }>, expected: FileSnapshot): Extract<NodeFsRequest, { kind: "replace" }> {
	return { kind: "replace", root: request.root, path: request.path, maximumBytes: request.maximumBytes,
		expected, output: "after\n", temporary: nodePath.join(request.root, ".yaos-write-helper-test.tmp") };
}

helperSuite.test("checked replacement preserves mode and raw bytes, closes descriptors and removes rejected temps", () => fixture(async (root, request) => {
	const instrumented = NODE_FS_HELPER_SOURCE.replace('const paths = require("node:path");', String.raw`
const paths = require("node:path");
const descriptors = new Set();
const originalOpen = filesystem.openSync;
const originalClose = filesystem.closeSync;
filesystem.openSync = (...args) => { const descriptor = originalOpen(...args); descriptors.add(descriptor); return descriptor; };
filesystem.closeSync = descriptor => { originalClose(descriptor); descriptors.delete(descriptor); };
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = text => {
  if (descriptors.size !== 0) throw new Error("Descriptor leak");
  return originalWrite(text);
};
`);
	const executor = new NodeFsExecutor({ helperSource: instrumented });
	const expected = await executor.execute<FileSnapshot>(request);
	const published = await executor.execute<FileIdentity>(replacement(request, expected));
	assert.equal((await fs.stat(request.path)).ino, published.ino);
	assert.equal((await fs.stat(request.path)).mode & 0o777, 0o640);
	assert.equal(await fs.readFile(request.path, "utf8"), "after\n");
	const latest = await executor.execute<FileSnapshot>({ ...request, identity: published });
	await fs.writeFile(request.path, "external\n");
	await assert.rejects(executor.execute(replacement(request, latest)), /source changed/);
	assert.equal(await fs.readFile(request.path, "utf8"), "external\n");
	assert.deepEqual(await fs.readdir(root), ["note.md"]);
	assert.equal(executor.failureError, undefined);
}));

helperSuite.test("raw invalid UTF-8 is checked rather than normalized by decoded expected text", () => fixture(async (_root, request) => {
	await fs.writeFile(request.path, Buffer.from([0xff, 0x0a]));
	const executor = new NodeFsExecutor();
	const expected = await executor.execute<FileSnapshot>(request);
	await fs.writeFile(request.path, Buffer.from([0xfe, 0x0a]));
	await assert.rejects(executor.execute(replacement(request, expected)), /source changed/);
	assert.deepEqual(await fs.readFile(request.path), Buffer.from([0xfe, 0x0a]));
}));

helperSuite.test("helper rejects fresh parent symlink escapes without touching outside data", () => fixture(async (root, request) => {
	const outside = await fs.mkdtemp(nodePath.join(tmpdir(), "yaos-helper-outside-"));
	try {
		await fs.mkdir(nodePath.join(root, "nested"));
		await fs.writeFile(nodePath.join(outside, "protected.md"), "outside\n");
		await fs.rename(nodePath.join(root, "nested"), nodePath.join(root, "saved"));
		await fs.symlink(outside, nodePath.join(root, "nested"));
		await assert.rejects(new NodeFsExecutor().execute({ ...request, path: nodePath.join(root, "nested", "protected.md") }), /Symlink traversal/);
		assert.equal(await fs.readFile(nodePath.join(outside, "protected.md"), "utf8"), "outside\n");
	} finally {
		await fs.rm(outside, { recursive: true, force: true });
	}
}));

helperSuite.test("read deadline kills helper and rejects only after confirmed exit", () => fixture(async (_root, request) => {
	let exited = false;
	let spawned: ChildProcess | undefined;
	const executor = new NodeFsExecutor({ deadlineMs: 100, helperSource: "setInterval(() => {}, 1000)",
		onSpawn: (child) => { spawned = child; child.on("close", () => { exited = true; }); },
	});
	await assert.rejects(executor.execute(request), (error: unknown) => {
		assert(error instanceof NodeFsHostFailure);
		assert.equal(error.publicationUncertain, false);
		assert.equal(exited, true);
		assert.equal(spawned?.signalCode, "SIGKILL");
		return true;
	});
	await assert.rejects(executor.failure, /deadline/);
	await assert.rejects(executor.execute(request), /deadline/);
}));

for (const response of ['{ ok: true, result: "late" }', '{ ok: false, message: "late rejection", published: false }']) {
helperSuite.test(`late ${response.includes("true") ? "success" : "rejection"} cannot settle timeout before exit or restart a replacement`, () => fixture(async (_root, request) => {
	let exited = false;
	let settled = false;
	let children = 0;
	const executor = new NodeFsExecutor({ deadlineMs: 100,
		helperSource: `setTimeout(() => process.stdout.write(JSON.stringify(${response})), 140); setInterval(() => {}, 1000);`,
		onSpawn: (child) => {
			children += 1;
			const kill = child.kill.bind(child);
			child.kill = (signal) => { setTimeout(() => kill(signal), 150); return true; };
			child.on("close", () => { exited = true; });
		},
	});
	const pending = executor.execute(request).finally(() => { settled = true; });
	const rejected = assert.rejects(pending, /deadline/);
	await new Promise((resolve) => setTimeout(resolve, 190));
	assert.equal(settled, false);
	assert.equal(exited, false);
	await assert.rejects(executor.failure, /deadline/);
	await assert.rejects(executor.execute(request), /deadline/);
	await rejected;
	assert.equal(exited, true);
	await assert.rejects(executor.execute(request), /deadline/);
	assert.equal(children, 1);
}));
}

helperSuite.test("interrupted replacement closes process descriptors and quarantines unproven temp", () => fixture(async (root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const phases: string[] = [];
	const executor = new NodeFsExecutor({ deadlineMs: 150, helperSource: String.raw`
const filesystem = require("node:fs");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  filesystem.openSync(request.temporary, "wx");
  setInterval(() => {}, 1000);
});`,
		onSpawn: (child, current) => { phases.push(current.kind); child.on("close", () => { phases.push(current.kind + "-exit"); }); },
	});
	await assert.rejects(executor.execute(replacement(request, expected)), (error: unknown) => {
		assert(error instanceof NodeFsHostFailure);
		assert.equal(error.publicationUncertain, true);
		assert.equal(error.retainedTemporaryPath, replacement(request, expected).temporary);
		assert.match(error.message, /inspect before removal/);
		return true;
	});
	assert.deepEqual(phases, ["replace", "replace-exit"]);
	assert.deepEqual(await fs.readdir(root), [".yaos-write-helper-test.tmp", "note.md"]);
	assert.equal(await fs.readFile(replacement(request, expected).temporary, "utf8"), "");
	assert.equal(await fs.readFile(request.path, "utf8"), "before\n");
}));

helperSuite.test("lost publication response is uncertain, does not roll back committed bytes", () => fixture(async (root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const source = NODE_FS_HELPER_SOURCE.replace('process.stdout.write(JSON.stringify({ ok: true, result }));', 'setInterval(() => {}, 1000);');
	const executor = new NodeFsExecutor({ deadlineMs: 150, helperSource: source });
	await assert.rejects(executor.execute(replacement(request, expected)), (error: unknown) => {
		assert(error instanceof NodeFsHostFailure);
		assert.equal(error.publicationUncertain, true);
		return true;
	});
	assert.equal(await fs.readFile(request.path, "utf8"), "after\n");
	assert.deepEqual(await fs.readdir(root), ["note.md"]);
}));

helperSuite.test("directory sync failure after publication fences host", () => fixture(async (_root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const source = NODE_FS_HELPER_SOURCE.replace('filesystem.fsyncSync(descriptor);', 'throw Object.assign(new Error("sync failed"), { code: "EIO" });');
	const executor = new NodeFsExecutor({ helperSource: source });
	await assert.rejects(executor.execute(replacement(request, expected)), (error: unknown) => {
		assert(error instanceof NodeFsHostFailure);
		assert.equal(error.publicationUncertain, true);
		return true;
	});
	assert.equal(await fs.readFile(request.path, "utf8"), "after\n");
	await assert.rejects(executor.failure, /publication uncertain/);
}));

helperSuite.test("abnormal exit and malformed response propagate persistent host failure", () => fixture(async (_root, request) => {
	for (const source of ['process.exit(7)', 'process.stdout.write("not json")', 'process.stdout.write("{}")', 'process.stdout.write(JSON.stringify({ ok: true, result: null }))']) {
		const executor = new NodeFsExecutor({ helperSource: source });
		await assert.rejects(executor.execute(request), NodeFsHostFailure);
		await assert.rejects(executor.failure, NodeFsHostFailure);
		await assert.rejects(executor.execute(request), NodeFsHostFailure);
	}
}));

helperSuite.test("request snapshot cannot be changed by caller or observation hook", () => fixture(async (_root, request) => {
	const executor = new NodeFsExecutor({ onSpawn: (_child, snapshot) => { assert(Object.isFrozen(snapshot)); } });
	const pending = executor.execute<FileSnapshot>(request);
	Object.assign(request, { path: nodePath.join(request.root, "missing.md") });
	assert.equal((await pending).content, "before\n");
}));

for (const operation of ["read", "replace", "rename"] as const) {
	for (const interruption of ["hang", "crash"] as const) {
		for (const phase of operation === "read" ? ["before"] : ["before", "after"]) {
			helperSuite.test(`${operation} native I/O ${interruption} ${phase} publication confirms exit and fences host`, () => fixture(async (root, request) => {
				const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
				const target = nodePath.join(root, "renamed.md");
				const current: NodeFsRequest = operation === "read" ? request : operation === "replace" ? replacement(request, expected) : {
					kind: "rename", root, path: request.path, target, identity: request.identity,
				};
				const interruptionCode = interruption === "hang" ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);' : 'process.exit(9);';
				const syscall = operation === "read" ? 'const count = filesystem.readSync(descriptor, bytes, offset, bytes.length - offset, null);' : operation === "replace" ?
					'filesystem.renameSync(request.temporary, request.path);' : 'filesystem.renameSync(request.path, request.target);';
				const injected = phase === "before" ? interruptionCode + syscall : syscall + interruptionCode;
				let exited = false;
				const executor = new NodeFsExecutor({ deadlineMs: 200, helperSource: NODE_FS_HELPER_SOURCE.replace(syscall, injected),
					onSpawn: (child, dispatched) => { if (dispatched.kind === operation) child.on("close", () => { exited = true; }); },
				});
				let heartbeat = 0;
				const interval = setInterval(() => { heartbeat += 1; }, 10);
				try {
					await assert.rejects(executor.execute(current), (error: unknown) => {
					assert(error instanceof NodeFsHostFailure);
					assert.equal(error.publicationUncertain, operation !== "read");
					assert.equal(exited, true);
					return true;
					});
				} finally {
					clearInterval(interval);
				}
				if (interruption === "hang") assert(heartbeat > 0, "main event loop must progress during blocked helper I/O");
				await assert.rejects(executor.failure, NodeFsHostFailure);
				await assert.rejects(executor.execute(request), NodeFsHostFailure);
				if (operation === "rename" && phase === "after") {
					assert.equal(await fs.readFile(target, "utf8"), "before\n");
					await assert.rejects(fs.stat(request.path), { code: "ENOENT" });
				} else {
					assert.equal(await fs.readFile(request.path, "utf8"), operation === "replace" && phase === "after" ? "after\n" : "before\n");
				}
				const temporaries = (await fs.readdir(root)).filter((filename) => filename.startsWith(".yaos-write-"));
				assert.equal(temporaries.length, operation === "replace" && phase === "before" ? 1 : 0);
			}));
		}
	}
}

helperSuite.test("normal rejection never removes a replaced foreign temporary", () => fixture(async (root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const source = NODE_FS_HELPER_SOURCE.replace('const current = readChecked(request);', String.raw`
filesystem.renameSync(request.temporary, request.temporary + ".saved");
filesystem.writeFileSync(request.temporary, "foreign unexpected bytes\n");
throw new Error("Rejected with foreign temporary");
const current = readChecked(request);`);
	const executor = new NodeFsExecutor({ helperSource: source });
	await assert.rejects(executor.execute(replacement(request, expected)), /temporary retained.*inspect before removal/);
	assert.equal(await fs.readFile(replacement(request, expected).temporary, "utf8"), "foreign unexpected bytes\n");
	assert.equal(await fs.readFile(nodePath.join(root, ".yaos-write-helper-test.tmp.saved"), "utf8"), "after\n");
	assert.equal(await fs.readFile(request.path, "utf8"), "before\n");
}));

helperSuite.test("normal rejection never removes changed bytes on the owned temporary inode", () => fixture(async (_root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const source = NODE_FS_HELPER_SOURCE.replace('const current = readChecked(request);', String.raw`
filesystem.writeFileSync(request.temporary, "foreign in-place edit\n");
throw new Error("Rejected with changed temporary");
const current = readChecked(request);`);
	await assert.rejects(new NodeFsExecutor({ helperSource: source }).execute(replacement(request, expected)), /temporary retained/);
	assert.equal(await fs.readFile(replacement(request, expected).temporary, "utf8"), "foreign in-place edit\n");
}));

helperSuite.test("interrupted replacement does not delete a foreign temp installed after child exit", () => fixture(async (_root, request) => {
	const expected = await new NodeFsExecutor().execute<FileSnapshot>(request);
	const current = replacement(request, expected);
	const executor = new NodeFsExecutor({ helperSource: "process.exit(9)", onSpawn: (child) => {
		child.on("exit", () => { spawnSync(process.execPath, ["--eval", 'require("node:fs").writeFileSync(process.argv[1], "foreign after exit")', current.temporary]); });
	} });
	await assert.rejects(executor.execute(current), NodeFsHostFailure);
	assert.equal(await fs.readFile(current.temporary, "utf8"), "foreign after exit");
}));

helperSuite.test("bundled executor runs helper under plain Node without source files or loaders", () => fixture(async (root, request) => {
	const bundled = await build({ stdin: {
		contents: 'import { NodeFsExecutor } from "./packages/cli/src/nodeFsExecutor"; const request = JSON.parse(process.argv[2]); const executor = new NodeFsExecutor(); const expected = await executor.execute(request); await executor.execute({ kind: "replace", root: request.root, path: request.path, maximumBytes: request.maximumBytes, expected, output: "bundled\\n", temporary: request.root + "/.yaos-write-bundle.tmp" }); console.log("bundled helper passed");',
		resolveDir: process.cwd(), sourcefile: "helper-bundle-smoke.ts", loader: "ts",
	}, bundle: true, write: false, format: "esm", platform: "node", target: "node24" });
	const artifact = nodePath.join(root, "helper.mjs");
	await fs.writeFile(artifact, bundled.outputFiles[0]!.contents);
	const result = spawnSync(process.execPath, [artifact, JSON.stringify(request)], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, NODE_OPTIONS: "" } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /bundled helper passed/);
	assert.equal(await fs.readFile(request.path, "utf8"), "bundled\n");
}));

await helperSuite.done();
