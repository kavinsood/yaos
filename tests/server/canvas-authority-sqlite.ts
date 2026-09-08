import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { suite } from "../harness.ts";

async function availablePort(): Promise<number> {
	const server = createServer();
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to allocate test port");
	const closed = once(server, "close");
	server.close();
	await closed;
	return address.port;
}

const workerSource = String.raw`
import * as Y from "yjs";
import { VaultStore } from "./server/src/vaultStore.ts";

function update(doc, mutate) {
  const vector = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, vector);
}

const actor = { vaultId: "canvas-authority-vault", vaultGeneration: "canvas-authority-generation",
  principalId: "principal-owner", membershipRevision: 1, deviceId: "device-owner",
  deviceCredentialRevision: 1, role: "owner", policyVersion: 1, capabilityDigest: "owner-digest" };
const semanticRef = (documentId) => ({ documentId, kind: "canvas", format: "json-canvas", formatVersion: 1 });

export class CanvasAuthorityCycle {
  constructor(state) { this.state = state; }

  async fetch() {
    const store = new VaultStore(this.state.storage);
    const root = new Y.Doc({ guid: "root" });
    root.getMap("sys").set("schemaVersion", 8);
    root.getMap("sys").set("protocolVersion", 5);
    store.provisionVault("canvas-authority-vault", "canvas-authority-generation", Y.encodeStateAsUpdate(root), 1);
    root.destroy();
    store.installAuthorityFence({ changeId: "canvas-authority-bootstrap", vaultId: actor.vaultId,
      vaultGeneration: actor.vaultGeneration, subjectDigest: "canvas-authority-bootstrap-digest", subjects: [
        { principalId: actor.principalId, role: actor.role, state: "active", membershipRevision: actor.membershipRevision,
          policyVersion: actor.policyVersion, capabilityDigest: actor.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
        { deviceId: actor.deviceId, principalId: actor.principalId, state: "active",
          credentialRevision: actor.deviceCredentialRevision },
      ] });

    const attachmentHash = "a".repeat(64);
    const attachmentOperationId = "canvas-attachment-source";
    const attachmentRoot = store.reconstructDocument("root").doc;
    const attachmentUpdate = update(attachmentRoot, () => {
      attachmentRoot.getMap("pathToBlob").set("Board.canvas", {
        hash: attachmentHash, size: 17, revision: attachmentOperationId,
      });
    });
    const attachmentCommit = store.commitRootAttachments(attachmentUpdate, [{
      operationId: attachmentOperationId, path: "Board.canvas", contentHash: attachmentHash,
      size: 17, mime: "application/json", lifecycle: "active",
    }], { operationId: attachmentOperationId, requestDigest: "b".repeat(64), rootEpoch: 1 },
	  store.documentHead("root"), 2);
    attachmentRoot.destroy();

    const canvas = new Y.Doc({ guid: "canvas-document" });
    canvas.getMap("canvasMeta").set("format", "yaos-json-canvas");
    canvas.getMap("canvasMeta").set("representationVersion", 1);
    canvas.getMap("canvasMeta").set("jsonCanvasVersion", "1.0");
    canvas.getMap("canvasMeta").set("enrolled", true);
    for (const name of ["rootFields", "nodes", "nodeOrder", "nodeTombstones", "edges", "edgeOrder", "edgeTombstones", "resolvedConflicts"]) canvas.getMap(name);
    const semanticUpdate = Y.encodeStateAsUpdate(canvas);
    canvas.destroy();
    const contentHash = "c".repeat(64);
    const transitionRoot = store.reconstructDocument("root").doc;
    const promotionRootUpdate = update(transitionRoot, () => {
      transitionRoot.getMap("pathToBlob").delete("Board.canvas");
      transitionRoot.getMap("pathToSemantic").set("Board.canvas", semanticRef("canvas-document"));
    });
    transitionRoot.destroy();
    const promotionInput = {
      operationId: "canvas-promotion", requestDigest: "d".repeat(64), path: "Board.canvas",
      documentId: "canvas-document", sourceRevision: attachmentOperationId, contentHash, size: 2,
      rollbackBlobHash: attachmentHash, rollbackBlobSize: 17, semanticUpdate,
	  bodyEpoch: 1, rootEpoch: 1,
      rootUpdate: promotionRootUpdate, expectedRootGeneration: attachmentCommit.generation,
      runtimeEpoch: "canvas-runtime", rollbackRetainedUntil: 10000, actor, now: 3,
    };
	const staleActor = { ...actor, membershipRevision: actor.membershipRevision + 1 };
	let staleActorPromotionRejected = false;
	try {
	  store.commitSemanticPromotion({ ...promotionInput, operationId: "stale-actor-promotion",
		requestDigest: "8".repeat(64), actor: staleActor });
	} catch (error) {
	  staleActorPromotionRejected = error instanceof Error && error.message === "authority_superseded";
	}
    const promotion = store.commitSemanticPromotion(promotionInput);
    const promotionReplay = store.commitSemanticPromotion(promotionInput);
	const lifecycleRoot = store.reconstructDocument("root");
	const lifecycleUpdate = update(lifecycleRoot.doc, () => lifecycleRoot.doc.getMap("sys").set("canvasReceipt", 1));
	const lifecycleHead = store.semanticHeadAt(store.currentSequence(), "canvas-document");
	store.commitUpdate({ documentId: "root", update: lifecycleUpdate, kind: "semantic-rename",
	  expectedHead: store.documentHead("root"), expectedSemanticHead: lifecycleHead,
	  semanticCatalog: { documentId: "canvas-document", fileId: "canvas-document", kind: "canvas",
		format: "json-canvas", formatVersion: 1, path: "Board.canvas", previousPath: "Board.canvas",
		lifecycle: "active", documentGeneration: 1, contentHash, size: 2 },
	  semanticLifecycleReceipt: { operationId: "canvas-lifecycle", requestDigest: "9".repeat(64),
		documentId: "canvas-document", fileId: "canvas-document", kind: "rename", resultPath: "Board.canvas",
		resultLifecycle: "active", durableGeneration: 1, bodyEpoch: 1, rootEpoch: 1,
		vaultGeneration: "canvas-authority-generation", runtimeEpoch: "canvas-runtime" },
	  actorAttributions: [{ actor, operationId: "canvas-lifecycle", requestDigest: "9".repeat(64) }], now: 3 });
	lifecycleRoot.doc.destroy();
	const lifecycleReceipt = store.semanticLifecycleReceipt("canvas-lifecycle");
	const staleCanvas = store.reconstructDocument("canvas-document").doc;
	const staleCanvasUpdate = update(staleCanvas, () => staleCanvas.getMap("rootFields").set("casProbe", true));
	staleCanvas.destroy();
	let semanticCatalogCasRejected = false;
	try {
	  store.commitUpdate({ documentId: "canvas-document", update: staleCanvasUpdate, kind: "semantic",
		expectedHead: store.documentHead("canvas-document"), expectedSemanticHead: lifecycleHead,
		actorAttributions: [{ actor, operationId: "stale-semantic-cas", requestDigest: "7".repeat(64) }] });
	} catch (error) {
	  semanticCatalogCasRejected = error instanceof Error && error.message === "semantic_catalog_head_changed";
	}
	const receiptHead = store.documentHead("canvas-document");
	const receiptSemanticHead = store.semanticHeadAt(store.currentSequence(), "canvas-document");
	let staleActorReceiptRejected = false;
	try {
	  store.recordSemanticCandidateReceipt({ documentId: "canvas-document", clientId: staleActor.deviceId,
		candidateId: "stale-actor-receipt", candidateDigest: "6".repeat(64), bodyEpoch: 1,
		durableGeneration: receiptHead.generation, vaultSequence: receiptHead.latestSequence,
		vaultGeneration: actor.vaultGeneration, runtimeEpoch: "canvas-runtime", contentHash, size: 2 },
		staleActor, receiptHead, receiptSemanticHead, 3);
	} catch (error) {
	  staleActorReceiptRejected = error instanceof Error && error.message === "authority_superseded";
	}

    const staleHash = "e".repeat(64);
    const staleOperationId = "stale-source";
    const staleRoot = store.reconstructDocument("root").doc;
    const staleAttachmentUpdate = update(staleRoot, () => staleRoot.getMap("pathToBlob").set("Stale.canvas", {
      hash: staleHash, size: 4, revision: staleOperationId,
    }));
    const staleAttachmentCommit = store.commitRootAttachments(staleAttachmentUpdate, [{
      operationId: staleOperationId, path: "Stale.canvas", contentHash: staleHash,
      size: 4, mime: "application/json", lifecycle: "active",
    }], { operationId: staleOperationId, requestDigest: "f".repeat(64), rootEpoch: 1 },
	  store.documentHead("root"), 4);
    const stalePromotionUpdate = update(staleRoot, () => {
      staleRoot.getMap("pathToBlob").delete("Stale.canvas");
      staleRoot.getMap("pathToSemantic").set("Stale.canvas", semanticRef("stale-document"));
    });
    staleRoot.destroy();
    const unrelatedRoot = store.reconstructDocument("root").doc;
    const unrelatedUpdate = update(unrelatedRoot, () => unrelatedRoot.getMap("sys").set("race", 1));
    store.commitUpdate({ documentId: "root", update: unrelatedUpdate, kind: "root" });
    unrelatedRoot.destroy();
    let stalePromotionRejected = false;
    try {
      store.commitSemanticPromotion({ ...promotionInput, operationId: "stale-promotion",
        requestDigest: "1".repeat(64), path: "Stale.canvas", documentId: "stale-document",
        sourceRevision: staleOperationId, rollbackBlobHash: staleHash, rollbackBlobSize: 4,
        rootUpdate: stalePromotionUpdate, expectedRootGeneration: staleAttachmentCommit.generation });
    } catch (error) {
      stalePromotionRejected = error instanceof Error && error.message === "semantic_root_head_changed";
    }

    const staleDemotionRoot = store.reconstructDocument("root").doc;
    const staleDemotionGeneration = store.documentHead("root").generation;
	const semanticHeadBeforeDemotion = store.semanticHeadAt(store.currentSequence(), "canvas-document");
    const staleDemotionUpdate = update(staleDemotionRoot, () => {
      staleDemotionRoot.getMap("pathToSemantic").delete("Board.canvas");
      staleDemotionRoot.getMap("pathToBlob").set("Board.canvas", {
        hash: contentHash, size: 2, revision: "stale-demotion",
      });
    });
    staleDemotionRoot.destroy();
	let staleActorDemotionRejected = false;
	try {
	  store.commitSemanticDemotion({ operationId: "stale-actor-demotion", requestDigest: "5".repeat(64),
		path: "Board.canvas", documentId: "canvas-document", sourceRevision: "1:" + contentHash,
		expectedDocumentGeneration: 1, contentHash, size: 2, mime: "application/json",
		bodyEpoch: 1, rootEpoch: 1, expectedSemanticHead: semanticHeadBeforeDemotion,
		rootUpdate: staleDemotionUpdate, expectedRootGeneration: staleDemotionGeneration,
		runtimeEpoch: "canvas-runtime", actor: staleActor, now: 5 });
	} catch (error) {
	  staleActorDemotionRejected = error instanceof Error && error.message === "authority_superseded";
	}
    const secondUnrelatedRoot = store.reconstructDocument("root").doc;
    const secondUnrelatedUpdate = update(secondUnrelatedRoot, () => secondUnrelatedRoot.getMap("sys").set("race", 2));
    store.commitUpdate({ documentId: "root", update: secondUnrelatedUpdate, kind: "root" });
    secondUnrelatedRoot.destroy();
    let staleDemotionRejected = false;
    try {
      store.commitSemanticDemotion({ operationId: "stale-demotion", requestDigest: "2".repeat(64),
        path: "Board.canvas", documentId: "canvas-document", sourceRevision: "1:" + contentHash,
        expectedDocumentGeneration: 1, contentHash, size: 2, mime: "application/json",
		bodyEpoch: 1, rootEpoch: 1,
		expectedSemanticHead: semanticHeadBeforeDemotion,
        rootUpdate: staleDemotionUpdate, expectedRootGeneration: staleDemotionGeneration,
        runtimeEpoch: "canvas-runtime", actor, now: 5 });
    } catch (error) {
      staleDemotionRejected = error instanceof Error && error.message === "semantic_root_head_changed";
    }

    const demotionRoot = store.reconstructDocument("root").doc;
    const demotionGeneration = store.documentHead("root").generation;
    const demotionUpdate = update(demotionRoot, () => {
      demotionRoot.getMap("pathToSemantic").delete("Board.canvas");
      demotionRoot.getMap("pathToBlob").set("Board.canvas", {
        hash: contentHash, size: 2, revision: "canvas-demotion",
      });
    });
    demotionRoot.destroy();
    const demotionInput = { operationId: "canvas-demotion", requestDigest: "3".repeat(64),
      path: "Board.canvas", documentId: "canvas-document", sourceRevision: "1:" + contentHash,
      expectedDocumentGeneration: 1, contentHash, size: 2, mime: "application/json",
	  bodyEpoch: 1, rootEpoch: 1,
	  expectedSemanticHead: semanticHeadBeforeDemotion,
      rootUpdate: demotionUpdate, expectedRootGeneration: demotionGeneration,
      runtimeEpoch: "canvas-runtime", actor, now: 6 };
    const demotion = store.commitSemanticDemotion(demotionInput);
    const demotionReplay = store.commitSemanticDemotion(demotionInput);
    const finalRoot = store.reconstructDocument("root").doc;
    const exclusive = !finalRoot.getMap("pathToSemantic").has("Board.canvas")
      && finalRoot.getMap("pathToBlob").get("Board.canvas")?.hash === contentHash;
    finalRoot.destroy();

    return Response.json({
      promotionReplay: promotion.rootSequence === promotionReplay.rootSequence,
	  staleActorPromotionRejected,
	  staleActorDemotionRejected,
	  staleActorReceiptRejected: staleActorReceiptRejected
		&& store.semanticCandidateReceipt("canvas-document", staleActor.deviceId, "stale-actor-receipt") === null,
	  semanticCatalogCasRejected,
	  authorityEpochs: promotion.bodyEpoch === 1 && promotion.rootEpoch === 1
		&& promotionReplay.bodyEpoch === 1 && demotion.bodyEpoch === 1 && demotion.rootEpoch === 1
		&& store.semanticAuthorityReceipt("canvas-demotion")?.rootEpoch === 1,
	  lifecycleEpochs: lifecycleReceipt?.bodyEpoch === 1 && lifecycleReceipt.rootEpoch === 1,
      stalePromotionRejected,
      stalePromotionUncommitted: store.documentHead("stale-document") === null
        && store.semanticAuthorityReceipt("stale-promotion") === null,
      staleDemotionRejected,
      staleDemotionUncommitted: store.semanticAuthorityReceipt("stale-demotion") === null
        && store.semanticHeadAt(store.currentSequence(), "canvas-document")?.lifecycle === "tombstoned",
      demotionReplay: demotion.rootSequence === demotionReplay.rootSequence,
      exclusive,
      rollbackRetained: store.countRetainedSemanticRollbackBlobs(7) === 1,
    });
  }
}

export default { fetch(request, env) {
  if (new URL(request.url).pathname !== "/__cycle") return new Response("not found", { status: 404 });
  return env.CYCLE.get(env.CYCLE.idFromName("cycle")).fetch(request);
} };
`;

const s = suite("canvas-authority-sqlite");

s.test("promotion and demotion are atomic, replay-safe, and root-generation fenced on real SQLite", async () => {
	const temp = await mkdtemp(join(tmpdir(), "yaos-canvas-authority-"));
	const outfile = join(temp, "worker.mjs");
	const configPath = join(temp, "wrangler.jsonc");
	let child: ChildProcessWithoutNullStreams | null = null;
	let stderr = "";
	try {
		await build({
			alias: { yjs: join(process.cwd(), "node_modules/yjs/dist/yjs.mjs") },
			stdin: { contents: workerSource, resolveDir: process.cwd(), sourcefile: "canvas-authority-worker.ts", loader: "ts" },
			outfile, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
			external: ["cloudflare:workers"],
		});
		await writeFile(configPath, JSON.stringify({
			name: "yaos-canvas-authority", main: "./worker.mjs", compatibility_date: "2026-03-02",
			durable_objects: { bindings: [{ name: "CYCLE", class_name: "CanvasAuthorityCycle" }] },
			migrations: [{ tag: "v1", new_sqlite_classes: ["CanvasAuthorityCycle"] }],
		}), "utf8");
		const port = await availablePort();
		child = spawn(join(process.cwd(), "server/node_modules/.bin/wrangler"), ["dev", "--config", configPath,
			"--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(temp, "state")],
		{ cwd: process.cwd(), env: { ...process.env, CI: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		let response: Response | null = null;
		for (let attempt = 0; attempt < 100 && response === null; attempt++) {
			if (child.exitCode !== null) throw new Error(`wrangler exited before readiness (${child.exitCode}): ${stderr}`);
			try { response = await fetch(`http://127.0.0.1:${port}/__cycle`); }
			catch { await delay(50); }
		}
		if (!response) throw new Error(`wrangler did not become ready: ${stderr}`);
		if (!response.ok) throw new Error(`cycle worker failed (${response.status}): ${await response.text()}\n${stderr}`);
		const result = await response.json() as Record<string, boolean>;
		assertAll(result);
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(temp, { recursive: true, force: true });
	}
});

function assertAll(result: Record<string, boolean>): void {
	for (const [name, passed] of Object.entries(result)) s.check(passed, name);
}

await s.done();
