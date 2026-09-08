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

const s = suite("collaboration-migration-sqlite");

const workerSource = String.raw`
import * as Y from "yjs";
import { VaultStore } from "./server/src/vaultStore.ts";

export class MigrationCycle {
  constructor(state) { this.state = state; }

  async fetch() {
    const sql = this.state.storage.sql;
    const root = new Y.Doc({ guid: "root" });
    root.getMap("sys").set("schemaVersion", 6);
    root.getMap("sys").set("protocolVersion", 2);
    root.getMap("pathToId").set("kept.md", "kept-body");
    root.getMap("pathToBlob").set("Board.canvas", { hash: "b".repeat(64), size: 42, revision: "blob-revision" });
    const rootUpdate = Y.encodeStateAsUpdate(root);
    root.destroy();
    sql.exec(
      "CREATE TABLE vault_clock (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL);" +
      "INSERT INTO vault_clock(id, sequence) VALUES (1, 1);" +
      "CREATE TABLE vault_feed_state (id INTEGER PRIMARY KEY CHECK(id = 1), floor_sequence INTEGER NOT NULL);" +
      "INSERT INTO vault_feed_state(id, floor_sequence) VALUES (1, 0);" +
      "CREATE TABLE vault_document_heads (document_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, latest_sequence INTEGER NOT NULL);" +
      "INSERT INTO vault_document_heads(document_id, generation, latest_sequence) VALUES ('root', 1, 1);" +
      "CREATE TABLE vault_journal (sequence INTEGER PRIMARY KEY, document_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, update_byte_length INTEGER NOT NULL, created_at INTEGER NOT NULL);" +
      "CREATE TABLE vault_journal_chunks (sequence INTEGER NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(sequence, chunk_index));" +
      "CREATE TABLE vault_meta (id INTEGER PRIMARY KEY CHECK(id = 1), vault_id TEXT NOT NULL, vault_generation TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version = 6), storage_format_version INTEGER NOT NULL CHECK(storage_format_version = 3), provisioned_at INTEGER NOT NULL);" +
      "INSERT INTO vault_meta(id, vault_id, vault_generation, schema_version, storage_format_version, provisioned_at) VALUES (1, 'legacy-vault', 'legacy-generation', 6, 3, 50);" +
      "CREATE TABLE settings_env (config_key TEXT PRIMARY KEY, env_rev INTEGER NOT NULL);" +
      "INSERT INTO settings_env(config_key, env_rev) VALUES ('obsidian', 3);" +
      "CREATE TABLE settings_files (config_key TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, rev INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(config_key, path));" +
      "INSERT INTO settings_files(config_key, path, sha256, size, rev, body) VALUES ('obsidian', 'app.json', '${"a".repeat(64)}', 2, 3, '{}');"
    );
    sql.exec("INSERT INTO vault_journal(sequence, document_id, generation, kind, update_byte_length, created_at) VALUES (1, 'root', 1, 'root', ?, 100)", rootUpdate.byteLength);
    sql.exec("INSERT INTO vault_journal_chunks(sequence, chunk_index, data) VALUES (1, 0, ?)", rootUpdate.slice().buffer);

    const store = new VaultStore(this.state.storage);
    const input = {
      migrationId: "collab_migrate_sqlite_cycle",
      vaultId: "legacy-vault",
      vaultGeneration: "legacy-generation",
      requestDigest: "1".repeat(64),
      subjectDigest: "2".repeat(64),
      ownerPrincipalId: "owner-principal",
      subjects: [
        { principalId: "owner-principal", role: "owner", state: "active", membershipRevision: 1,
          policyVersion: 1, capabilityDigest: "owner-digest", displayName: "Owner", colorSeed: "owner-color" },
        { principalId: "member-principal", role: "member", state: "active", membershipRevision: 1,
          policyVersion: 1, capabilityDigest: "member-digest", displayName: "Member", colorSeed: "member-color" },
        { deviceId: "owner-device", principalId: "owner-principal", state: "active", credentialRevision: 1 },
        { deviceId: "member-device", principalId: "member-principal", state: "active", credentialRevision: 1 },
      ],
      now: 500,
    };
    const receipt = store.migrateCollaboration(input);
    const replay = store.migrateCollaboration(input);
    const metadata = store.storedVaultMetadata();
    const reconstructed = store.reconstructDocument("root");
    const system = reconstructed.doc.getMap("sys");
    const path = reconstructed.doc.getMap("pathToId").get("kept.md");
    reconstructed.doc.destroy();
	const canvasRoot = store.reconstructDocument("root");
	const canvasVector = Y.encodeStateVector(canvasRoot.doc);
	canvasRoot.doc.getMap("pathToSemantic");
	canvasRoot.doc.getMap("sys").set("schemaVersion", 8);
	canvasRoot.doc.getMap("sys").set("protocolVersion", 4);
	const canvasRootUpdate = Y.encodeStateAsUpdate(canvasRoot.doc, canvasVector);
	canvasRoot.doc.destroy();
	const canvasMigration = store.migrateCanvasSchema({ migrationId: "canvas-schema-8-legacy-generation",
	  vaultId: "legacy-vault", vaultGeneration: "legacy-generation", rootUpdate: canvasRootUpdate,
	  rootStateHash: "3".repeat(64), now: 600 });
	const canvasReplay = store.migrateCanvasSchema({ migrationId: "canvas-schema-8-legacy-generation",
	  vaultId: "legacy-vault", vaultGeneration: "legacy-generation", rootUpdate: new Uint8Array(),
	  rootStateHash: "0".repeat(64), now: 601 });
	const canvasMetadata = store.storedVaultMetadata();
	const finalRoot = store.reconstructDocument("root");
	const retainedCanvasBlob = finalRoot.doc.getMap("pathToBlob").get("Board.canvas");
	const semanticPaths = finalRoot.doc.getMap("pathToSemantic").size;
	const finalSchema = finalRoot.doc.getMap("sys").get("schemaVersion");
	finalRoot.doc.destroy();
    const settingsKey = sql.exec("SELECT config_key FROM settings_env").one().config_key;
    const fileSettingsKey = sql.exec("SELECT config_key FROM settings_files").one().config_key;
    const journal = sql.exec("SELECT sequence FROM vault_journal ORDER BY sequence").toArray().map((row) => row.sequence);
    return Response.json({
      receipt,
      replayExact: JSON.stringify(receipt) === JSON.stringify(replay),
      metadata,
      root: { schemaVersion: system.get("schemaVersion"), protocolVersion: system.get("protocolVersion"),
        historyAttribution: system.get("historyAttribution"), path },
      settingsKey,
      fileSettingsKey,
      journal,
      authority: store.principalAuthority("owner-principal")?.role,
	  canvasMigration, canvasReplayExact: JSON.stringify(canvasMigration) === JSON.stringify(canvasReplay),
	  canvasMetadata, retainedCanvasBlob, semanticPaths, finalSchema,
    });
  }
}

export default {
  fetch(_request, env) {
    return env.MIGRATION.get(env.MIGRATION.idFromName("migration")).fetch("https://internal/run");
  },
};
`;

s.test("schema-6 vault migration preserves history and atomically installs schema 7", async () => {
	const temp = await mkdtemp(join(tmpdir(), "yaos-collaboration-migration-"));
	const outfile = join(temp, "worker.mjs");
	const configPath = join(temp, "wrangler.jsonc");
	let child: ChildProcessWithoutNullStreams | null = null;
	let stderr = "";
	try {
		await build({
			alias: { yjs: join(process.cwd(), "node_modules/yjs/dist/yjs.mjs") },
			stdin: { contents: workerSource, resolveDir: process.cwd(), sourcefile: "collaboration-migration-worker.ts", loader: "ts" },
			outfile,
			bundle: true,
			format: "esm",
			platform: "browser",
			target: "es2022",
			logLevel: "silent",
			external: ["cloudflare:workers"],
		});
		await writeFile(configPath, JSON.stringify({
			name: "yaos-collaboration-migration",
			main: "./worker.mjs",
			compatibility_date: "2026-03-02",
			durable_objects: { bindings: [{ name: "MIGRATION", class_name: "MigrationCycle" }] },
			migrations: [{ tag: "v1", new_sqlite_classes: ["MigrationCycle"] }],
		}), "utf8");
		const port = await availablePort();
		child = spawn(join(process.cwd(), "server/node_modules/.bin/wrangler"), [
			"dev", "--config", configPath, "--ip", "127.0.0.1", "--port", String(port),
			"--persist-to", join(temp, "state"),
		], { cwd: process.cwd(), env: { ...process.env, CI: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		let response: Response | null = null;
		for (let attempt = 0; attempt < 100 && response === null; attempt++) {
			if (child.exitCode !== null) throw new Error(`wrangler exited before readiness (${child.exitCode}): ${stderr}`);
			try { response = await fetch(`http://127.0.0.1:${port}/run`); }
			catch { await delay(50); }
		}
		if (!response) throw new Error(`wrangler did not become ready: ${stderr}`);
		if (!response.ok) throw new Error(`migration worker failed (${response.status}): ${await response.text()}\n${stderr}`);
		const result = await response.json() as {
			receipt: { rootSequence: number; settingsEnvironmentCount: number; historyAttribution: string };
			replayExact: boolean;
			metadata: { schemaVersion: number; storageFormatVersion: number };
			root: { schemaVersion: number; protocolVersion: number; historyAttribution: string; path: string };
			settingsKey: string;
			fileSettingsKey: string;
			journal: number[];
			authority: string;
			canvasMigration: { rootSequence: number; rootStateHash: string };
			canvasReplayExact: boolean;
			canvasMetadata: { schemaVersion: number; storageFormatVersion: number };
			retainedCanvasBlob: { hash: string; size: number; revision: string };
			semanticPaths: number;
			finalSchema: number;
		};
		s.check(result.replayExact && result.receipt.rootSequence === 2, "migration replays its exact durable receipt");
		s.check(result.metadata.schemaVersion === 7 && result.metadata.storageFormatVersion === 3,
			"vault_meta CHECK constraint is rebuilt for schema 7");
		s.check(result.journal.join(",") === "1,2,3" && result.root.path === "kept-body",
			"legacy journal and root content survive the schema transition");
		s.check(result.root.schemaVersion === 7 && result.root.protocolVersion === 4
			&& result.root.historyAttribution === "legacy_unattributed",
			"root advertises schema 7 while historical work remains explicitly unattributed");
		s.check(result.settingsKey === "\u0001owner-principal\0obsidian"
			&& result.fileSettingsKey === result.settingsKey && result.receipt.settingsEnvironmentCount === 1,
			"legacy settings environments become owner-principal scoped in the same transaction");
		s.check(result.authority === "owner", "principal and device authority mirror is installed before activation");
		s.check(result.canvasReplayExact && result.canvasMigration.rootSequence === 3
			&& result.canvasMigration.rootStateHash === "3".repeat(64),
			"schema-7 to schema-8 migration is durably idempotent");
		s.check(result.canvasMetadata.schemaVersion === 8 && result.canvasMetadata.storageFormatVersion === 3
			&& result.finalSchema === 8, "Canvas migration advances durable and root schema together");
		s.check(result.semanticPaths === 0 && result.retainedCanvasBlob.hash === "b".repeat(64)
			&& result.retainedCanvasBlob.revision === "blob-revision",
			"Canvas migration preserves every attachment head and performs no implicit promotion");
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(temp, { recursive: true, force: true });
	}
});

await s.done();
