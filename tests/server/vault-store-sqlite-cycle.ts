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

const s = suite("vault-store-sqlite-cycle");

const workerSource = String.raw`
import * as Y from "yjs";
import { VaultStore } from "./server/src/vaultStore.ts";


function incremental(doc, mutate) {
  const vector = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, vector);
}

export class StoreCycle {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const store = new VaultStore(this.state.storage);
    const root = new Y.Doc({ guid: "root" });
    root.getMap("sys").set("schemaVersion", 4);
    const rootUpdate = Y.encodeStateAsUpdate(root);
    const vaultGeneration = "generation-sqlite-cycle-0001";
    const provisioned = store.provisionVault("sqlite-cycle-vault", vaultGeneration, rootUpdate, 500);
    const replayed = store.provisionVault("sqlite-cycle-vault", vaultGeneration, rootUpdate, 501);
    let generationFenceRejected = false;
    try {
      store.provisionVault("sqlite-cycle-vault", "generation-sqlite-cycle-0002", rootUpdate, 502);
    } catch {
      generationFenceRejected = true;
    }
    const metadata = store.vaultMetadata();
    root.destroy();
    const bootstrap = store.beginPinnedOperation({
      operationId: "bootstrap-sqlite-cycle",
      kind: "bootstrap",
      now: 600,
    });
    const bootstrapReplay = store.beginPinnedOperation({
      operationId: "bootstrap-sqlite-cycle",
      kind: "bootstrap",
      now: 601,
    });
    store.recordOperationPage({
      operationId: bootstrap.operation.operationId,
      pageIndex: 0,
      cursor: "page-0",
      artifactKey: "bootstrap/root.bin",
      artifactHash: "0".repeat(64),
      entryCount: 1,
    }, 1, 602);
    const completedBootstrap = store.completePinnedOperation(
      bootstrap.operation.operationId,
      "bootstrap/root.bin",
      "0".repeat(64),
      603,
    );
    const bootstrapCycle = bootstrapReplay.operation.operationId === bootstrap.operation.operationId
      && store.listOperationPages(bootstrap.operation.operationId).length === 1
      && completedBootstrap.state === "complete"
      && store.getPin(bootstrap.operation.operationId) === null;

    const body = new Y.Doc({ guid: "sqlite-cycle-body" });
    const largeUpdate = incremental(body, () => body.getText("payload").insert(0, "x".repeat(1_200_000)));
    store.commitUpdate({ documentId: "sqlite-cycle-body", update: largeUpdate, kind: "body" });
    for (let index = 0; index < 60; index++) {
      const update = incremental(body, () => body.getText("body").insert(body.getText("body").length, String(index % 10)));
      store.commitUpdate({ documentId: "sqlite-cycle-body", update, kind: "body" });
    }
    const sequence = store.currentSequence();
    const before = store.documentJournalStats("sqlite-cycle-body");
    const pin = store.createPin({ kind: "capture", boundarySequence: sequence, pinId: "cycle-pin" });
    const blocked = store.writeCheckpoint("sqlite-cycle-body", sequence);
    const pinnedFloorRejected = (() => {
      try {
        store.advanceFeedFloor(sequence);
        return false;
      } catch {
        return true;
      }
    })();
    store.releasePin(pin.pinId);
    const checkpoint = store.writeCheckpoint("sqlite-cycle-body", sequence);
    const floor = store.advanceFeedFloor(sequence);
    const after = store.documentJournalStats("sqlite-cycle-body");
    const feed = store.changesPageAfter(0, 100);
    const reconstructed = store.reconstructDocument("sqlite-cycle-body");
    const text = reconstructed.doc.getText("body").toString();
    const payloadLength = reconstructed.doc.getText("payload").length;
    const catalogBody = new Y.Doc({ guid: "catalog-body" });
    const catalogBodyUpdate = incremental(catalogBody, () => catalogBody.getText("body").insert(0, "catalog"));
    const catalogBodyCommit = store.commitUpdate({ documentId: "catalog-body", update: catalogBodyUpdate, kind: "body" });
    const catalogRoot = store.reconstructDocument("root").doc;
    const createCatalogUpdate = incremental(catalogRoot, () => catalogRoot.getMap("pathToId").set("old.md", "catalog-body"));
    const createCatalogCommit = store.commitRootLifecycle({
      rootUpdate: createCatalogUpdate,
      kind: "create",
      catalog: {
        bodyId: "catalog-body",
        fileId: "catalog-body",
        path: "old.md",
        previousPath: null,
        lifecycle: "active",
        bodyGeneration: catalogBodyCommit.generation,
      },
    });
    const renameCatalogUpdate = incremental(catalogRoot, () => {
      catalogRoot.getMap("pathToId").delete("old.md");
      catalogRoot.getMap("pathToId").set("new.md", "catalog-body");
    });
    const renameCatalogCommit = store.commitRootLifecycle({
      rootUpdate: renameCatalogUpdate,
      kind: "rename",
      catalog: {
        bodyId: "catalog-body",
        fileId: "catalog-body",
        path: "new.md",
        previousPath: "old.md",
        lifecycle: "active",
        bodyGeneration: catalogBodyCommit.generation,
      },
    });
    const directHead = store.getCatalogHeadAt(renameCatalogCommit.vaultSequence, "catalog-body");
    const listedHead = store.listCatalogAt(renameCatalogCommit.vaultSequence).find((entry) => entry.bodyId === "catalog-body");
    const renameFeed = store.changesPageAfter(createCatalogCommit.vaultSequence).entries.find((entry) => entry.sequence === renameCatalogCommit.vaultSequence);
    catalogRoot.destroy();
    const gcOne = store.createGcEpoch({
      requestId: "gc-request-one",
      vaultId: "sqlite-cycle-vault",
      vaultGeneration,
      jobId: "gc:sqlite-cycle-vault:generation-sqlite-cycle-0001",
      capabilityHash: "a".repeat(64),
      capabilityExpiresAt: 86_401_000,
    }, 1_000);
    store.advanceGcEpoch(gcOne.epoch, "aborted", 1_001);
    const gcTwo = store.createGcEpoch({
      requestId: "gc-request-two",
      vaultId: "sqlite-cycle-vault",
      vaultGeneration,
      jobId: "gc:sqlite-cycle-vault:generation-sqlite-cycle-0001",
      capabilityHash: "b".repeat(64),
      capabilityExpiresAt: 86_402_000,
    }, 2_000);
    store.advanceGcEpoch(gcTwo.epoch, "sweeping", 2_001);
    const garbageHash = "f".repeat(64);
    const garbageKey = "vault/sqlite-cycle-vault/generation-sqlite-cycle-0001/recovery-v2/content/sha256/ff/" + garbageHash + ".md.gz";
    store.recordProjectedContent(garbageHash, garbageKey, 10, null, 2_001);
    store.acquireMaterializationLease({
      leaseId: "capture-writer-lease",
      ownerKind: "capture",
      ownerId: "capture-in-flight",
      objectKeys: [garbageKey],
      expiresAt: 2_500,
      now: 2_002,
    });
    const reacquiredWriter = store.acquireMaterializationLease({
      leaseId: "capture-writer-lease-after-crash",
      ownerKind: "capture",
      ownerId: "capture-in-flight",
      objectKeys: [garbageKey],
      expiresAt: 2_600,
      now: 2_003,
    });
    const staleLeaseRelease = store.releaseKeyLease("capture-writer-lease");
    const crashReacquiredMaterializationLease = reacquiredWriter.leaseId === "capture-writer-lease-after-crash"
      && staleLeaseRelease === 0
      && store.hasMaterializationLease("capture-in-flight", garbageKey, 2_004);
    let differentOwnerRejected = false;
    try {
      store.acquireMaterializationLease({
        leaseId: "different-writer-lease",
        ownerKind: "capture",
        ownerId: "capture-other",
        objectKeys: [garbageKey],
        expiresAt: 2_700,
        now: 2_004,
      });
    } catch {
      differentOwnerRejected = true;
    }
    const blockedSweep = store.acquireSweepLease({
      leaseId: "sweep-blocked-by-writer",
      epoch: gcTwo.epoch,
      ownerId: "gc:sqlite-cycle-vault:generation-sqlite-cycle-0001",
      domain: "recovery",
      objectKeys: [garbageKey],
      expiresAt: 3_000,
      now: 2_005,
    });
    store.releaseKeyLease("capture-writer-lease-after-crash");
    const sweep = store.acquireSweepLease({
      leaseId: "sweep-indexed-garbage",
      epoch: gcTwo.epoch,
      ownerId: "gc:sqlite-cycle-vault:generation-sqlite-cycle-0001",
      domain: "recovery",
      objectKeys: [garbageKey],
      expiresAt: 3_000,
      now: 2_006,
    });
    store.invalidateDeletedObjects(sweep.leaseId, sweep.approvedKeys);
    const indexedGarbageInvalidated = store.missingIndexedContent([garbageHash]).includes(garbageHash);
    store.advanceGcEpoch(gcTwo.epoch, "complete", 2_003);
    const capture = store.createRecoveryCapture({
      captureId: "capture-delta-reset",
      requestId: "capture-delta-reset-request",
      vaultId: "sqlite-cycle-vault",
      vaultGeneration,
      boundarySequence: store.currentSequence(),
      rootGeneration: store.documentHead("root").generation,
      runtimeEpoch: "sqlite-cycle-runtime-epoch",
      reason: "manual",
      jobId: "capture:sqlite-cycle-vault:generation-sqlite-cycle-0001:capture-delta-reset",
      capabilityHash: "c".repeat(64),
      capabilityExpiresAt: 90_000,
      softExpiresAt: 60_000,
      hardExpiresAt: 90_000,
      now: 3_000,
    });
    store.recordDeltaPage({
      captureId: capture.captureId,
      startCursor: null,
      endCursor: null,
      pageHash: "d".repeat(64),
      entries: 1,
      terminal: true,
      rollingDigest: "e".repeat(64),
      now: 3_001,
    });
    store.resetCaptureDelta(capture.captureId, 3_002);
    const deltaReset = store.recoveryCapture(capture.captureId).deltaDigest === null
      && store.deltaPageCommitment(capture.captureId, null) === null;
    let deletionGenerationRejected = false;
    try {
      store.beginVaultDeletion("deletion-sqlite-cycle", "generation-sqlite-cycle-0002", 4_000);
    } catch {
      deletionGenerationRejected = true;
    }
    const deletion = store.beginVaultDeletion("deletion-sqlite-cycle", vaultGeneration, 4_001);
    const deletionAuthority = deletionGenerationRejected
      && deletion.captureJobIds.includes(capture.jobId)
      && store.vaultDeletionBegun(vaultGeneration);
    catalogBody.destroy();
    reconstructed.doc.destroy();
    body.destroy();

    return Response.json({
      metadata: {
        created: provisioned.created,
        replayed: !replayed.created,
        generationFenceRejected,
        persisted: metadata?.vaultGeneration === vaultGeneration,
        schemaVersion: metadata?.schemaVersion ?? null,
        storageFormatVersion: metadata?.storageFormatVersion ?? null,
        bootstrapCycle,
      },
      before,
      blocked: blocked.status,
      pinnedFloorRejected,
      checkpoint: checkpoint.status,
      checkpointChunks: checkpoint.chunks,
      floor: floor.floor,
      after,
      resetRequired: feed.resetRequired,
      highWater: feed.highWater,
      textLength: text.length + payloadLength,
      previousPath: {
        direct: directHead?.previousPath ?? null,
        listed: listedHead?.previousPath ?? null,
        feed: renameFeed?.catalogs[0]?.previousPath ?? null,
      },
      authority: {
        gcEpochAdvanced: gcTwo.epoch === gcOne.epoch + 1,
        indexedGarbageApproved: sweep.approvedKeys.includes(garbageKey),
        activeWriterBlockedSweep: blockedSweep.approvedKeys.length === 0,
        crashReacquiredMaterializationLease,
        differentOwnerRejected,
        indexedGarbageInvalidated,
        deltaReset,
        deletionAuthority,
      },
    });
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/__cycle") {
      const id = env.CYCLE.idFromName("cycle");
      return env.CYCLE.get(id).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
`;

s.test("VaultStore completes journal/checkpoint/pin/feed-floor cycle on real SQLite", async () => {
	const temp = await mkdtemp(join(tmpdir(), "yaos-vault-sqlite-"));
	const outfile = join(temp, "worker.mjs");
	const configPath = join(temp, "wrangler.jsonc");
	let child: ChildProcessWithoutNullStreams | null = null;
	let stderr = "";
	try {
		await build({
			alias: { yjs: join(process.cwd(), "node_modules/yjs/dist/yjs.mjs") },
			stdin: { contents: workerSource, resolveDir: process.cwd(), sourcefile: "vault-cycle-worker.ts", loader: "ts" },
			outfile,
			bundle: true,
			format: "esm",
			platform: "browser",
			target: "es2022",
			logLevel: "silent",
			external: ["cloudflare:workers"],
		});
		await writeFile(configPath, JSON.stringify({
			name: "yaos-vault-sqlite-cycle",
			main: "./worker.mjs",
			compatibility_date: "2026-03-02",
			durable_objects: { bindings: [
				{ name: "CYCLE", class_name: "StoreCycle" },
			] },
			migrations: [{ tag: "v1", new_sqlite_classes: ["StoreCycle"] }],
		}), "utf8");
		const port = await availablePort();
		child = spawn(join(process.cwd(), "server/node_modules/.bin/wrangler"), [
			"dev",
			"--config", configPath,
			"--ip", "127.0.0.1",
			"--port", String(port),
			"--persist-to", join(temp, "state"),
		], { cwd: process.cwd(), env: { ...process.env, CI: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		let response: Response | null = null;
		for (let attempt = 0; attempt < 100 && response === null; attempt++) {
			if (child.exitCode !== null) throw new Error(`wrangler exited before readiness (${child.exitCode}): ${stderr}`);
			try {
				response = await fetch(`http://127.0.0.1:${port}/__cycle`);
			} catch {
				await delay(50);
			}
		}
		if (!response) throw new Error(`wrangler did not become ready: ${stderr}`);
		if (!response.ok) throw new Error(`cycle worker failed (${response.status}): ${await response.text()}\\n${stderr}`);
		const result = await response.json() as {
			metadata: {
				created: boolean;
				replayed: boolean;
				generationFenceRejected: boolean;
				persisted: boolean;
				schemaVersion: number | null;
				storageFormatVersion: number | null;
				bootstrapCycle: boolean;
			};
			before: { entries: number; bytes: number };
			blocked: string;
			pinnedFloorRejected: boolean;
			checkpoint: string;
			checkpointChunks: number;
			floor: number;
			authority: {
				gcEpochAdvanced: boolean;
				indexedGarbageApproved: boolean;
				activeWriterBlockedSweep: boolean;
				indexedGarbageInvalidated: boolean;
				crashReacquiredMaterializationLease: boolean;
				differentOwnerRejected: boolean;
				deltaReset: boolean;
				deletionAuthority: boolean;
			};
			after: { entries: number; bytes: number };
			resetRequired: boolean;
			highWater: number;
			textLength: number;
			previousPath: { direct: string | null; listed: string | null; feed: string | null };
		};
		s.check(
			result.metadata.created && result.metadata.replayed && result.metadata.generationFenceRejected
				&& result.metadata.persisted && result.metadata.bootstrapCycle
				&& result.metadata.schemaVersion === 4 && result.metadata.storageFormatVersion === 1,
			"schema-4 metadata persists vaultGeneration and rejects a different provisioning incarnation",
		);
		s.check(result.before.entries === 61 && result.before.bytes > 1_200_000, "real SQLite journal contains the large update plus all semantic body edits");
		s.check(result.blocked === "blocked-by-pin" && result.pinnedFloorRejected, "active capture pin blocks checkpoint compaction and feed-floor advancement");
		s.check(result.checkpoint === "written", "checkpoint writes after pin release");
		s.check(result.checkpointChunks > 1, "large checkpoint is split across multiple SQLite chunks");
		s.check(result.floor === result.highWater && result.floor > 0, "feed floor advances to durable high-water after checkpoint");
		s.check(result.after.entries === 0 && result.after.bytes === 0, "checkpointed journal rows are compacted on real SQLite");
		s.check(result.resetRequired, "cursor below retained floor receives reset-required response");
		s.check(result.textLength === 1_200_060, "chunked checkpoint reconstruction preserves exact body state");
		s.check(result.authority.deletionAuthority, "vault deletion authority remains generation-fenced");
		s.check(
			result.authority.crashReacquiredMaterializationLease
				&& result.authority.differentOwnerRejected
				&& result.authority.activeWriterBlockedSweep
				&& result.authority.indexedGarbageApproved
				&& result.authority.indexedGarbageInvalidated,
			"same logical writer replaces a crash-stale lease, other writers and GC remain fenced until release",
		);
		s.check(result.authority.deltaReset, "delta fallback atomically clears committed page chain and digest");
		s.check(
			result.previousPath.direct === "old.md"
				&& result.previousPath.listed === "old.md"
				&& result.previousPath.feed === "old.md",
			"real SQLite get/list/feed APIs preserve atomic rename previousPath",
		);
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(temp, { recursive: true, force: true });
	}
});

await s.done();
