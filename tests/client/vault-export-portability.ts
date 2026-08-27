import { strFromU8, unzipSync } from "fflate";
import { buildPortableVaultArchive } from "../../src/snapshots/vaultExport";
import { VAULT_LIFECYCLE_COPY } from "../../src/snapshots/vaultLifecycleCopy";
import { suite } from "../harness.ts";

const s = suite("vault-export-portability");

s.test("portable archive contains every user file and a verified manifest", async () => {
	const archive = await buildPortableVaultArchive([
		{ path: "notes/a.md", bytes: new TextEncoder().encode("alpha\n") },
		{ path: "attachments/image.bin", bytes: new Uint8Array([0, 1, 2, 255]) },
		{ path: ".obsidian/theme.json", bytes: new TextEncoder().encode("{\"theme\":\"dark\"}") },
		{ path: "empty-folder", directory: true },
	], "2026-08-23T00:00:00.000Z", ".obsidian");
	const unzipped = unzipSync(archive.bytes);
	if (!unzipped["notes/a.md"] || !unzipped["attachments/image.bin"] || !unzipped[".obsidian/theme.json"]) {
		throw new Error("archive omitted a portable vault file");
	}
	if (!archive.manifest.directories.includes("empty-folder") || !unzipped["empty-folder/"]) {
		throw new Error("archive omitted an empty portable vault directory");
	}
	const manifestBytes = unzipped["yaos-export-manifest.json"];
	if (!manifestBytes) throw new Error("archive omitted its manifest");
	const manifest = JSON.parse(strFromU8(manifestBytes)) as typeof archive.manifest;
	if (manifest.format !== "yaos-portable-vault-v1" || manifest.fileCount !== 3 || manifest.files.length !== 3) {
		throw new Error("manifest counts or format are wrong");
	}
	for (const entry of manifest.files) {
		const bytes = unzipped[entry.path];
		if (!bytes || bytes.byteLength !== entry.size) throw new Error(`manifest size mismatch for ${entry.path}`);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		if (hash !== entry.sha256) throw new Error(`manifest hash mismatch for ${entry.path}`);
	}
});

s.test("portable archive excludes YAOS credentials and recovery working copies", async () => {
	const archive = await buildPortableVaultArchive([
		{ path: "note.md", bytes: new TextEncoder().encode("safe") },
		{ path: ".obsidian/plugins/yaos/data.json", bytes: new TextEncoder().encode("secret-token") },
		{ path: ".obsidian/plugins/yaos/restore-backups/session/note.md", bytes: new TextEncoder().encode("old") },
	], "2026-08-23T00:00:00.000Z", ".obsidian");
	const unzipped = unzipSync(archive.bytes);
	if (unzipped[".obsidian/plugins/yaos/data.json"] || unzipped[".obsidian/plugins/yaos/restore-backups/session/note.md"]) {
		throw new Error("archive leaked YAOS internal state");
	}
	if (!unzipped["note.md"] || archive.manifest.fileCount !== 1) throw new Error("archive lost the user file");
});
s.test("portable archive excludes YAOS credentials under a custom config directory", async () => {
	const archive = await buildPortableVaultArchive(
		[
			{ path: "_config/plugins/yaos/data.json", bytes: new TextEncoder().encode("secret-token") },
			{ path: "_config/workspace.json", bytes: new TextEncoder().encode("{}") },
		],
		"2026-08-23T00:00:00.000Z",
		"_config",
	);
	const unzipped = unzipSync(archive.bytes);
	if (unzipped["_config/plugins/yaos/data.json"] || !unzipped["_config/workspace.json"]) {
		throw new Error("custom config export exclusion is incorrect");
	}
});


s.test("lifecycle confirmation copy distinguishes retained and deleted state", () => {
	const local = VAULT_LIFECYCLE_COPY["reset-local-cache"];
	const active = VAULT_LIFECYCLE_COPY["reset-active-state"];
	const full = VAULT_LIFECYCLE_COPY["delete-vault"];
	if (!local.retained.includes("Files on disk") || !local.retained.includes("server active state")) {
		throw new Error("local cache reset copy does not promise retained authoritative state");
	}
	if (!active.retained.includes("durable recovery points") || !active.deleted.includes("Active server file catalog and bodies")) {
		throw new Error("active reset copy does not distinguish recovery from active state");
	}
	if (!full.deleted.includes("vault provisioning record and access") || !full.retained.includes("Files already on this device")) {
		throw new Error("full deletion copy is not explicit about revocation and local retention");
	}
});

s.test("portable export preserves a user file that has the default manifest name", async () => {
	const userBytes = new TextEncoder().encode("user-owned");
	const archive = await buildPortableVaultArchive([
		{ path: "yaos-export-manifest.json", bytes: userBytes },
	], "2026-08-23T00:00:00.000Z", ".obsidian");
	const unzipped = unzipSync(archive.bytes);
	if (strFromU8(unzipped["yaos-export-manifest.json"]!) !== "user-owned") {
		throw new Error("generated manifest overwrote the user file");
	}
	if (archive.manifestPath === "yaos-export-manifest.json" || !unzipped[archive.manifestPath]) {
		throw new Error("export did not select a collision-free manifest path");
	}
});

await s.done();
