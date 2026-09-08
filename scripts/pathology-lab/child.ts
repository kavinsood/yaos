import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "../../server/src/shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import { validateFrontmatterSemanticRoots } from "../../server/src/shared/frontmatterSemanticValidation";
import { initializeCanvasDocument } from "../../server/src/shared/canvasSemanticDocument";
import { ROOT_SEMANTIC_ROOTS } from "../../server/src/semanticCompaction";
import { VaultCandidateService } from "../../server/src/vaultCandidateService";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { SemanticCompactionRuntime } from "../../server/src/semanticCompactionRuntime";
import type { SemanticCompactionThresholds } from "../../server/src/semanticCompactionPolicy";
import { bodyUpdateAdmissionError, VaultSocketService, type VaultSocketAttachment,
	type VaultSocketPort } from "../../server/src/vaultSocketService";
import {
	ACTOR,
	BODY_PATH,
	closeStore,
	openStore,
	populateStoreFromCandidates,
	seedStore,
	VAULT_GENERATION,
	VAULT_ID,
} from "./fixture";
import { MemoryTracker, operatingSystemMaxRssBytes } from "./metrics";
import { census, readFrozenFrames, readFrozenSemanticEdits, readTraceManifest, sha256, validateFrozenTrace } from "./trace";
import type { LabMeasurement, PathologyProfile, SemanticEdit } from "./types";

interface ChildSpec {
	readonly arm: string;
	readonly traceDirectory: string;
	readonly fixturePath?: string;
	readonly maxOldSpaceMiB: number;
}

function documentFromFrozenTrace(traceDirectory: string, tracker: MemoryTracker): Y.Doc {
	const manifest = readTraceManifest(traceDirectory);
	const doc = new Y.Doc({ guid: manifest.bodyId });
	let base: Uint8Array | null = new Uint8Array(readFileSync(join(traceDirectory, "base.update")));
	Y.applyUpdate(doc, base, "pathology-base");
	base = null;
	tracker.mark("base-loaded");
	let applied = 0;
	const sampleEvery = Math.max(1, Math.floor(manifest.updates.frames / 10));
	for (const update of readFrozenFrames(join(traceDirectory, "updates.bin"))) {
		Y.applyUpdate(doc, update, "pathology-wire");
		applied++;
		if (applied % sampleEvery === 0) tracker.mark(`wire-${applied}`);
	}
	if (applied !== manifest.updates.frames) throw new Error("wire frame count changed during replay");
	return doc;
}

function verifyFinalDocument(traceDirectory: string, doc: Y.Doc): { text: string; encodedBytes: number } {
	const manifest = readTraceManifest(traceDirectory);
	const text = doc.getText("body").toString();
	const textDigest = sha256(text);
	if (textDigest !== manifest.final.textSha256) {
		throw new Error(`final Markdown mismatch: ${textDigest} != ${manifest.final.textSha256}`);
	}
	return { text, encodedBytes: Y.encodeStateAsUpdate(doc).byteLength };
}

function bodyArm(spec: ChildSpec): LabMeasurement {
	const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
	let doc: Y.Doc | null = documentFromFrozenTrace(spec.traceDirectory, tracker);
	tracker.mark("history-built", true);
	const history = census(doc);
	let resetPeakStartRss = process.memoryUsage().rss;
	const resetPeakStartMaxRss = operatingSystemMaxRssBytes();
	let resetEncodedBytes = 0;

	if (spec.arm === "body-rematerialize") {
		let encoded: Uint8Array | null = Y.encodeStateAsUpdate(doc);
		resetEncodedBytes = encoded.byteLength;
		tracker.mark("rematerialize-encoded");
		const fresh = new Y.Doc({ guid: doc.guid });
		Y.applyUpdate(fresh, encoded, "pathology-rematerialize");
		tracker.mark("rematerialize-both-documents");
		doc.destroy();
		doc = fresh;
		encoded = null;
		tracker.mark("rematerialize-old-released", true);
	} else if (spec.arm === "body-semantic-reset") {
		let markdown: string | null = canonicalizeMarkdown(doc.getText("body").toString());
		tracker.mark("semantic-markdown-materialized");
		const fresh = new Y.Doc({ guid: doc.guid });
		fresh.clientID = 0x1a05_f001;
		fresh.getText("body").insert(0, markdown);
		tracker.mark("semantic-both-documents");
		let encoded: Uint8Array | null = Y.encodeStateAsUpdate(fresh);
		resetEncodedBytes = encoded.byteLength;
		tracker.mark("semantic-fresh-encoded");
		doc.destroy();
		doc = fresh;
		markdown = null;
		encoded = null;
		tracker.mark("semantic-old-released", true);
	} else if (spec.arm !== "body-current") {
		throw new Error(`unknown body arm ${spec.arm}`);
	}

	const final = verifyFinalDocument(spec.traceDirectory, doc);
	const finalCensus = census(doc);
	const resetPeakEndMaxRss = operatingSystemMaxRssBytes();
	const result = tracker.finish({
		textSha256: sha256(final.text),
		textCodeUnits: final.text.length,
		encodedStateBytes: final.encodedBytes,
		census: finalCensus,
		counters: {
			historyStructs: history.structs,
			historyDeletedStructs: history.deletedStructs,
			resetEncodedBytes,
			resetStartRssBytes: resetPeakStartRss,
			interventionNewHighWaterBytes: Math.max(0, resetPeakEndMaxRss - resetPeakStartMaxRss),
			structsRemoved: history.structs - finalCensus.structs,
		},
	});
	doc.destroy();
	return result;
}

async function digest(bytes: Uint8Array): Promise<string> {
	return createHash("sha256").update(bytes).digest("hex");
}

function latencyCounters(latencies: readonly number[]): Record<string, number> {
	if (latencies.length === 0) return {
		latencyMeanMs: 0,
		latencyP50Ms: 0,
		latencyP95Ms: 0,
		latencyP99Ms: 0,
		latencyMaximumMs: 0,
		latencyFirstDecileMeanMs: 0,
		latencyLastDecileMeanMs: 0,
	};
	const sorted = [...latencies].sort((left, right) => left - right);
	const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
	const decile = Math.max(1, Math.ceil(latencies.length / 10));
	const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		latencyMeanMs: mean(latencies),
		latencyP50Ms: percentile(0.5),
		latencyP95Ms: percentile(0.95),
		latencyP99Ms: percentile(0.99),
		latencyMaximumMs: sorted.at(-1)!,
		latencyFirstDecileMeanMs: mean(latencies.slice(0, decile)),
		latencyLastDecileMeanMs: mean(latencies.slice(-decile)),
	};
}

async function serverCurrentArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const cache = new VaultDocumentCache(fixture.store, () => new Set(), () => new Set());
		cache.load(manifest.bodyId, true, () => cache.admitBody(manifest.bodyId));
		const forceCompaction: Readonly<SemanticCompactionThresholds> = {
			softEncodedStateBytes: 1, hardEncodedStateBytes: Number.MAX_SAFE_INTEGER,
			softStructs: 2, hardStructs: Number.MAX_SAFE_INTEGER,
			softDeletedStructs: 1, minimumRatioStructs: 1,
			softDeletedRatio: 0.01, hardDeletedRatio: 1,
			softAmplification: 1.01, hardAmplification: Number.MAX_SAFE_INTEGER,
			minimumAmplificationBytes: 1, minimumProjectedReduction: 0.10,
			softCooldownMs: 0, rearmGrowthFactor: 1,
			hardLatencyViolationStreak: Number.MAX_SAFE_INTEGER,
		};
		const compaction = spec.arm === "server-semantic-compaction"
			? new SemanticCompactionRuntime({
				store: fixture.store,
				cache,
				fenceSockets: () => 0,
				thresholds: () => forceCompaction,
			})
			: null;
		const service = new VaultCandidateService({
			store: fixture.store,
			cache,
			lifecycle: () => ({ finalizeCreation: () => true }),
			sockets: () => ({ broadcastDocumentUpdate: () => {}, notifyBodyCommitted: () => {} }),
			vaultId: () => VAULT_ID,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: "pathology-runtime-0001",
			flush: async () => true,
			validateActor: () => true,
		} as never);
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("server-seeded", true);
		let candidates = 0;
		let rejected = 0;
		let candidateBytes = 0;
		const latencies: number[] = [];
		const sampleEvery = Math.max(1, Math.floor(manifest.candidates.frames / 10));
		for (const update of readFrozenFrames(join(spec.traceDirectory, "candidates.bin"))) {
			const candidateId = `pathology-${String(candidates).padStart(8, "0")}`;
			const started = performance.now();
			const response = await service.handle(manifest.bodyId, new Request("https://internal/candidate", {
				method: "POST",
					headers: {
					"x-yaos-device-id": ACTOR.deviceId,
					"x-yaos-body-epoch": String(fixture.store.documentHead(manifest.bodyId)!.semanticEpoch),
					"x-yaos-candidate-id": candidateId,
					"x-yaos-candidate-digest": await digest(update),
				},
				body: update.slice().buffer,
			}), ACTOR);
			const elapsed = performance.now() - started;
			latencies.push(elapsed);
			candidateBytes += update.byteLength;
			candidates++;
			if (!response.ok) {
				rejected++;
				throw new Error(`candidate ${candidates} failed (${response.status}): ${await response.text()}`);
			}
			if (candidates % sampleEvery === 0) tracker.mark(`candidate-${candidates}`);
		}
		const compactionOutcome = compaction
			? await compaction.measureAndMaybeCompact(manifest.bodyId)
			: null;
		if (compaction && compactionOutcome?.status !== "compacted") {
			throw new Error(`production semantic compaction did not run: ${compactionOutcome?.status}`);
		}
		if (compaction) tracker.mark("production-semantic-compaction", true);
		const loaded = cache.get(manifest.bodyId);
		if (!loaded) throw new Error("pathological body was unexpectedly evicted");
		const final = verifyFinalDocument(spec.traceDirectory, loaded.doc);
		const result = tracker.finish({
			textSha256: sha256(final.text),
			textCodeUnits: final.text.length,
			encodedStateBytes: final.encodedBytes,
			census: census(loaded.doc),
			counters: {
				candidates,
				rejected,
				candidateBytes,
				queries: fixture.queries.count,
				compactionStatus: compactionOutcome?.status ?? null,
				compactionPreviousStructs: compactionOutcome?.status === "compacted" ? compactionOutcome.previousStructs : null,
				compactionFreshStructs: compactionOutcome?.status === "compacted" ? compactionOutcome.freshStructs : null,
				...latencyCounters(latencies),
			},
		});
		cache.clear();
		return result;
	} finally {
		closeStore(fixture);
	}
}

interface SoakClients {
	readonly documents: Y.Doc[];
	readonly epoch: number;
}

function freshSoakClients(baseline: Y.Doc, count: number, epoch: number): SoakClients {
	const state = Y.encodeStateAsUpdate(baseline);
	const documents = Array.from({ length: count }, (_, index) => {
		const document = new Y.Doc({ guid: baseline.guid });
		Y.applyUpdate(document, state, "semantic-soak-baseline");
		// A disjoint identity range per body epoch makes accidental lineage reuse
		// visible in the census and turns this into a real epoch transition test.
		document.clientID = 0x3000_0000 + (epoch * 0x1_0000) + index;
		return document;
	});
	return { documents, epoch };
}

function destroySoakClients(clients: SoakClients): void {
	for (const document of clients.documents) document.destroy();
}

function applySoakEdit(document: Y.Doc, edit: SemanticEdit): Uint8Array {
	const captured: Uint8Array[] = [];
	const observer = (update: Uint8Array, origin: unknown): void => {
		if (origin === "semantic-soak-edit") captured.push(update.slice());
	};
	document.on("update", observer);
	document.transact(() => {
		const text = document.getText("body");
		if (edit.position > text.length || edit.position + edit.deleteCount > text.length) {
			throw new Error(`semantic edit ${edit.sequence} no longer fits the replayed document`);
		}
		if (edit.deleteCount > 0) text.delete(edit.position, edit.deleteCount);
		if (edit.insertText.length > 0) text.insert(edit.position, edit.insertText);
	}, "semantic-soak-edit");
	document.off("update", observer);
	if (captured.length !== 1) throw new Error(`semantic edit ${edit.sequence} emitted ${captured.length} updates`);
	return captured[0]!;
}

function soakCeilings(input: {
	readonly manifest: ReturnType<typeof readTraceManifest>;
	readonly plannedCompactions: number;
	readonly maximumOperationsPerEpoch: number;
	readonly maximumFreshEncodedBytes: number;
}): { structs: number; encodedBytes: number; postResetStructs: number; postResetEncodedBytes: number } {
	const { manifest, plannedCompactions, maximumOperationsPerEpoch, maximumFreshEncodedBytes } = input;
	// These are regression ceilings, not admission proofs. They intentionally
	// leave 4 structs per semantic operation and 2x observed ingress per epoch,
	// while still failing any return to whole-trace/unbounded growth.
	return {
		structs: maximumOperationsPerEpoch * 4 + 64,
		encodedBytes: maximumFreshEncodedBytes
			+ Math.ceil((manifest.updates.bytes * 2) / plannedCompactions)
			+ (64 * 1024),
		postResetStructs: 4,
		postResetEncodedBytes: Math.ceil(manifest.final.utf8Bytes * 1.25) + (64 * 1024),
	};
}

function soakResourceCeilings(profile: PathologyProfile): {
	elapsedMs: number;
	peakAdditionalRssBytes: number;
	reconstructionMs: number;
} {
	// Empirical regression alarms calibrated above both observed stress runs:
	// 5.98s/+212.5 MiB with 2 GiB old-space and 8.85s/+179.8 MiB with
	// 128 MiB old-space. These are Node process ceilings, not Worker limits.
	if (profile.name === "stress") return { elapsedMs: 20_000, peakAdditionalRssBytes: 320 * 1024 * 1024, reconstructionMs: 2_000 };
	if (profile.name === "quick") return { elapsedMs: 2_500, peakAdditionalRssBytes: 64 * 1024 * 1024, reconstructionMs: 500 };
	return {
		elapsedMs: Math.max(2_500, profile.edits * 0.4),
		peakAdditionalRssBytes: 64 * 1024 * 1024,
		reconstructionMs: Math.max(500, profile.edits * 0.04),
	};
}

/**
 * Production-path epoch soak. Unlike the one-shot intervention arm, this uses
 * the real store, cache, candidate service and semantic-compaction runtime for
 * every reset. After a reset it throws away every old client document and
 * regenerates Yjs updates from the frozen semantic operations using fresh
 * client identities.
 */
async function serverSemanticCompactionSoakArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	let clients: SoakClients | null = null;
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const edits = readFrozenSemanticEdits(spec.traceDirectory);
		const cache = new VaultDocumentCache(fixture.store, () => new Set(), () => new Set());
		let loaded = cache.load(manifest.bodyId, true, () => cache.admitBody(manifest.bodyId));
		const forceCompaction: Readonly<SemanticCompactionThresholds> = {
			softEncodedStateBytes: 1, hardEncodedStateBytes: Number.MAX_SAFE_INTEGER,
			softStructs: 2, hardStructs: Number.MAX_SAFE_INTEGER,
			softDeletedStructs: 1, minimumRatioStructs: 1,
			softDeletedRatio: 0.01, hardDeletedRatio: 1,
			softAmplification: 1.01, hardAmplification: Number.MAX_SAFE_INTEGER,
			minimumAmplificationBytes: 1, minimumProjectedReduction: 0.10,
			softCooldownMs: 0, rearmGrowthFactor: 1,
			hardLatencyViolationStreak: Number.MAX_SAFE_INTEGER,
		};
		let fenceCalls = 0;
		const runtime = new SemanticCompactionRuntime({
			store: fixture.store,
			cache,
			fenceSockets: (_documentId, previousEpoch, currentEpoch) => {
				if (currentEpoch !== previousEpoch + 1) throw new Error("socket fence observed a non-consecutive epoch");
				fenceCalls++;
				return 2;
			},
			thresholds: () => forceCompaction,
		});
		const service = new VaultCandidateService({
			store: fixture.store,
			cache,
			lifecycle: () => ({ finalizeCreation: () => true }),
			sockets: () => ({ broadcastDocumentUpdate: () => {}, notifyBodyCommitted: () => {} }),
			vaultId: () => VAULT_ID,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: "pathology-runtime-soak-0001",
			flush: async () => true,
			validateActor: () => true,
		} as never);
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("semantic-soak-seeded", true);

		const plannedCompactions = Math.min(5, manifest.candidates.frames);
		const candidatesPerCompaction = Math.max(1, Math.ceil(manifest.candidates.frames / plannedCompactions));
		const maximumOperationsPerEpoch = candidatesPerCompaction * manifest.profile.candidateEvery;
		clients = freshSoakClients(loaded.doc, manifest.profile.clients, loaded.semanticEpoch);
		let candidateUpdates: Uint8Array[] = [];
		let candidates = 0;
		let compactions = 0;
		let staleEpochRejections = 0;
		let regeneratedClientSets = 1;
		let maximumStructs = census(loaded.doc).structs;
		let maximumEncodedBytes = Y.encodeStateAsUpdate(loaded.doc).byteLength;
		let maximumPostResetStructs = 0;
		let maximumPostResetEncodedBytes = 0;
		let maximumFreshEncodedBytes = maximumEncodedBytes;
		const startingEpoch = loaded.semanticEpoch;

		const submit = async (update: Uint8Array, bodyEpoch: number, id: string): Promise<Response> => service.handle(
			manifest.bodyId,
			new Request("https://internal/candidate", {
				method: "POST",
				headers: {
					"x-yaos-device-id": ACTOR.deviceId,
					"x-yaos-body-epoch": String(bodyEpoch),
					"x-yaos-candidate-id": id,
					"x-yaos-candidate-digest": await digest(update),
				},
				body: update.slice().buffer,
			}),
			ACTOR,
		);

		for (const edit of edits) {
			const editingClient = clients.documents[edit.client];
			if (!editingClient) throw new Error(`semantic edit ${edit.sequence} references missing client ${edit.client}`);
			const update = applySoakEdit(editingClient, edit);
			for (const peer of clients.documents) {
				if (peer !== editingClient) Y.applyUpdate(peer, update, "semantic-soak-peer");
			}
			candidateUpdates.push(update);
			const finalEdit = edit.sequence + 1 === edits.length;
			if (candidateUpdates.length < manifest.profile.candidateEvery && !finalEdit) continue;

			const candidate = Y.mergeUpdates(candidateUpdates);
			candidateUpdates = [];
			const currentEpoch = fixture.store.documentHead(manifest.bodyId)!.semanticEpoch;
			const response = await submit(candidate, currentEpoch, `semantic-soak-${String(candidates).padStart(8, "0")}`);
			if (!response.ok) throw new Error(`semantic soak candidate ${candidates} failed (${response.status}): ${await response.text()}`);
			candidates++;

			const compactionBoundary = candidates % candidatesPerCompaction === 0
				|| candidates === manifest.candidates.frames;
			if (!compactionBoundary) continue;
			loaded = cache.get(manifest.bodyId)!;
			const semanticBefore = loaded.doc.getText("body").toString();
			const beforeCensus = census(loaded.doc);
			const beforeEncodedBytes = Y.encodeStateAsUpdate(loaded.doc).byteLength;
			maximumStructs = Math.max(maximumStructs, beforeCensus.structs);
			maximumEncodedBytes = Math.max(maximumEncodedBytes, beforeEncodedBytes);
			const oldEpoch = loaded.semanticEpoch;
			const staleUpdate = candidate.slice();

			const outcome = await runtime.measureAndMaybeCompact(manifest.bodyId);
			if (outcome.status !== "compacted") {
				throw new Error(`semantic soak compaction ${compactions + 1} did not run: ${outcome.status}`);
			}
			compactions++;
			loaded = cache.get(manifest.bodyId)!;
			if (loaded.semanticEpoch !== oldEpoch + 1) throw new Error("semantic compaction did not advance body epoch exactly once");
			if (loaded.doc.getText("body").toString() !== semanticBefore) throw new Error("semantic compaction changed Markdown");
			const afterCensus = census(loaded.doc);
			const afterEncodedBytes = Y.encodeStateAsUpdate(loaded.doc).byteLength;
			maximumPostResetStructs = Math.max(maximumPostResetStructs, afterCensus.structs);
			maximumPostResetEncodedBytes = Math.max(maximumPostResetEncodedBytes, afterEncodedBytes);
			maximumFreshEncodedBytes = Math.max(maximumFreshEncodedBytes, afterEncodedBytes);

			const staleResponse = await submit(staleUpdate, oldEpoch, `semantic-soak-stale-${compactions}`);
			const stalePayload = await staleResponse.json() as { error?: string };
			if (staleResponse.status !== 409 || stalePayload.error !== "semantic_epoch_mismatch") {
				throw new Error(`old epoch was not fenced after reset: ${staleResponse.status} ${JSON.stringify(stalePayload)}`);
			}
			staleEpochRejections++;

			destroySoakClients(clients);
			clients = freshSoakClients(loaded.doc, manifest.profile.clients, loaded.semanticEpoch);
			regeneratedClientSets++;
			tracker.mark(`semantic-soak-reset-${compactions}`);
		}

		loaded = cache.get(manifest.bodyId)!;
		const final = verifyFinalDocument(spec.traceDirectory, loaded.doc);
		const reconstructionStartedAt = performance.now();
		const recovered = fixture.store.reconstructDocument(manifest.bodyId);
		const reconstructionMs = performance.now() - reconstructionStartedAt;
		try {
			verifyFinalDocument(spec.traceDirectory, recovered.doc);
			if (recovered.semanticEpoch !== loaded.semanticEpoch) throw new Error("recovery returned the wrong semantic epoch");
		} finally {
			recovered.doc.destroy();
		}
		const ceilings = soakCeilings({ manifest, plannedCompactions, maximumOperationsPerEpoch, maximumFreshEncodedBytes });
		const resourceCeilings = soakResourceCeilings(manifest.profile);
		if (compactions !== plannedCompactions) throw new Error(`expected ${plannedCompactions} compactions, observed ${compactions}`);
		if (staleEpochRejections !== compactions) throw new Error("not every reset fenced a stale candidate");
		if (fenceCalls !== compactions) throw new Error("not every reset invoked socket fencing");
		if (maximumStructs > ceilings.structs) throw new Error(`semantic soak struct ceiling crossed: ${maximumStructs} > ${ceilings.structs}`);
		if (maximumEncodedBytes > ceilings.encodedBytes) throw new Error(`semantic soak encoded-state ceiling crossed: ${maximumEncodedBytes} > ${ceilings.encodedBytes}`);
		if (maximumPostResetStructs > ceilings.postResetStructs) throw new Error(`post-reset struct ceiling crossed: ${maximumPostResetStructs} > ${ceilings.postResetStructs}`);
		if (maximumPostResetEncodedBytes > ceilings.postResetEncodedBytes) throw new Error(`post-reset encoded-state ceiling crossed: ${maximumPostResetEncodedBytes} > ${ceilings.postResetEncodedBytes}`);
		if (reconstructionMs > resourceCeilings.reconstructionMs) throw new Error(`semantic soak reconstruction ceiling crossed: ${reconstructionMs.toFixed(1)} > ${resourceCeilings.reconstructionMs}ms`);

		const measured = tracker.finish({
			textSha256: sha256(final.text),
			textCodeUnits: final.text.length,
			encodedStateBytes: final.encodedBytes,
			census: census(loaded.doc),
			counters: {
				candidates,
				semanticOperations: edits.length,
				compactions,
				startingEpoch,
				finalEpoch: loaded.semanticEpoch,
				staleEpochRejections,
				fenceCalls,
				regeneratedClientSets,
				maximumOperationsPerEpoch,
				maximumStructs,
				maximumStructsCeiling: ceilings.structs,
				maximumEncodedBytes,
				maximumEncodedBytesCeiling: ceilings.encodedBytes,
				maximumPostResetStructs,
				maximumPostResetStructsCeiling: ceilings.postResetStructs,
				maximumPostResetEncodedBytes,
				maximumPostResetEncodedBytesCeiling: ceilings.postResetEncodedBytes,
				contentEquivalent: true,
				durableRecoveryEquivalent: true,
				reconstructionMs,
				reconstructionMsCeiling: resourceCeilings.reconstructionMs,
				reconstructionCeilingPassed: true,
				queries: fixture.queries.count,
			},
		});
		const elapsedCeilingPassed = measured.elapsedMs <= resourceCeilings.elapsedMs;
		const peakAdditionalRssCeilingPassed = measured.peakAdditionalRssBytes <= resourceCeilings.peakAdditionalRssBytes;
		const reconstructionCeilingPassed = reconstructionMs <= resourceCeilings.reconstructionMs;
		const allRegressionCeilingsPassed = elapsedCeilingPassed && peakAdditionalRssCeilingPassed && reconstructionCeilingPassed;
		const result: LabMeasurement = {
			...measured,
			counters: {
				...measured.counters,
				processOldSpaceMiB: spec.maxOldSpaceMiB,
				elapsedMsCeiling: resourceCeilings.elapsedMs,
				elapsedCeilingPassed,
				peakAdditionalRssBytesCeiling: resourceCeilings.peakAdditionalRssBytes,
				peakAdditionalRssCeilingPassed,
				reconstructionMs,
				reconstructionMsCeiling: resourceCeilings.reconstructionMs,
				reconstructionCeilingPassed,
				allRegressionCeilingsPassed,
			},
		};
		if (!allRegressionCeilingsPassed) {
			throw new Error(`semantic soak resource ceiling crossed: elapsed ${measured.elapsedMs.toFixed(1)}/${resourceCeilings.elapsedMs}ms, peak additional RSS ${measured.peakAdditionalRssBytes}/${resourceCeilings.peakAdditionalRssBytes} bytes`);
		}
		cache.clear();
		return result;
	} finally {
		if (clients) destroySoakClients(clients);
		closeStore(fixture);
	}
}

async function serverValidatedOnceArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		let live = fixture.store.reconstructDocument(manifest.bodyId).doc;
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("server-seeded", true);
		let candidates = 0;
		let candidateBytes = 0;
		let exactEncodes = 0;
		const latencies: number[] = [];
		const sampleEvery = Math.max(1, Math.floor(manifest.candidates.frames / 10));
		for (const update of readFrozenFrames(join(spec.traceDirectory, "candidates.bin"))) {
			const started = performance.now();
			const head = fixture.store.documentHead(manifest.bodyId);
			const validated = fixture.store.reconstructDocument(manifest.bodyId);
			Y.applyUpdate(validated.doc, update, "validated-once");
			const content = canonicalizeMarkdown(validated.doc.getText("body").toString());
			const contentBytes = canonicalMarkdownBytes(content);
			const measuredBytes = Y.encodeStateAsUpdate(validated.doc).byteLength;
			exactEncodes++;
			const candidateId = `pathology-lean-${String(candidates).padStart(8, "0")}`;
			const candidateDigest = await digest(update);
			fixture.store.commitCandidate({
				bodyId: manifest.bodyId,
				clientId: ACTOR.deviceId,
				candidateId,
				candidateDigest,
				bodyEpoch: head!.semanticEpoch,
				update,
				expectedHead: head,
				changesState: true,
				catalog: {
					bodyId: manifest.bodyId,
					fileId: manifest.bodyId,
					path: BODY_PATH,
					previousPath: null,
					lifecycle: "active",
					bodyGeneration: (head?.generation ?? 0) + 1,
					contentHash: sha256(contentBytes),
					size: contentBytes.byteLength,
				},
				vaultGeneration: VAULT_GENERATION,
				runtimeEpoch: "pathology-runtime-0001",
				actor: ACTOR,
			});
			// This is the proposed lean boundary: the validated post-state supplies
			// the exact size, while the live socket document receives the update
			// directly instead of constructing and encoding a second candidate doc.
			Y.applyUpdate(live, update, "validated-once-live");
			validated.doc.destroy();
			void measuredBytes;
			const elapsed = performance.now() - started;
			latencies.push(elapsed);
			candidateBytes += update.byteLength;
			candidates++;
			if (candidates % sampleEvery === 0) tracker.mark(`candidate-${candidates}`);
		}
		const final = verifyFinalDocument(spec.traceDirectory, live);
		const result = tracker.finish({
			textSha256: sha256(final.text),
			textCodeUnits: final.text.length,
			encodedStateBytes: final.encodedBytes,
			census: census(live),
			counters: {
				candidates,
				candidateBytes,
				exactEncodes,
				queries: fixture.queries.count,
				...latencyCounters(latencies),
			},
		});
		live.destroy();
		return result;
	} finally {
		closeStore(fixture);
	}
}

async function serverPersistentValidationArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const validation = fixture.store.reconstructDocument(manifest.bodyId).doc;
		const live = fixture.store.reconstructDocument(manifest.bodyId).doc;
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("persistent-validation-seeded", true);
		const exactEvery = spec.arm === "server-persistent-exact" ? 1 : 50;
		let exactEncodes = 1;
		let measuredBytes = Y.encodeStateAsUpdate(validation).byteLength;
		let unmeasuredInputBytes = 0;
		let maximumInputLedgerBytes = measuredBytes;
		let ledgerUnderestimateMaximumBytes = 0;
		let candidates = 0;
		let candidateBytes = 0;
		const latencies: number[] = [];
		const sampleEvery = Math.max(1, Math.floor(manifest.candidates.frames / 10));
		for (const update of readFrozenFrames(join(spec.traceDirectory, "candidates.bin"))) {
			const started = performance.now();
			const head = fixture.store.documentHead(manifest.bodyId);
			Y.applyUpdate(validation, update, "persistent-validation");
			const semanticError = validateFrontmatterSemanticRoots(validation);
			if (semanticError) throw new Error(`persistent validation failed: ${semanticError}`);
			const content = validation.getText("body").toString();
			if (content !== canonicalizeMarkdown(content)) throw new Error("persistent validation produced non-canonical Markdown");
			const contentBytes = canonicalMarkdownBytes(content);
			if (contentBytes.byteLength > MAX_CLIENT_MARKDOWN_BYTES) throw new Error("persistent validation crossed Markdown limit");
			unmeasuredInputBytes += update.byteLength;
			maximumInputLedgerBytes = Math.max(maximumInputLedgerBytes, measuredBytes + unmeasuredInputBytes);
			if ((candidates + 1) % exactEvery === 0) {
				const ledgerBytes = measuredBytes + unmeasuredInputBytes;
				const exactBytes = Y.encodeStateAsUpdate(validation).byteLength;
				ledgerUnderestimateMaximumBytes = Math.max(ledgerUnderestimateMaximumBytes, exactBytes - ledgerBytes);
				measuredBytes = exactBytes;
				unmeasuredInputBytes = 0;
				exactEncodes++;
			}
			const candidateId = `pathology-persistent-${String(candidates).padStart(8, "0")}`;
			const candidateDigest = await digest(update);
			fixture.store.commitCandidate({
				bodyId: manifest.bodyId,
				clientId: ACTOR.deviceId,
				candidateId,
				candidateDigest,
				bodyEpoch: head!.semanticEpoch,
				update,
				expectedHead: head,
				changesState: true,
				catalog: {
					bodyId: manifest.bodyId,
					fileId: manifest.bodyId,
					path: BODY_PATH,
					previousPath: null,
					lifecycle: "active",
					bodyGeneration: (head?.generation ?? 0) + 1,
					contentHash: sha256(contentBytes),
					size: contentBytes.byteLength,
				},
				vaultGeneration: VAULT_GENERATION,
				runtimeEpoch: "pathology-runtime-0001",
				actor: ACTOR,
			});
			Y.applyUpdate(live, update, "persistent-validation-live");
			candidateBytes += update.byteLength;
			candidates++;
			latencies.push(performance.now() - started);
			if (candidates % sampleEvery === 0) tracker.mark(`candidate-${candidates}`);
		}
		if (unmeasuredInputBytes > 0) {
			measuredBytes = Y.encodeStateAsUpdate(validation).byteLength;
			exactEncodes++;
		}
		const final = verifyFinalDocument(spec.traceDirectory, validation);
		verifyFinalDocument(spec.traceDirectory, live);
		const result = tracker.finish({
			textSha256: sha256(final.text),
			textCodeUnits: final.text.length,
			encodedStateBytes: final.encodedBytes,
			census: census(validation),
			counters: {
				candidates,
				candidateBytes,
				exactEvery,
				exactEncodes,
				measuredBytes,
				maximumInputLedgerBytes,
				ledgerUnderestimateMaximumBytes,
				queries: fixture.queries.count,
				...latencyCounters(latencies),
			},
		});
		validation.destroy();
		live.destroy();
		return result;
	} finally {
		closeStore(fixture);
	}
}

function socketAdmissionArm(spec: ChildSpec): LabMeasurement {
	const manifest = readTraceManifest(spec.traceDirectory);
	const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
	const live = new Y.Doc({ guid: manifest.bodyId });
	const base = new Uint8Array(readFileSync(join(spec.traceDirectory, "base.update")));
	Y.applyUpdate(live, base, "socket-base");
	let validationMirror: Y.Doc | null = null;
	if (spec.arm === "socket-validation-mirror") {
		validationMirror = new Y.Doc({ guid: `${manifest.bodyId}-validation` });
		Y.applyUpdate(validationMirror, base, "socket-validation-base");
	}
	tracker.mark("socket-base-loaded", true);
	const frameLimit = manifest.profile.name === "stress"
		? Math.min(2_000, manifest.updates.frames)
		: manifest.updates.frames;
	const sampleEvery = Math.max(1, Math.floor(frameLimit / 10));
	const latencies: number[] = [];
	let frames = 0;
	for (const update of readFrozenFrames(join(spec.traceDirectory, "updates.bin"))) {
		if (frames >= frameLimit) break;
		const started = performance.now();
		if (spec.arm === "socket-admission-current") {
			const error = bodyUpdateAdmissionError(live, update);
			if (error) throw new Error(`production socket admission rejected frame ${frames}: ${error}`);
			Y.applyUpdate(live, update, "socket-current");
		} else if (spec.arm === "socket-validation-mirror") {
			Y.applyUpdate(validationMirror!, update, "socket-validation-mirror");
			const semanticError = validateFrontmatterSemanticRoots(validationMirror!);
			if (semanticError) throw new Error(`validation mirror rejected frame ${frames}: ${semanticError}`);
			const contentBytes = canonicalMarkdownBytes(validationMirror!.getText("body").toString());
			if (contentBytes.byteLength > MAX_CLIENT_MARKDOWN_BYTES) throw new Error("validation mirror crossed Markdown limit");
			Y.applyUpdate(live, update, "socket-mirror-live");
		} else if (spec.arm === "socket-apply-floor") {
			Y.applyUpdate(live, update, "socket-apply-floor");
		} else {
			throw new Error(`unknown socket arm ${spec.arm}`);
		}
		latencies.push(performance.now() - started);
		frames++;
		if (frames % sampleEvery === 0) tracker.mark(`socket-frame-${frames}`);
	}
	const text = live.getText("body").toString();
	const encodedBytes = Y.encodeStateAsUpdate(live).byteLength;
	const finalCensus = census(live);
	const result = tracker.finish({
		textSha256: sha256(text),
		textCodeUnits: text.length,
		encodedStateBytes: encodedBytes,
		census: finalCensus,
		counters: {
			frames,
			frameLimit,
			traceFrames: manifest.updates.frames,
			truncated: frames < manifest.updates.frames,
			...latencyCounters(latencies),
		},
	});
	live.destroy();
	validationMirror?.destroy();
	return result;
}

/** Runs each frozen wire frame through the real socket service and cache mirror. */
async function productionSocketMirrorArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const cache = new VaultDocumentCache(fixture.store, () => new Set([manifest.bodyId]), () => new Set());
		const head = fixture.store.documentHead(manifest.bodyId)!;
		const loaded = cache.load(manifest.bodyId, true, () => cache.admitBody(manifest.bodyId));
		const attachment: VaultSocketAttachment = {
			vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION, runtimeEpoch: "pathology-socket-runtime-0001",
			documentId: manifest.bodyId, kind: "body", documentEpoch: head.semanticEpoch,
			deviceId: ACTOR.deviceId, principalId: ACTOR.principalId,
			membershipRevision: ACTOR.membershipRevision, deviceCredentialRevision: ACTOR.deviceCredentialRevision,
			role: "member", policyVersion: 1, capabilityDigest: "pathology-socket-capability-0001",
			socketId: "pathology-socket-0001",
		};
		const closure: { value: { code: number; reason: string } | null } = { value: null };
		const socket: VaultSocketPort = {
			deserializeAttachment: () => attachment,
			serializeAttachment: () => {},
			send: () => {},
			close: (code = 1000, reason = "") => { closure.value = { code, reason }; },
		};
		let scheduledFlushes = 0;
		const service = new VaultSocketService({
			sockets: {
				sockets: () => [socket],
				createPair: () => { throw new Error("socket pair is outside the admission arm"); },
				accept: () => {},
				upgradeResponse: () => { throw new Error("socket upgrade is outside the admission arm"); },
			},
			cache,
			vaultId: () => VAULT_ID,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: attachment.runtimeEpoch,
			isActiveBody: () => true,
			currentRootEpoch: () => 1,
			currentBodyHead: () => ({ bodyId: manifest.bodyId, bodyEpoch: head.semanticEpoch,
				lifecycle: "active", generation: head.generation, contentHash: null, size: null,
				sequence: head.latestSequence }),
			currentSequence: () => fixture.store.currentSequence(),
			validateActor: () => true,
			principalPresence: () => null,
			scheduleFlush: () => { scheduledFlushes++; },
		});
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("production-socket-mirror-seeded", true);
		// The production mirror is the release gate, so it must replay the entire
		// frozen wire trace. Only the deliberately expensive historical/control arms
		// use a declared stress prefix.
		const frameLimit = manifest.updates.frames;
		const sampleEvery = Math.max(1, Math.floor(frameLimit / 10));
		const latencies: number[] = [];
		let frames = 0;
		for (const update of readFrozenFrames(join(spec.traceDirectory, "updates.bin"))) {
			if (frames >= frameLimit) break;
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			syncProtocol.writeUpdate(encoder, update);
			const frame = encoding.toUint8Array(encoder);
			const started = performance.now();
			await service.message(socket, frame.slice().buffer);
			latencies.push(performance.now() - started);
			if (closure.value) throw new Error(`production socket closed at frame ${frames}: ${closure.value.code} ${closure.value.reason}`);
			frames++;
			if (frames % sampleEvery === 0) tracker.mark(`production-socket-frame-${frames}`);
		}
		const validation = cache.get(manifest.bodyId)?.validationDoc;
		if (!validation) throw new Error("production validation mirror was evicted");
		const text = validation.getText("body").toString();
		if (frames !== manifest.updates.frames || sha256(text) !== manifest.final.textSha256) {
			throw new Error("production validation mirror diverged from the complete frozen wire trace");
		}
		const measured = tracker.finish({
			textSha256: sha256(text), textCodeUnits: text.length,
			encodedStateBytes: Y.encodeStateAsUpdate(validation).byteLength,
			census: census(validation),
			counters: { frames, frameLimit, traceFrames: manifest.updates.frames,
				truncated: frames < manifest.updates.frames, scheduledFlushes,
				pendingFrames: cache.pendingFor(manifest.bodyId).length, ...latencyCounters(latencies) },
		});
		const elapsedMsCeiling = manifest.profile.name === "stress" ? 180_000 : 20_000;
		const peakAdditionalRssBytesCeiling = manifest.profile.name === "stress"
			? 320 * 1024 * 1024
			: 96 * 1024 * 1024;
		const completeTracePassed = frames === manifest.updates.frames;
		const elapsedCeilingPassed = measured.elapsedMs <= elapsedMsCeiling;
		const peakAdditionalRssCeilingPassed = measured.peakAdditionalRssBytes <= peakAdditionalRssBytesCeiling;
		const result: LabMeasurement = {
			...measured,
			counters: { ...measured.counters, completeTracePassed,
				elapsedMsCeiling, elapsedCeilingPassed,
				peakAdditionalRssBytesCeiling, peakAdditionalRssCeilingPassed,
				allRegressionCeilingsPassed: completeTracePassed && elapsedCeilingPassed && peakAdditionalRssCeilingPassed },
		};
		cache.clear();
		if (!completeTracePassed || !elapsedCeilingPassed || !peakAdditionalRssCeilingPassed) {
			throw new Error(`production socket mirror ceiling crossed: frames ${frames}/${manifest.updates.frames}, elapsed ${measured.elapsedMs.toFixed(1)}/${elapsedMsCeiling}ms, peak RSS ${measured.peakAdditionalRssBytes}/${peakAdditionalRssBytesCeiling}`);
		}
		return result;
	} finally {
		closeStore(fixture);
	}
}

function checkpointArm(spec: ChildSpec): LabMeasurement {
	const fixture = openStore(spec.fixturePath);
	try {
		const manifest = readTraceManifest(spec.traceDirectory);
		const commits = spec.fixturePath
			? manifest.candidates.frames
			: populateStoreFromCandidates(spec.traceDirectory, fixture);
		let doc: Y.Doc | null = spec.arm === "checkpoint-live"
			? fixture.store.reconstructDocument(manifest.bodyId).doc
			: null;
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("checkpoint-store-populated", true);
		let checkpointChunks = 0;
		let checkpointRows = 0;
		let encodedBytes = 0;
		if (spec.arm === "checkpoint-current") {
			const checkpoint = fixture.store.writeCheckpoint(manifest.bodyId);
			checkpointChunks = checkpoint.chunks;
			checkpointRows = checkpoint.rowsWritten;
			tracker.mark("checkpoint-current-returned");
			encodedBytes = fixture.sqlite.sql.exec<{ bytes: number }>(
				`SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM vault_checkpoints
				 WHERE document_id = ? AND checkpoint_sequence = ?`,
				manifest.bodyId,
				checkpoint.checkpointSequence,
			).one().bytes;
		} else if (spec.arm === "checkpoint-live") {
			const head = fixture.store.documentHead(manifest.bodyId);
			if (!doc || !head) throw new Error("live checkpoint fixture has no body head");
			const checkpoint = fixture.store.writeCheckpointFromDocument(manifest.bodyId, doc, {
				throughSequence: head.latestSequence,
				generation: head.generation,
				semanticEpoch: head.semanticEpoch,
			});
			checkpointChunks = checkpoint.chunks;
			checkpointRows = checkpoint.rowsWritten;
			encodedBytes = checkpoint.totalBytes;
			tracker.mark("checkpoint-live-written");
		} else {
			throw new Error(`unknown checkpoint arm ${spec.arm}`);
		}
		if (doc) verifyFinalDocument(spec.traceDirectory, doc);
		const result = tracker.finish({
			textSha256: manifest.final.textSha256,
			textCodeUnits: manifest.final.textCodeUnits,
			encodedStateBytes: encodedBytes,
			census: doc ? census(doc) : manifest.final.census,
			counters: { commits, checkpointChunks, checkpointRows, queries: fixture.queries.count },
		});
		doc?.destroy();
		return result;
	} finally {
		closeStore(fixture);
	}
}

function reconstructionArm(spec: ChildSpec): LabMeasurement {
	const manifest = readTraceManifest(spec.traceDirectory);
	const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
	let doc: Y.Doc;
	let rowsRead = 0;
	let commits = 0;
	if (spec.arm === "reconstruct-current") {
		if (!spec.fixturePath) throw new Error("reconstruct-current requires a prepared SQLite fixture");
		const fixture = openStore(spec.fixturePath);
		try {
			const reconstructed = fixture.store.reconstructDocument(manifest.bodyId);
			doc = reconstructed.doc;
			rowsRead = reconstructed.rowsRead;
			commits = manifest.candidates.frames;
			tracker.mark("reconstruct-current-loaded");
		} finally {
			closeStore(fixture);
		}
	} else if (spec.arm === "reconstruct-self-contained") {
		doc = new Y.Doc({ guid: manifest.bodyId });
		Y.applyUpdate(doc, new Uint8Array(readFileSync(join(spec.traceDirectory, "base.update"))), "self-contained-base");
		for (const update of readFrozenFrames(join(spec.traceDirectory, "candidates.bin"))) {
			Y.applyUpdate(doc, update, "self-contained-update");
			commits++;
		}
		tracker.mark("reconstruct-self-contained-loaded");
	} else {
		throw new Error(`unknown reconstruction arm ${spec.arm}`);
	}
	const final = verifyFinalDocument(spec.traceDirectory, doc);
	const result = tracker.finish({
		textSha256: sha256(final.text),
		textCodeUnits: final.text.length,
		encodedStateBytes: final.encodedBytes,
		census: census(doc),
		counters: { commits, rowsRead },
	});
	doc.destroy();
	return result;
}

function pinRetentionArm(spec: ChildSpec): LabMeasurement {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("pin-store-seeded", true);
		const pinIds: string[] = [];
		const checkpoints = Math.min(10, Math.max(1, manifest.candidates.frames));
		const checkpointEvery = Math.max(1, Math.ceil(manifest.candidates.frames / checkpoints));
		let commits = 0;
		for (const update of readFrozenFrames(join(spec.traceDirectory, "candidates.bin"))) {
			fixture.store.commitUpdate({ documentId: manifest.bodyId, update, kind: "body" });
			commits++;
			if (commits % checkpointEvery === 0 || commits === manifest.candidates.frames) {
				const boundary = fixture.store.currentSequence();
				const ordinal = Math.ceil(commits / checkpointEvery);
				if (ordinal === 2 || ordinal === 5) {
					pinIds.push(fixture.store.createPin({
						kind: ordinal === 2 ? "bootstrap" : "capture",
						boundarySequence: boundary,
						pinId: `pathology-pin-${ordinal}`,
					}).pinId);
				}
				fixture.store.writeCheckpoint(manifest.bodyId, boundary);
			}
		}
		const storageStats = (): { bytes: number; logical: number; rows: number } => fixture.sqlite.sql.exec<{
			bytes: number; logical: number; rows: number;
		}>(`SELECT COALESCE(SUM(length(data)), 0) AS bytes,
			COUNT(DISTINCT checkpoint_sequence) AS logical, COUNT(*) AS rows
			FROM vault_checkpoints WHERE document_id = ?`, manifest.bodyId).one();
		const withPins = storageStats();
		tracker.mark("pin-retention-measured");
		for (const pinId of pinIds) fixture.store.releasePin(pinId);
		const latest = fixture.store.reconstructDocument(manifest.bodyId);
		const before = Y.encodeStateVector(latest.doc);
		latest.doc.transact(() => {
			const body = latest.doc.getText("body");
			body.insert(body.length, "x");
			body.delete(body.length - 1, 1);
		});
		const pruningUpdate = Y.encodeStateAsUpdate(latest.doc, before);
		latest.doc.destroy();
		fixture.store.commitUpdate({ documentId: manifest.bodyId, update: pruningUpdate, kind: "body" });
		fixture.store.writeCheckpoint(manifest.bodyId);
		const withoutPins = storageStats();
		tracker.mark("pins-released-and-pruned");
		return tracker.finish({
			counters: {
				commits,
				pins: pinIds.length,
				checkpointBytesWithPins: withPins.bytes,
				checkpointBytesAfterRelease: withoutPins.bytes,
				pinRetainedBytes: Math.max(0, withPins.bytes - withoutPins.bytes),
				logicalCheckpointsWithPins: withPins.logical,
				logicalCheckpointsAfterRelease: withoutPins.logical,
				checkpointRowsWithPins: withPins.rows,
				checkpointRowsAfterRelease: withoutPins.rows,
			},
		});
	} finally {
		closeStore(fixture);
	}
}

function rootChurnArm(spec: ChildSpec): LabMeasurement {
	const manifest = readTraceManifest(spec.traceDirectory);
	const profile: PathologyProfile = manifest.profile;
	const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
	let root: Y.Doc | null = new Y.Doc({ guid: "pathology-root" });
	root.clientID = 0x1a05_3001;
	const paths = root.getMap<string>("pathToId");
	const currentPaths = Array.from({ length: profile.activeRootEntries }, (_, index) => `note-${index}.md`);
	for (let index = 0; index < profile.activeRootEntries; index++) paths.set(currentPaths[index]!, `body-${index}`);
	for (let operation = 0; operation < profile.rootOperations; operation++) {
		const body = operation % profile.activeRootEntries;
		paths.delete(currentPaths[body]!);
		const nextPath = `note-${body}-${Math.floor(operation / profile.activeRootEntries) + 1}.md`;
		paths.set(nextPath, `body-${body}`);
		currentPaths[body] = nextPath;
		if ((operation + 1) % Math.max(1, Math.floor(profile.rootOperations / 10)) === 0) {
			tracker.mark(`root-operation-${operation + 1}`);
		}
	}
	tracker.mark("root-history-built", true);
	const history = census(root);
	if (spec.arm === "root-semantic-reset") {
		const entries = [...paths.entries()];
		const fresh = new Y.Doc({ guid: root.guid });
		fresh.clientID = 0x1a05_3002;
		fresh.transact(() => {
			for (const [path, bodyId] of entries) fresh.getMap<string>("pathToId").set(path, bodyId);
		});
		tracker.mark("root-both-documents");
		root.destroy();
		root = fresh;
		tracker.mark("root-old-released", true);
	} else if (spec.arm !== "root-current") {
		throw new Error(`unknown root arm ${spec.arm}`);
	}
	const encodedBytes = Y.encodeStateAsUpdate(root).byteLength;
	const finalCensus = census(root);
	const result = tracker.finish({
		encodedStateBytes: encodedBytes,
		census: finalCensus,
		counters: {
			activeEntries: root.getMap("pathToId").size,
			rootOperations: profile.rootOperations,
			historyStructs: history.structs,
			structsRemoved: history.structs - finalCensus.structs,
		},
	});
	root.destroy();
	return result;
}

/** Builds pathological root history, then resets it through the production CAS/checkpoint runtime. */
async function productionRootSemanticResetArm(spec: ChildSpec): Promise<LabMeasurement> {
	const fixture = openStore();
	try {
		seedStore(spec.traceDirectory, fixture);
		const manifest = readTraceManifest(spec.traceDirectory);
		const root = fixture.store.reconstructDocument("root").doc;
		const before = Y.encodeStateVector(root);
		const paths = root.getMap<string>("pathToId");
		const currentPaths = Array.from({ length: manifest.profile.activeRootEntries }, (_, index) => `note-${index}.md`);
		root.transact(() => {
			for (let index = 0; index < currentPaths.length; index++) paths.set(currentPaths[index]!, `root-body-${index}`);
			for (let operation = 0; operation < manifest.profile.rootOperations; operation++) {
				const body = operation % currentPaths.length;
				paths.delete(currentPaths[body]!);
				const nextPath = `note-${body}-${Math.floor(operation / currentPaths.length) + 1}.md`;
				paths.set(nextPath, `root-body-${body}`);
				currentPaths[body] = nextPath;
			}
			root.getMap("unknown-root-history").set("discard-me", true);
			root.getMap("__yaosLifecycle").set("retired-lifecycle-marker", true);
			root.getMap("__yaosLifecyclePublicationProof").set("retired-publication-proof", true);
		}, "production-root-pathology");
		for (let index = 0; index < currentPaths.length; index++) {
			const bodyId = `root-body-${index}`;
			const body = new Y.Doc({ guid: bodyId });
			body.getText("body").insert(0, `catalog seed ${index}\n`);
			fixture.store.commitUpdate({ documentId: bodyId, update: Y.encodeStateAsUpdate(body), kind: "body" });
			body.destroy();
		}
		fixture.store.commitUpdate({
			documentId: "root",
			update: Y.encodeStateAsUpdate(root, before),
			kind: "root",
			// Production root compaction deliberately ignores resident Yjs maps and
			// rebuilds from SQL catalog authority. Seed both sides of that contract:
			// the pathological CRDT history above is the cost under test, while these
			// final heads are the semantic values which must survive the reset.
			catalog: currentPaths.map((path, index) => ({
				bodyId: `root-body-${index}`,
				fileId: `root-body-${index}`,
				path,
				previousPath: null,
				lifecycle: "active" as const,
				bodyGeneration: 1,
			})),
		});
		root.destroy();

		const canvasId = "root-authority-canvas";
		const canvasPath = "Authority.canvas";
		const canvas = new Y.Doc({ guid: canvasId });
		initializeCanvasDocument(canvas);
		const canvasCommit = fixture.store.commitUpdate({
			documentId: canvasId,
			update: Y.encodeStateAsUpdate(canvas),
			kind: "semantic",
		});
		canvas.destroy();
		const canvasRoot = fixture.store.reconstructDocument("root");
		const canvasRootVector = Y.encodeStateVector(canvasRoot.doc);
		canvasRoot.doc.getMap("pathToSemantic").set(canvasPath, {
			documentId: canvasId, kind: "canvas", format: "json-canvas", formatVersion: 1,
		});
		fixture.store.commitUpdate({
			documentId: "root",
			update: Y.encodeStateAsUpdate(canvasRoot.doc, canvasRootVector),
			kind: "semantic-create",
			semanticCatalog: {
				documentId: canvasId, fileId: canvasId, kind: "canvas", format: "json-canvas",
				formatVersion: 1, path: canvasPath, previousPath: null, lifecycle: "active",
				documentGeneration: canvasCommit.generation, contentHash: "c".repeat(64), size: 17,
			},
		});
		canvasRoot.doc.destroy();

		const attachmentHash = "a".repeat(64);
		const tombstoneHash = "b".repeat(64);
		const attachmentOperationId = "root-authority-attachment-operation";
		const attachmentRoot = fixture.store.reconstructDocument("root");
		const attachmentRootVector = Y.encodeStateVector(attachmentRoot.doc);
		attachmentRoot.doc.getMap("pathToBlob").set("authority.bin", {
			hash: attachmentHash, size: 4, revision: attachmentOperationId,
		});
		attachmentRoot.doc.getMap("blobMeta").set(attachmentHash, {
			size: 4, mime: "application/octet-stream", createdAt: 700,
		});
		attachmentRoot.doc.getMap("blobTombstones").set("retired.bin", {
			deletedAt: 700, previousHash: tombstoneHash, revision: attachmentOperationId,
		});
		const attachmentHead = fixture.store.documentHead("root")!;
		fixture.store.commitRootAttachments(
			Y.encodeStateAsUpdate(attachmentRoot.doc, attachmentRootVector),
			[
				{ operationId: attachmentOperationId, path: "authority.bin", contentHash: attachmentHash,
					size: 4, mime: "application/octet-stream", lifecycle: "active" },
				{ operationId: attachmentOperationId, path: "retired.bin", contentHash: tombstoneHash,
					size: 8, mime: null, lifecycle: "deleted" },
			],
			{ operationId: attachmentOperationId, requestDigest: "d".repeat(64), rootEpoch: attachmentHead.semanticEpoch },
			attachmentHead,
			700,
		);
		attachmentRoot.doc.destroy();

		const seedLifecycle = (suffix: string, publish: boolean) => {
			const bodyId = `root-proof-body-${suffix}`;
			const operationId = `root-proof-operation-${suffix}`;
			const path = `proof-${suffix}.md`;
			const body = new Y.Doc({ guid: bodyId });
			body.getText("body").insert(0, `${suffix} proof body\n`);
			const bodyCommit = fixture.store.commitUpdate({
				documentId: bodyId, update: Y.encodeStateAsUpdate(body), kind: "body",
			});
			body.destroy();
			const lifecycleRoot = fixture.store.reconstructDocument("root");
			const lifecycleVector = Y.encodeStateVector(lifecycleRoot.doc);
			lifecycleRoot.doc.getMap("pathToId").set(path, bodyId);
			lifecycleRoot.doc.getMap("__yaosLifecycle").set(operationId, true);
			const lifecycleCommit = fixture.store.commitRootLifecycle({
				rootUpdate: Y.encodeStateAsUpdate(lifecycleRoot.doc, lifecycleVector),
				kind: "rename",
				catalog: { bodyId, fileId: bodyId, path, previousPath: `old-${suffix}.md`,
					lifecycle: "active", bodyGeneration: bodyCommit.generation },
				lifecycleReceipt: { operationId, kind: "rename", bodyId,
					bodyEpoch: bodyCommit.semanticEpoch, fileId: bodyId, candidateId: null,
					candidateDigest: null, sourcePath: `old-${suffix}.md`, resultPath: path,
					resultLifecycle: "active", durableGeneration: bodyCommit.generation,
					vaultGeneration: VAULT_GENERATION, runtimeEpoch: "pathology-root-runtime" },
			});
			lifecycleRoot.doc.destroy();
			if (publish) {
				const proofRoot = fixture.store.reconstructDocument("root");
				const proofVector = Y.encodeStateVector(proofRoot.doc);
				proofRoot.doc.getMap("__yaosLifecyclePublicationProof").set(operationId, true);
				fixture.store.commitUpdate({
					documentId: "root", kind: "root",
					update: Y.encodeStateAsUpdate(proofRoot.doc, proofVector),
					rootPublications: [{ operationId, lifecycleSequence: lifecycleCommit.vaultSequence,
						rootEpoch: lifecycleCommit.semanticEpoch, vaultGeneration: VAULT_GENERATION,
						runtimeEpoch: "pathology-root-runtime" }],
				});
				proofRoot.doc.destroy();
			}
			return { bodyId, operationId, path, lifecycleSequence: lifecycleCommit.vaultSequence };
		};
		const unpublishedProof = seedLifecycle("unpublished", false);
		const publishedProof = seedLifecycle("published", true);
		const cache = new VaultDocumentCache(fixture.store, () => new Set(), () => new Set());
		const loaded = cache.load("root", false, () => true, "root");
		const history = census(loaded.doc);
		const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
		tracker.mark("production-root-history-loaded", true);
		const forceCompaction: Readonly<SemanticCompactionThresholds> = {
			softEncodedStateBytes: 1, hardEncodedStateBytes: Number.MAX_SAFE_INTEGER,
			softStructs: 2, hardStructs: Number.MAX_SAFE_INTEGER,
			softDeletedStructs: 1, minimumRatioStructs: 1,
			softDeletedRatio: 0.01, hardDeletedRatio: 1,
			softAmplification: 1.01, hardAmplification: Number.MAX_SAFE_INTEGER,
			minimumAmplificationBytes: 1, minimumProjectedReduction: 0.10,
			softCooldownMs: 0, rearmGrowthFactor: 1,
			hardLatencyViolationStreak: Number.MAX_SAFE_INTEGER,
		};
		let fencedSockets = 0;
		const runtime = new SemanticCompactionRuntime({
			store: fixture.store, cache,
			fenceSockets: () => { fencedSockets++; return 1; },
			thresholds: () => forceCompaction,
		});
		const outcome = await runtime.measureAndMaybeCompact("root");
		if (outcome.status !== "compacted") throw new Error(`production root compaction did not run: ${outcome.status}`);
		tracker.mark("production-root-semantic-reset", true);
		const fresh = cache.get("root")!;
		const assertFreshAuthority = (document: Y.Doc) => {
			for (let index = 0; index < currentPaths.length; index++) {
				if (document.getMap<string>("pathToId").get(currentPaths[index]!) !== `root-body-${index}`) {
					throw new Error(`production root reset lost catalog entry ${index}`);
				}
			}
			for (const proof of [unpublishedProof, publishedProof]) {
				if (document.getMap<string>("pathToId").get(proof.path) !== proof.bodyId) {
					throw new Error(`production root reset lost lifecycle authority ${proof.operationId}`);
				}
			}
			const semantic = document.getMap<{ documentId: string; kind: string; format: string; formatVersion: number }>("pathToSemantic").get(canvasPath);
			if (semantic?.documentId !== canvasId || semantic.kind !== "canvas"
				|| semantic.format !== "json-canvas" || semantic.formatVersion !== 1) {
				throw new Error("production root reset lost Canvas SQL authority");
			}
			const blob = document.getMap<{ hash: string; size: number; revision: string }>("pathToBlob").get("authority.bin");
			if (blob?.hash !== attachmentHash || blob.size !== 4 || blob.revision !== attachmentOperationId) {
				throw new Error("production root reset lost active attachment authority");
			}
			const tombstone = document.getMap<{ deletedAt: number; previousHash: string | null; revision: string }>("blobTombstones").get("retired.bin");
			if (tombstone?.deletedAt !== 700 || tombstone.previousHash !== tombstoneHash
				|| tombstone.revision !== attachmentOperationId) {
				throw new Error("production root reset lost attachment tombstone authority");
			}
			const metadata = document.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta").get(attachmentHash);
			if (metadata?.size !== 4 || metadata.mime !== "application/octet-stream" || metadata.createdAt !== 700) {
				throw new Error("production root reset lost blob metadata authority");
			}
			const roots = [...document.share.keys()].sort();
			if (JSON.stringify(roots) !== JSON.stringify([...ROOT_SEMANTIC_ROOTS].sort())) {
				throw new Error(`production root reset retained non-authoritative maps: ${roots.join(",")}`);
			}
		};
		assertFreshAuthority(fresh.doc);
		for (const proof of [unpublishedProof, publishedProof]) {
			const publication = fixture.store.lifecyclePublication(proof.operationId);
			if (!publication || publication.lifecycleSequence !== proof.lifecycleSequence
				|| publication.rootSequence !== outcome.result.vaultSequence
				|| publication.rootEpoch !== outcome.result.semanticEpoch) {
				throw new Error(`production root reset failed to migrate proof ${proof.operationId}`);
			}
		}
		const recovered = fixture.store.reconstructDocument("root");
		assertFreshAuthority(recovered.doc);
		const durableEquivalent = sha256(Y.encodeStateAsUpdate(recovered.doc)) === sha256(Y.encodeStateAsUpdate(fresh.doc));
		recovered.doc.destroy();
		if (!durableEquivalent) throw new Error("production root reset durable reconstruction diverged");
		const finalCensus = census(fresh.doc);
		const result = tracker.finish({
			encodedStateBytes: Y.encodeStateAsUpdate(fresh.doc).byteLength,
			census: finalCensus,
			counters: { activeEntries: fresh.doc.getMap("pathToId").size,
				rootOperations: manifest.profile.rootOperations, historyStructs: history.structs,
				structsRemoved: history.structs - finalCensus.structs,
				previousEpoch: outcome.result.previousSemanticEpoch,
				currentEpoch: outcome.result.semanticEpoch,
				fencedSockets, sqlCanvasPreserved: true, sqlAttachmentPreserved: true,
				sqlTombstonePreserved: true, markerMapsRemoved: true, proofsMigrated: 2,
				durableRootEquivalent: durableEquivalent },
		});
		const semanticEntries = ROOT_SEMANTIC_ROOTS.reduce((count, name) => count + fresh.doc.getMap(name).size, 0);
		const structCeiling = semanticEntries + 8;
		const elapsedMsCeiling = 10_000;
		const structCeilingPassed = finalCensus.structs <= structCeiling;
		const elapsedCeilingPassed = result.elapsedMs <= elapsedMsCeiling;
		const measured = { ...result, counters: { ...result.counters,
			structCeiling, structCeilingPassed, elapsedMsCeiling, elapsedCeilingPassed,
			allRegressionCeilingsPassed: structCeilingPassed && elapsedCeilingPassed } };
		if (!structCeilingPassed || !elapsedCeilingPassed) {
			throw new Error(`production root regression ceiling failed: structs=${finalCensus.structs}/${structCeiling}, elapsed=${result.elapsedMs}/${elapsedMsCeiling}`);
		}
		cache.clear();
		return measured;
	} finally {
		closeStore(fixture);
	}
}

function epochRiskArm(spec: ChildSpec): LabMeasurement {
	const tracker = new MemoryTracker(spec.arm, spec.traceDirectory);
	const manifest = readTraceManifest(spec.traceDirectory);
	let oldClient: Y.Doc | null = documentFromFrozenTrace(spec.traceDirectory, tracker);
	const canonical = oldClient.getText("body").toString();
	const freshServer = new Y.Doc({ guid: manifest.bodyId });
	freshServer.clientID = 0x1a05_e001;
	freshServer.getText("body").insert(0, canonical);
	const before = Y.encodeStateVector(oldClient);
	oldClient.getText("body").insert(oldClient.getText("body").length, "\noffline edit survives\n");
	const staleIncrement = Y.encodeStateAsUpdate(oldClient, before);
	const staleFullState = Y.encodeStateAsUpdate(oldClient);
	tracker.mark("epoch-old-and-fresh");
	Y.applyUpdate(freshServer, staleIncrement, "stale-increment");
	const pendingAfterIncrement = census(freshServer).pendingStructBytes;
	Y.applyUpdate(freshServer, staleFullState, "stale-full-state");
	tracker.mark("epoch-stale-state-applied");
	const mergedText = freshServer.getText("body").toString();
	const staleHistoryCrossedEpoch = census(freshServer).clientBuckets > 1;
	const result = tracker.finish({
		textSha256: sha256(mergedText),
		textCodeUnits: mergedText.length,
		encodedStateBytes: Y.encodeStateAsUpdate(freshServer).byteLength,
		census: census(freshServer),
		counters: {
			pendingAfterIncrement,
			staleHistoryCrossedEpoch,
			offlineTextPresent: mergedText.includes("offline edit survives"),
			bodyEpochFenceImplemented: false,
		},
	});
	oldClient.destroy();
	oldClient = null;
	freshServer.destroy();
	return result;
}

async function run(spec: ChildSpec): Promise<LabMeasurement> {
	validateFrozenTrace(spec.traceDirectory);
	if (["body-current", "body-rematerialize", "body-semantic-reset"].includes(spec.arm)) return bodyArm(spec);
	if (["server-current", "server-semantic-compaction"].includes(spec.arm)) return serverCurrentArm(spec);
	if (spec.arm === "server-semantic-compaction-soak") return serverSemanticCompactionSoakArm(spec);
	if (spec.arm === "server-validated-once") return serverValidatedOnceArm(spec);
	if (["server-persistent-exact", "server-persistent-periodic"].includes(spec.arm)) {
		return serverPersistentValidationArm(spec);
	}
	if (["socket-admission-current", "socket-validation-mirror", "socket-apply-floor"].includes(spec.arm)) {
		return socketAdmissionArm(spec);
	}
	if (spec.arm === "socket-production-mirror") return productionSocketMirrorArm(spec);
	if (["checkpoint-current", "checkpoint-live"].includes(spec.arm)) return checkpointArm(spec);
	if (["reconstruct-current", "reconstruct-self-contained"].includes(spec.arm)) return reconstructionArm(spec);
	if (spec.arm === "pin-retention") return pinRetentionArm(spec);
	if (["root-current", "root-semantic-reset"].includes(spec.arm)) return rootChurnArm(spec);
	if (spec.arm === "root-production-semantic-reset") return productionRootSemanticResetArm(spec);
	if (spec.arm === "epoch-current-risk") return epochRiskArm(spec);
	throw new Error(`unknown pathology lab arm: ${spec.arm}`);
}

const encoded = process.argv[2];
if (!encoded) throw new Error("pathology child requires a JSON spec argument");
const parsed = JSON.parse(encoded) as ChildSpec;
const spec: ChildSpec = { ...parsed, traceDirectory: resolve(parsed.traceDirectory) };
const measurement = await run(spec);
process.stdout.write(`${JSON.stringify(measurement)}\n`);
