import assert from "node:assert/strict";
import { type App, TFile } from "obsidian";
import { BodyCoordinator } from "../../src/sync/bodyCoordinator";
import { validateBodySettlement, type BodySettlementRead, type StoredBodySettlementV1 } from "../../src/sync/bodySettlement";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import { DiskMirror } from "../../src/sync/diskMirror";
import {
	contentBaselineHash,
	setCurrentContentHash,
	setPartialContentHashes,
	trustedContentHash,
	type DiskIndexEntry,
} from "../../src/sync/diskIndex";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("G4 missing common base and trusted disk settlement");
const path = "Artifact.md";
const bodyId = "artifact-body";
const scope = "local-db-current";
const baselineText = "# Artifact\n\nlast agreed content\n";
const remoteText = "# Artifact\n\nnewest remote content\n";
const localEdit = "# Artifact\n\nindependent local work\n";

async function fixture(options: {
	disk?: string;
	baseline?: string | null;
	baselineScope?: string;
	partialBaseline?: boolean;
	legacyBaselinePort?: boolean;
	commonBase?: BodySettlementRead;
	beforeBaseReturn?: (coordinator: BodyCoordinator) => void;
	beforeProcess?: () => string;
	pendingEpisode?: boolean;
} = {}) {
	let disk = options.disk ?? baselineText;
	const baseline = options.baseline === undefined ? baselineText : options.baseline;
	const entry: DiskIndexEntry = { mtime: 1, size: new TextEncoder().encode(disk).length };
	if (baseline !== null) {
		const hash = await contentBaselineHash(baseline);
		if (options.partialBaseline) setPartialContentHashes(entry, hash, hash, scope);
		else setCurrentContentHash(entry, hash, options.baselineScope ?? scope);
	}
	const file = Object.assign(new TFile(), { path, stat: { ctime: 1, mtime: 1, size: entry.size } });
	const coordinator = new BodyCoordinator();
	coordinator.ensure(bodyId);
	coordinator.setResidency(bodyId, "warm");
	coordinator.replacePathBindings([[path, bodyId]]);
	const writes: string[] = [];
	const callbacks: Array<{ hash: string; content: string }> = [];
	const commits: string[] = [];
	const artifacts: string[] = [];
	const episodeArtifacts = new Map<string, string>();
	const episodes = options.pendingEpisode ? new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (artifactPath) => episodeArtifacts.get(artifactPath) ?? null,
		write: async (artifactPath, content, expected) => {
			assert.equal(episodeArtifacts.get(artifactPath) ?? null, expected);
			episodeArtifacts.set(artifactPath, content);
		},
		persist: async () => {}, changed: () => {}, notify: () => {},
	}) : null;
	if (episodes) await episodes.preserve({ bodyId, path, disk, body: remoteText, device: "test-device" });
	const divergences: string[] = [];
	const app = partialOf<App>({
		vault: {
			getAbstractFileByPath: (requested) => requested === path ? file : null,
			read: async () => disk,
			process: async (_file, transform) => {
				if (options.beforeProcess) disk = options.beforeProcess();
				const next = transform(disk);
				writes.push(next);
				disk = next;
				return disk;
			},
			modify: async () => { assert.fail("settlement must use the atomic vault.process path"); },
			create: async (_path, content) => {
				artifacts.push(content);
				return file;
			},
		},
	});
	const runtime = partialOf<VaultSync>({
		bodies: { coordinator, captureRevision: (requested) => coordinator.capture(requested) },
	});
	const mirror = new DiskMirror(app, runtime, partialOf<EditorBindingManager>({ isBound: () => false }), false);
	mirror.configureSettlement({
		conflictEpisodes: episodes ?? undefined,
		getBaseline: () => ({
			contentHash: trustedContentHash(entry, scope) ?? null,
			...(options.legacyBaselinePort ? {} : { trustedWhole: true }),
		}),
		getCommonBase: async () => {
			await Promise.resolve();
			options.beforeBaseReturn?.(coordinator);
			return options.commonBase ?? { kind: "missing" };
		},
		commitLocalBody: async (input) => { commits.push(input.content); return "completed"; },
		commitMergedBody: async (input) => { commits.push(input.mergedContent); return "completed"; },
		markDivergence: (_bodyId, state) => { divergences.push(state); },
	});
	mirror.setDiskWriteCallback((_path, hash, content) => {
		callbacks.push({ hash, content });
		setCurrentContentHash(entry, hash, scope);
	});
	return {
		mirror, writes, callbacks, commits, artifacts, entry, episodes, divergences,
		disk: () => disk,
		settle: (content = remoteText) => mirror.settleBody({ path, bodyId, generation: 4, content }),
		destroy: () => { episodes?.dispose(); mirror.destroy(); coordinator.dispose(); },
	};
}

tests.test("a missing asynchronously persisted common base cannot wedge unchanged trusted disk behind the remote head", async () => {
	const subject = await fixture();
	try {
		assert.equal(await subject.settle(), "settled");
		assert.equal(subject.disk(), remoteText);
		assert.deepEqual(subject.writes, [remoteText], "remote projection uses exactly one atomic disk write");
		assert.deepEqual(subject.callbacks, [{ hash: await contentBaselineHash(remoteText), content: remoteText }]);
		assert.deepEqual(subject.commits, [], "stale disk must not be committed over newer remote content");
		assert.deepEqual(subject.artifacts, [], "unchanged trusted disk is not an independent conflict");
		assert.equal(subject.mirror.isPreservedUnresolved(path), false);
	} finally { subject.destroy(); }
});

tests.test("the 683-byte baseline materializes the 701065-byte generation-4 artifact instead of failing five safe settlements", async () => {
	const oldArtifact = "# A\n" + "a".repeat(678) + "\n";
	const newestArtifact = "# A\n" + "r".repeat(701060) + "\n";
	assert.equal(new TextEncoder().encode(oldArtifact).length, 683);
	assert.equal(new TextEncoder().encode(newestArtifact).length, 701065);
	const subject = await fixture({ disk: oldArtifact, baseline: oldArtifact });
	try {
		const results: string[] = [];
		for (let attempt = 0; attempt < 5; attempt++) results.push(await subject.settle(newestArtifact));
		assert.deepEqual(results, Array<string>(5).fill("settled"));
		assert.equal(subject.disk(), newestArtifact);
		assert.deepEqual(subject.writes, [newestArtifact]);
		assert.equal(trustedContentHash(subject.entry, scope), await contentBaselineHash(newestArtifact));
		assert.deepEqual(subject.commits, []);
		assert.deepEqual(subject.artifacts, []);
	} finally { subject.destroy(); }
});

tests.test("unchanged trusted disk projects a 3 MiB remote artifact without entering bounded three-way merge", async () => {
	const newestArtifact = "r".repeat(3 * 1024 * 1024);
	const subject = await fixture();
	try {
		assert.equal(await subject.settle(newestArtifact), "settled");
		assert.equal(subject.disk(), newestArtifact);
		assert.deepEqual(subject.writes, [newestArtifact]);
		assert.deepEqual(subject.commits, []);
		assert.deepEqual(subject.artifacts, []);
	} finally { subject.destroy(); }
});

tests.test("a valid but lagging full base cannot defeat a newer trusted whole-disk agreement", async () => {
	const earlier = "# Artifact\n\nearlier durable agreement\n";
	const hash = await contentBaselineHash(earlier);
	const settlement: StoredBodySettlementV1 = {
		format: 1, bodyId, vaultGeneration: "vault-generation", canonicalVersion: "markdown-lf-v1",
		content: earlier, contentHash: hash, durableGeneration: 1, serverContentHash: hash,
		diskFingerprint: { bytes: new TextEncoder().encode(earlier).length, hash }, pathAtSettlement: path,
		localSettlementRevision: 1, settledAt: 1,
	};
	assert.equal(validateBodySettlement(settlement, bodyId, { vaultGeneration: "vault-generation", canonicalVersion: "markdown-lf-v1" }), null);
	const subject = await fixture({ commonBase: { kind: "available", settlement } });
	try {
		assert.equal(await subject.settle(), "settled");
		assert.equal(subject.disk(), remoteText);
		assert.deepEqual(subject.writes, [remoteText]);
		assert.deepEqual(subject.commits, []);
		assert.deepEqual(subject.artifacts, []);
	} finally { subject.destroy(); }
});

for (const scenario of [
	{ name: "no whole-disk baseline", options: { baseline: null } },
	{ name: "disk changed since its trusted whole baseline", options: { disk: localEdit } },
	{ name: "invalid full-base record", options: { commonBase: { kind: "invalid", reason: "content-corrupt" } as BodySettlementRead } },
	{ name: "body-only baseline with no agreed properties", options: { partialBaseline: true } },
	{ name: "whole baseline from another database incarnation", options: { baselineScope: "local-db-obsolete" } },
	{ name: "legacy caller without explicit whole-baseline trust", options: { legacyBaselinePort: true } },
]) {
	tests.test(`${scenario.name} must preserve instead of taking the missing-base shortcut`, async () => {
		const subject = await fixture(scenario.options);
		const before = subject.disk();
		try {
			assert.equal(await subject.settle(), "preserved-unresolved");
			assert.equal(subject.disk(), before);
			assert.deepEqual(subject.writes, []);
			assert.deepEqual(subject.callbacks, []);
			assert.deepEqual(subject.commits, []);
			assert.equal(subject.mirror.isPreservedUnresolved(path), true);
		} finally { subject.destroy(); }
	});
}

tests.test("atomic disk CAS must retain an edit that arrives after baseline comparison", async () => {
	const subject = await fixture({ beforeProcess: () => localEdit });
	try {
		assert.equal(await subject.settle(), "replan");
		assert.equal(subject.disk(), localEdit);
		assert.deepEqual(subject.writes, []);
		assert.deepEqual(subject.callbacks, []);
		assert.deepEqual(subject.commits, []);
	} finally { subject.destroy(); }
});

tests.test("remote body revision advancing during common-base read invalidates the old projection", async () => {
	const subject = await fixture({ beforeBaseReturn: (coordinator) => { coordinator.advanceContent(bodyId); } });
	try {
		const outcome = await subject.settle();
		assert.ok(outcome === "replan" || outcome === "preserved-unresolved", "a stale body revision must refuse projection");
		assert.equal(subject.disk(), baselineText);
		assert.deepEqual(subject.writes, []);
		assert.deepEqual(subject.callbacks, []);
		assert.deepEqual(subject.commits, []);
	} finally { subject.destroy(); }
});

tests.test("a pending conflict episode remains review-required despite a matching trusted whole-disk hash", async () => {
	const subject = await fixture({ pendingEpisode: true });
	const episodeId = subject.episodes!.get(bodyId)!.id;
	try {
		assert.equal(await subject.settle(), "preserved-unresolved");
		assert.equal(subject.episodes!.get(bodyId)!.id, episodeId);
		assert.equal(subject.episodes!.list().length, 1);
		assert.equal(await subject.episodes!.readVersion(bodyId, await contentBaselineHash(baselineText)), baselineText);
		assert.equal(await subject.episodes!.readVersion(bodyId, await contentBaselineHash(remoteText)), remoteText);
		assert.deepEqual(subject.divergences, ["decision-required"]);
		assert.equal(subject.mirror.isPreservedUnresolved(path), true);
		assert.deepEqual(subject.commits, []);
	} finally { subject.destroy(); }
});

await tests.done();
