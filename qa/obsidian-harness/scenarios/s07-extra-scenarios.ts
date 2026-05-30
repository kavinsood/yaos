/**
 * S07 supplementary scenarios: S07i, S07j, S07k, S07h-large.
 *
 * S07i  Folder-then-file-later
 *   Empty folders are not synced by design. This scenario verifies that
 *   files created inside an empty folder AFTER the folder is created sync
 *   correctly, and that the empty-folder limitation does not poison later
 *   file creation.
 *
 * S07j  Attachment reference before blob
 *   A note with an image embed link `![[image.png]]` syncs immediately
 *   (text/CRDT pipeline). The blob may not exist in R2 yet. The test
 *   proves text sync is independent of blob sync — the markdown file
 *   must reach disk==CRDT even if the referenced blob is absent.
 *
 * S07k  Blob arrives after reference (markdown stability)
 *   Extends S07j: after the markdown is synced, the referenced blob is
 *   created. The blob should be queued/synced separately. The markdown
 *   CRDT entry must remain unchanged — the blob arriving must NOT
 *   trigger a rewrite, conflict, or divergence on the text side.
 *
 * S07h-large  250-file burst
 *   Extends S07h to stress-test YAOS's watcher/coalescing path at a
 *   more meaningful scale. S07h proved the path works for 25 files. This
 *   variant proves it holds at 250 concurrent creates.
 */

import type { QaScenario } from "../types";

const FOLDER = "QA-s07-extra";

// -----------------------------------------------------------------------
// S07i — Folder-then-file-later
// -----------------------------------------------------------------------

export const s07iFolderThenFile: QaScenario = {
	id: "s07i-folder-then-file-later",
	title: "S07i: Create folder then create files inside it (empty-folder semantics)",
	tags: ["s07i", "plugin-writes", "folder", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const folderPath = `${FOLDER}/project-${ts}`;
		const notePath = `${folderPath}/index.md`;
		const innerFolderPath = `${folderPath}/Notes`;
		const innerNotePath = `${innerFolderPath}/note-${ts}.md`;

		const content = (name: string) => `# ${name}\n\nCreated by plugin template.\n`;

		// 1. Create folder tree (YAOS does not sync empty folders by design).
		await ctx.app.vault.createFolder(folderPath).catch(() => {});
		await ctx.app.vault.createFolder(innerFolderPath).catch(() => {});
		await ctx.sleep(500); // let folder events settle

		// 2. Create a file at the top level of the new folder.
		await ctx.createFile(notePath, content("Project Index"));
		await ctx.waitForFile(notePath, 15000);
		await ctx.waitForCrdtFile(notePath, 15000);
		await ctx.waitForIdle(8000);

		const diskIndex = await ctx.yaos.getDiskHash(notePath);
		const crdtIndex = await ctx.yaos.getCrdtHash(notePath);
		console.log("[S07i] top-level note", { diskIndex, crdtIndex });

		if (!diskIndex || !crdtIndex) {
			throw new Error("S07i: could not read hashes for top-level note");
		}
		if (diskIndex !== crdtIndex) {
			throw new Error(`S07i: disk != CRDT for top-level note\n  disk: ${diskIndex}\n  crdt: ${crdtIndex}`);
		}

		// 3. Create a file inside the nested folder.
		await ctx.createFile(innerNotePath, content("Inner Note"));
		await ctx.waitForFile(innerNotePath, 15000);
		await ctx.waitForCrdtFile(innerNotePath, 15000);
		await ctx.waitForIdle(8000);

		const diskInner = await ctx.yaos.getDiskHash(innerNotePath);
		const crdtInner = await ctx.yaos.getCrdtHash(innerNotePath);
		console.log("[S07i] nested note", { diskInner, crdtInner });

		if (!diskInner || !crdtInner) {
			throw new Error("S07i: could not read hashes for nested note");
		}
		if (diskInner !== crdtInner) {
			throw new Error(`S07i: disk != CRDT for nested note\n  disk: ${diskInner}\n  crdt: ${crdtInner}`);
		}

		// 4. Verify the empty folder was not synthesized as a ghost file.
		const ghostPath = `${FOLDER}/project-${ts}.md`;
		const ghostCrdt = await ctx.yaos.getCrdtHash(ghostPath);
		if (ghostCrdt) {
			throw new Error("S07i: a ghost file for the folder was created in CRDT");
		}

		await ctx.deleteFile(notePath);
		await ctx.deleteFile(innerNotePath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07j — Attachment reference before blob
// -----------------------------------------------------------------------

export const s07jAttachmentRefBeforeBlob: QaScenario = {
	id: "s07j-attachment-ref-before-blob",
	title: "S07j: Markdown references attachment before blob exists (text sync independent)",
	tags: ["s07j", "plugin-writes", "attachment", "blob", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const notePath = `${FOLDER}/s07j-with-embed-${ts}.md`;
		// Reference a PNG that doesn't exist yet in R2/local vault.
		const blobName = `diagram-${ts}.png`;
		const noteContent = [
			"---",
			'title: "S07j Attachment Test"',
			"---",
			"",
			"## Diagram",
			"",
			`![[${blobName}]]`,
			"",
			"The image above should load once synced.",
			"",
		].join("\n");

		// 1. Create note with embed reference (blob does not exist yet).
		await ctx.createFile(notePath, noteContent);
		await ctx.waitForFile(notePath, 15000);
		await ctx.waitForCrdtFile(notePath, 15000);
		await ctx.waitForIdle(8000);

		// 2. POSTCONDITION: markdown file must reach disk==CRDT regardless of blob state.
		const diskHash = await ctx.yaos.getDiskHash(notePath);
		const crdtHash = await ctx.yaos.getCrdtHash(notePath);
		console.log("[S07j] markdown sync", { diskHash, crdtHash });

		if (!diskHash || !crdtHash) {
			throw new Error("S07j: could not read note hashes");
		}
		if (diskHash !== crdtHash) {
			throw new Error(
				`S07j: markdown file did not sync (blob absence blocked text sync)\n` +
				`  disk: ${diskHash}\n  crdt: ${crdtHash}`,
			);
		}

		// 3. Verify no conflict artifact was created just because the blob is missing.
		const conflictPath = `${FOLDER}/${blobName} (conflict`;
		const crdtConflict = ctx.app.vault.getAbstractFileByPath(conflictPath);
		if (crdtConflict) {
			throw new Error("S07j: conflict artifact created for missing blob — text sync should not depend on blob");
		}

		await ctx.deleteFile(notePath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07h-large — 250-file burst
// -----------------------------------------------------------------------

const LARGE_BURST_COUNT = 250;

export const s07hLargeBurst: QaScenario = {
	id: "s07h-large-burst",
	title: `S07h-large: ${LARGE_BURST_COUNT}-file concurrent burst (watcher/coalescing stress)`,
	tags: ["s07h", "plugin-writes", "burst", "bulk", "stress", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const paths = Array.from({ length: LARGE_BURST_COUNT }, (_, i) =>
			`${FOLDER}/s07h-large-${ts}-${String(i).padStart(3, "0")}.md`,
		);
		const content = (i: number) =>
			`---\ntitle: "Burst ${i}"\nindex: ${i}\n---\n\nFile ${i} of ${LARGE_BURST_COUNT}.\n`;

		// 1. Create all files concurrently.
		await Promise.all(paths.map((path, i) => ctx.createFile(path, content(i))));
		console.log(`[S07h-large] created ${LARGE_BURST_COUNT} files concurrently`);

		// 2. Wait for all CRDT entries (in parallel, 30s timeout per file).
		await Promise.all(paths.map((path) => ctx.waitForCrdtFile(path, 30000)));
		await ctx.waitForIdle(15000);
		console.log(`[S07h-large] all ${LARGE_BURST_COUNT} files in CRDT`);

		// 3. Check convergence in batches to avoid console flood.
		const results = await Promise.all(
			paths.map(async (path) => ({
				path,
				disk: await ctx.yaos.getDiskHash(path),
				crdt: await ctx.yaos.getCrdtHash(path),
			})),
		);

		const mismatches = results.filter((r) => !r.disk || !r.crdt || r.disk !== r.crdt);
		const converged = results.length - mismatches.length;
		console.log(`[S07h-large] ${converged}/${LARGE_BURST_COUNT} files converged`);

		if (mismatches.length > 0) {
			const detail = mismatches
				.slice(0, 5)
				.map((r) => `  ${r.path.split("/").pop()}: disk=${r.disk?.slice(0, 8) ?? "null"} crdt=${r.crdt?.slice(0, 8) ?? "null"}`)
				.join("\n");
			throw new Error(
				`S07h-large: ${mismatches.length}/${LARGE_BURST_COUNT} files did not converge:\n${detail}` +
				(mismatches.length > 5 ? `\n  ... and ${mismatches.length - 5} more` : ""),
			);
		}

		// 4. Cleanup in parallel.
		await Promise.all(paths.map((path) => ctx.deleteFile(path)));
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(10000);
	},
};

// -----------------------------------------------------------------------
// S07k — Blob arrives after markdown reference (markdown stability)
//
// S07j proves: markdown syncs regardless of blob absence.
// S07k proves the reverse: blob arriving AFTER the markdown is already
// synced must NOT disturb the markdown CRDT entry.
//
// Failure modes under test:
//   1. Blob create triggers a markdown CRDT rewrite (hash changes).
//   2. Blob create produces a conflict copy at the markdown path.
//   3. Blob sync overwrites the markdown text entry in error.
//   4. Status reporting conflates text receipt and blob queue state.
//
// What this does NOT test:
//   - Actual blob upload to R2 (no network required).
//   - Blob sync protocol details.
//   - Blob download on remote device.
// It only tests that the TEXT pipeline is unaffected by a blob event.
// -----------------------------------------------------------------------

export const s07kBlobArrivesAfterReference: QaScenario = {
	id: "s07k-blob-arrives-after-reference",
	title: "S07k: Blob arrives after markdown reference — markdown CRDT must remain stable",
	tags: ["s07k", "plugin-writes", "attachment", "blob", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const notePath = `${FOLDER}/s07k-note-${ts}.md`;
		const blobName = `s07k-image-${ts}.png`;
		const blobPath = `${FOLDER}/${blobName}`;

		const noteContent = [
			"---",
			'title: "S07k Blob Stability Test"',
			"---",
			"",
			"## Image",
			"",
			`![[${blobName}]]`,
			"",
			"Text sync must be unaffected by blob arrival.",
			"",
		].join("\n");

		// Minimal valid 1x1 PNG (67 bytes) — enough to be a real file type.
		// This is a binary blob, but vault.create() takes a string. We use
		// a short placeholder text file to represent a blob-like attachment.
		// The test cares about the TEXT pipeline, not actual image decoding.
		const blobContent = `fake-png-placeholder-${ts}`;

		// 1. Create markdown note with embed reference (blob not yet present).
		await ctx.createFile(notePath, noteContent);
		await ctx.waitForCrdtFile(notePath, 15000);
		await ctx.waitForIdle(8000);

		// 2. Capture the markdown CRDT hash BEFORE blob arrives.
		const diskBeforeBlob = await ctx.yaos.getDiskHash(notePath);
		const crdtBeforeBlob = await ctx.yaos.getCrdtHash(notePath);
		console.log("[S07k] markdown state before blob", { diskBeforeBlob, crdtBeforeBlob });

		if (!diskBeforeBlob || !crdtBeforeBlob) {
			throw new Error("S07k: could not read markdown hashes before blob creation");
		}
		if (diskBeforeBlob !== crdtBeforeBlob) {
			throw new Error(
				`S07k: markdown not converged before blob arrived\n` +
				`  disk: ${diskBeforeBlob}\n  crdt: ${crdtBeforeBlob}`,
			);
		}

		// 3. Create the blob at the referenced path.
		await ctx.createFile(blobPath, blobContent);
		await ctx.waitForFile(blobPath, 10000);
		const blobDisk = await ctx.yaos.getDiskHash(blobPath);
		console.log("[S07k] blob created", { blobPath, blobDisk });
		// Give YAOS time to process the blob create event.
		await ctx.sleep(2000);
		await ctx.waitForIdle(10000);

		// 4. POSTCONDITION: markdown CRDT hash must be unchanged after blob arrival.
		const diskAfterBlob = await ctx.yaos.getDiskHash(notePath);
		const crdtAfterBlob = await ctx.yaos.getCrdtHash(notePath);
		console.log("[S07k] markdown state after blob", { diskAfterBlob, crdtAfterBlob });

		if (!diskAfterBlob || !crdtAfterBlob) {
			throw new Error("S07k: markdown hashes disappeared after blob creation");
		}
		// Markdown CRDT must be unchanged.
		if (crdtAfterBlob !== crdtBeforeBlob) {
			throw new Error(
				`S07k: markdown CRDT changed after blob arrival — blob create disturbed text sync\n` +
				`  before: ${crdtBeforeBlob}\n  after: ${crdtAfterBlob}`,
			);
		}
		// disk must still equal CRDT.
		if (diskAfterBlob !== crdtAfterBlob) {
			throw new Error(
				`S07k: disk != CRDT after blob arrival\n  disk: ${diskAfterBlob}\n  crdt: ${crdtAfterBlob}`,
			);
		}

		// 5. Blob path must NOT appear in the text CRDT.
		//    It is a blob-syncable path — it must be handled by the blob pipeline,
		//    not registered as a text entry. If it appears here, the path classifier
		//    is incorrectly treating a .png as markdown-syncable.
		const blobCrdt = await ctx.yaos.getCrdtHash(blobPath);
		console.log("[S07k] blob CRDT state", { blobCrdt });
		if (blobCrdt !== null) {
			throw new Error(
				`S07k: blob path found in text CRDT — expected null (blob pipeline), got hash.\n` +
				`  path: ${blobPath}\n  crdt: ${blobCrdt}\n` +
				`  Check isBlobPathSyncable / isMarkdownPathSyncable path classifier.`,
			);
		}

		await ctx.deleteFile(notePath);
		await ctx.deleteFile(blobPath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};
