import { strict as assert } from "node:assert";
import { TFile } from "obsidian";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { DiskIndex } from "../../src/sync/diskIndex";
import type { DiskBodyCommitInput, DiskBodyCommitResult, VaultSync } from "../../src/sync/vaultSync";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("markdown-admission-recovery");

interface AdmissionFixture {
	readonly controller: ReconciliationController;
	readonly active: Set<string>;
	readonly commits: DiskBodyCommitInput[];
	readonly reads: Map<string, number>;
	setFailingReads(path: string, count: number): void;
	setFailingCommits(path: string, count: number): void;
}

function file(path: string, size: number): TFile {
	const value = new TFile();
	value.path = path;
	Object.assign(value, { stat: { ctime: 1, mtime: 1, size } });
	return value;
}

function fixture(
	contents: Record<string, string>,
	initialDiskIndex: DiskIndex = {},
): AdmissionFixture {
	const files = new Map(Object.entries(contents).map(([path, content]) => [path, file(path, content.length)]));
	const active = new Set<string>();
	const commits: DiskBodyCommitInput[] = [];
	const reads = new Map<string, number>();
	const failingReads = new Map<string, number>();
	const failingCommits = new Map<string, number>();
	let diskIndex = initialDiskIndex;
	const runtime = partialOf<VaultSync>({
		connectionGeneration: 1,
		getFileId: (path) => active.has(path) ? `body:${path}` : undefined,
		getActiveMarkdownPaths: () => [...active],
		getTextForPath: () => null,
		isPendingRenameTarget: () => false,
		commitDiskBody: async (input): Promise<DiskBodyCommitResult> => {
			commits.push(input);
			const remaining = failingCommits.get(input.path) ?? 0;
			if (remaining > 0) {
				failingCommits.set(input.path, remaining - 1);
				throw new Error(`injected commit failure for ${input.path}`);
			}
			active.add(input.path);
			return { lifecycle: input.lifecycle ?? null, revived: false, receipt: null };
		},
	});
	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [...files.values()],
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				read: async (target: TFile) => {
					reads.set(target.path, (reads.get(target.path) ?? 0) + 1);
					const remaining = failingReads.get(target.path) ?? 0;
					if (remaining > 0) {
						failingReads.set(target.path, remaining - 1);
						throw new Error(`injected read failure for ${target.path}`);
					}
					return contents[target.path]!;
				},
				adapter: {
					stat: async (path: string) => {
						const target = files.get(path);
						return target ? { type: "file", ctime: 1, mtime: 1, size: target.stat.size } : null;
					},
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "Test device", originImportPending: false }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => runtime,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});
	return {
		controller,
		active,
		commits,
		reads,
		setFailingReads(path, count) { failingReads.set(path, count); },
		setFailingCommits(path, count) { failingCommits.set(path, count); },
	};
}

s.test("a transient disk read failure retries without another vault event", async () => {
	const path = "Clipper/retry.md";
	const test = fixture({ [path]: "eventually durable" });
	test.setFailingReads(path, 1);
	await test.controller.runReconciliation("authoritative");
	await until(() => test.active.has(path), {
		timeoutMs: 2_000,
		intervalMs: 10,
		message: "failed Markdown admission retried",
	});
	assert.equal(test.reads.get(path), 2);
	assert.equal(test.commits.length, 1);
	test.controller.reset();
});

s.test("a transient durable commit failure retries the same admission intent", async () => {
	const path = "Clipper/commit-retry.md";
	const test = fixture({ [path]: "persist me" });
	test.setFailingCommits(path, 1);
	await test.controller.runReconciliation("authoritative");
	await until(() => test.active.has(path), {
		timeoutMs: 2_000,
		intervalMs: 10,
		message: "failed durable Markdown admission retried",
	});
	assert.equal(test.reads.get(path), 2);
	assert.equal(test.commits.length, 2);
	assert.equal(test.commits[0]?.bodyId, test.commits[1]?.bodyId);
	assert.equal(test.commits[0]?.candidateId, test.commits[1]?.candidateId);
	test.controller.reset();
});

s.test("an unchanged disk-index entry cannot hide a missing catalog identity", async () => {
	const path = "Clipper/unchanged.md";
	const content = "missing from root";
	const test = fixture({ [path]: content }, {
		[path]: { mtime: 1, size: content.length },
	});
	await test.controller.runReconciliation("authoritative");
	await until(() => test.active.has(path), {
		timeoutMs: 1_500,
		intervalMs: 10,
		message: "untracked Markdown admitted despite unchanged stats",
	});
	assert.equal(test.commits.length, 1);
	test.controller.reset();
});

s.test("inventory reconstructs volatile admission lost during reset", async () => {
	const path = "Clipper/reset.md";
	const test = fixture({ [path]: "survives reset" });
	const pendingFile = new TFile();
	pendingFile.path = path;
	test.controller.markMarkdownDirty(pendingFile, "create", "pre-reset-event");
	test.controller.reset();
	await test.controller.runReconciliation("authoritative");
	await until(() => test.active.has(path), {
		timeoutMs: 1_500,
		intervalMs: 10,
		message: "post-reset inventory reconstructed admission",
	});
	assert.equal(test.commits.length, 1);
	test.controller.reset();
});

s.test("a burst with one transient failure eventually admits every file once", async () => {
	const contents = Object.fromEntries(
		Array.from({ length: 25 }, (_, index) => [`Clipper/burst-${index}.md`, `file ${index}`]),
	);
	const failedPath = "Clipper/burst-7.md";
	const test = fixture(contents);
	test.setFailingReads(failedPath, 1);
	await test.controller.runReconciliation("authoritative");
	await until(() => test.active.size === 25, {
		timeoutMs: 3_000,
		intervalMs: 10,
		message: "all burst files admitted",
	});
	assert.equal(test.commits.length, 25);
	assert.equal(test.reads.get(failedPath), 2);
	assert.equal(new Set(test.commits.map((commit) => commit.path)).size, 25);
	test.controller.reset();
});

await s.done();
