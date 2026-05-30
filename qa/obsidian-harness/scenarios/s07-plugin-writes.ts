/**
 * S07 Plugin-generated writes / Templater stress suite.
 *
 * Scenarios:
 *   S07a  create-empty-then-fill
 *   S07b  async delayed template writes
 *   S07c  open-editor template mutation (confirms #25 coverage)
 *   S07e  frontmatter race
 *   S07f  invalid intermediate → valid final
 *   S07h  multi-file burst (25 files)
 *
 * The core invariant for all:
 *   Programmatic plugin writes are first-class local user intent.
 *   YAOS must either sync them exactly, preserve conflict safely,
 *   or quarantine clearly. It must not drop, resurrect, partially
 *   merge, or silently overwrite them.
 */

import type { QaScenario } from "../types";

const FOLDER = "QA-s07";

function p(name: string): string {
	return `${FOLDER}/${name}-${Date.now().toString(36)}.md`;
}

// -----------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------

const YAML_FRONTMATTER = (title: string, status: string, extra = "") => [
	"---",
	`title: "${title}"`,
	"created: 2026-05-14",
	`status: ${status}`,
	...(extra ? [extra] : []),
	"---",
	"",
].join("\n");

const BODY = `## Notes

This file was created programmatically by a template plugin.

### Tasks

- [ ] Review content
- [ ] Update status field
- [ ] Mark as complete

### References

See [[Daily Log]] for context.
`;

const FULL_NOTE = (title: string, status: string) =>
	YAML_FRONTMATTER(title, status) + BODY + "\n";

// -----------------------------------------------------------------------
// S07a — create-empty-then-fill
//
// Templater pattern: create new note, then insert template content.
// The race: CRDT gets seeded from empty content, then must update
// when the full content is written.
// Bug class: remote device receives empty note as final state.
// -----------------------------------------------------------------------

export const s07aCreateEmptyThenFill: QaScenario = {
	id: "s07a-create-empty-then-fill",
	title: "S07a: Create empty file then fill with content (Templater golden path)",
	tags: ["s07a", "plugin-writes", "templater-class", "create-fill", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = p("s07a-empty-fill");
		const finalContent = FULL_NOTE("S07a Test Note", "in-progress");

		// 1. Create empty file (Obsidian new-note default).
		await ctx.createFile(path, "");
		await ctx.waitForCrdtFile(path, 15000);
		await ctx.waitForIdle(5000);

		// 2. Verify empty state was seeded in CRDT.
		const crdtEmpty = await ctx.yaos.getCrdtHash(path);
		const diskEmpty = await ctx.yaos.getDiskHash(path);
		if (!crdtEmpty || !diskEmpty) {
			throw new Error("S07a: could not read empty-state hashes");
		}
		console.log("[S07a] empty state seeded", { crdtEmpty, diskEmpty });

		// 3. Fill with full content (template execution).
		await ctx.modifyFile(path, finalContent);
		// waitForCrdtFile returns as soon as CRDT is non-null — already true.
		// Use waitForDiskCrdtConverge to wait until the modify event is processed.
		await ctx.waitForDiskCrdtConverge(path, 15000);
		await ctx.waitForIdle(5000);

		// 4. POSTCONDITION: disk == CRDT, content is final (not empty).
		const diskFinal = await ctx.yaos.getDiskHash(path);
		const crdtFinal = await ctx.yaos.getCrdtHash(path);
		console.log("[S07a] final state", { diskFinal, crdtFinal });

		if (!diskFinal || !crdtFinal) {
			throw new Error("S07a: could not read final hashes");
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07a: disk != CRDT after fill\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		// Final content must differ from empty state — CRDT updated.
		if (crdtFinal === crdtEmpty) {
			throw new Error("S07a: CRDT was not updated after fill — still shows empty-state hash");
		}

		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07b — async delayed template writes
//
// Template writes header, waits, writes body, waits, appends footer.
// Bug class: receipt or CRDT only captures an early partial state.
// -----------------------------------------------------------------------

export const s07bDelayedTemplateWrites: QaScenario = {
	id: "s07b-delayed-template-writes",
	title: "S07b: Async delayed template writes (header → delay → body → delay → footer)",
	tags: ["s07b", "plugin-writes", "templater-class", "async-writes", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = p("s07b-delayed");
		const header = YAML_FRONTMATTER("S07b Template", "draft") + "\n## Header\n\nCreated by template.\n";
		const withBody = header + "\n## Body\n\nFilled after async delay.\n";
		const withFooter = withBody + "\n---\n*Generated by template at 2026-05-14.*\n";

		// 1. Create with header only.
		await ctx.createFile(path, header);
		await ctx.waitForCrdtFile(path, 15000);
		await ctx.waitForIdle(5000);
		const crdtAfterHeader = await ctx.yaos.getCrdtHash(path);
		console.log("[S07b] header written", { crdtAfterHeader });

		// 2. Simulate async delay (user prompt, API call, etc.).
		await ctx.sleep(1500);

		// 3. Write body.
		await ctx.modifyFile(path, withBody);
		await ctx.waitForDiskCrdtConverge(path, 15000);
		await ctx.waitForIdle(5000);
		const crdtAfterBody = await ctx.yaos.getCrdtHash(path);
		if (crdtAfterBody === crdtAfterHeader) {
			throw new Error("S07b: CRDT did not update after body write");
		}
		console.log("[S07b] body written", { crdtAfterBody });

		// 4. Second async delay.
		await ctx.sleep(1500);

		// 5. Append footer.
		await ctx.modifyFile(path, withFooter);
		await ctx.waitForDiskCrdtConverge(path, 15000);
		await ctx.waitForIdle(5000);

		// 6. POSTCONDITION: disk == CRDT == final state (not header, not body).
		const diskFinal = await ctx.yaos.getDiskHash(path);
		const crdtFinal = await ctx.yaos.getCrdtHash(path);
		console.log("[S07b] final state", { diskFinal, crdtFinal });

		if (!diskFinal || !crdtFinal) {
			throw new Error("S07b: could not read final hashes");
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07b: disk != CRDT after footer\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		// CRDT must track final state, not an intermediate one.
		if (crdtFinal === crdtAfterHeader || crdtFinal === crdtAfterBody) {
			throw new Error("S07b: CRDT is stuck at intermediate state, not final footer version");
		}

		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07c — open-editor template mutation
//
// File is open in editor. Template modifies the same file from outside
// the editor (via vault API, as Templater does). YAOS must use the
// open-idle recovery path and not loop or duplicate content.
// This confirms that #25 fixes cover the Templater-trigger class.
// -----------------------------------------------------------------------

export const s07cOpenEditorTemplateMutation: QaScenario = {
	id: "s07c-open-editor-template-mutation",
	title: "S07c: Template mutates open file (confirms #25 open-idle recovery coverage)",
	tags: ["s07c", "plugin-writes", "templater-class", "editor-bound", "open-idle", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = p("s07c-editor-mutation");
		const initial = FULL_NOTE("S07c Initial", "draft");
		const afterTemplate = FULL_NOTE("S07c After Template", "in-progress");

		// 1. Create and open.
		await ctx.createFile(path, initial);
		await ctx.waitForCrdtFile(path, 15000);
		await ctx.waitForIdle(5000);
		await ctx.openFile(path);
		await ctx.waitForCrdtBinding(path, 8000);
		await ctx.sleep(500); // post-bind settle guard for autosave

		const baselineHash = await ctx.yaos.getDiskHash(path);
		console.log("[S07c] baseline (editor open)", { baselineHash });

		// 2. Template mutates the file via vault API while editor is open.
		//    This simulates: Templater runs tp.file.cursor_append() or modifies metadata.
		await ctx.modifyFile(path, afterTemplate);

		// 3. Wait for the open-idle recovery path to run.
		await ctx.waitForIdle(15000);
		await ctx.sleep(1000); // let autosave settle

		// 4. POSTCONDITION.
		const diskFinal = await ctx.yaos.getDiskHash(path);
		const crdtFinal = await ctx.yaos.getCrdtHash(path);
		const editorFinal = await ctx.yaos.getEditorHash(path);
		console.log("[S07c] final state", { diskFinal, crdtFinal, editorFinal });

		if (!diskFinal || !crdtFinal) {
			throw new Error("S07c: could not read final hashes");
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07c: disk != CRDT after template mutation\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		// Content must reflect the template write, not the original.
		if (diskFinal === baselineHash) {
			throw new Error("S07c: disk/CRDT did not update after template mutation — still initial content");
		}

		// 5. File must not have grown unboundedly (no loop).
		const finalFile = ctx.app.vault.getAbstractFileByPath(path);
		const finalSize = (finalFile as unknown as { stat?: { size?: number } })?.stat?.size ?? 0;
		const expectedSize = new TextEncoder().encode(afterTemplate).length;
		if (finalSize > expectedSize + 512) {
			throw new Error(`S07c: file size grew beyond expected (${finalSize} > ${expectedSize} + 512) — possible loop`);
		}

		await ctx.closeFile(path);
		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07e — frontmatter race
//
// Template writes YAML; then a second programmatic write modifies the
// same frontmatter while the file is open in the editor.
// Correct behavior: final YAML is valid (no duplicate keys, no broken
// fences, no infinite guard loop), disk == CRDT.
// -----------------------------------------------------------------------

const FM_INITIAL = [
	"---",
	'title: "S07e Test"',
	"created: 2026-05-14",
	"status: draft",
	"---",
	"",
	"## Content",
	"",
	"Initial body.",
	"",
].join("\n");

const FM_TEMPLATE_WRITE = [
	"---",
	'title: "S07e Test"',
	"created: 2026-05-14",
	"updated: 2026-05-14",
	"status: in-progress",
	"tags:",
	"  - daily",
	"---",
	"",
	"## Content",
	"",
	"Initial body.",
	"",
].join("\n");

const FM_SECOND_WRITE = [
	"---",
	'title: "S07e Test"',
	"created: 2026-05-14",
	"updated: 2026-05-14",
	"status: in-progress",
	"tags:",
	"  - daily",
	"done: false",
	"priority: high",
	"---",
	"",
	"## Content",
	"",
	"Initial body.",
	"",
].join("\n");

export const s07eFrontmatterRace: QaScenario = {
	id: "s07e-frontmatter-race",
	title: "S07e: Frontmatter race — template + plugin writes YAML while editor is open",
	tags: ["s07e", "plugin-writes", "templater-class", "frontmatter", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = p("s07e-fm-race");

		// 1. Create file with initial YAML.
		await ctx.createFile(path, FM_INITIAL);
		await ctx.waitForCrdtFile(path, 15000);
		await ctx.waitForIdle(5000);

		// 2. Open in editor.
		await ctx.openFile(path);
		await ctx.waitForCrdtBinding(path, 8000);
		await ctx.sleep(500); // post-bind settle guard

		const hashBefore = await ctx.yaos.getDiskHash(path);
		console.log("[S07e] baseline", { hashBefore });

		// 3. First external write — template adds "updated" + "tags" to YAML.
		await ctx.modifyFile(path, FM_TEMPLATE_WRITE);
		await ctx.sleep(500);

		// 4. Second external write — another plugin (Tasks, Dataview) adds more fields.
		await ctx.modifyFile(path, FM_SECOND_WRITE);
		await ctx.waitForIdle(15000);
		await ctx.sleep(1500);

		// 5. POSTCONDITION: disk == CRDT, content is the final write (not first, not initial).
		const diskFinal = await ctx.yaos.getDiskHash(path);
		const crdtFinal = await ctx.yaos.getCrdtHash(path);
		const editorFinal = await ctx.yaos.getEditorHash(path);
		console.log("[S07e] final state", { diskFinal, crdtFinal, editorFinal });

		if (!diskFinal || !crdtFinal) {
			throw new Error("S07e: could not read final hashes");
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07e: disk != CRDT after frontmatter race\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		if (diskFinal === hashBefore) {
			throw new Error("S07e: disk/CRDT did not update — still shows initial content");
		}

		// 6. Verify the final content on disk is actually valid YAML.
		const finalFile = ctx.app.vault.getFileByPath(path);
		if (!finalFile) throw new Error("S07e: file not found on disk");
		const finalContent = await ctx.app.vault.read(finalFile);
		// Quick sanity: must start with --- and have a matching close ---
		const fences = (finalContent.match(/^---\s*$/mg) ?? []).length;
		if (fences < 2) {
			throw new Error(`S07e: final YAML appears malformed — only ${fences} fence(s) found`);
		}

		await ctx.closeFile(path);
		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07f — invalid intermediate → valid final
//
// Template writes malformed YAML (no closing fence), then overwrites
// with valid final content. YAOS must NOT permanently quarantine the
// file after seeing the invalid intermediate state.
// -----------------------------------------------------------------------

const FM_INVALID = [
	"---",
	'title: "S07f Broken"',
	"created: 2026-05-14",
	// intentionally missing closing ---
	"",
	"## Content",
	"",
	"Body after broken frontmatter.",
].join("\n");

const FM_VALID_FINAL = [
	"---",
	'title: "S07f Fixed"',
	"created: 2026-05-14",
	"status: complete",
	"---",
	"",
	"## Content",
	"",
	"Body after valid frontmatter.",
	"",
].join("\n");

export const s07fInvalidIntermediateValidFinal: QaScenario = {
	id: "s07f-invalid-intermediate-valid-final",
	title: "S07f: Malformed YAML intermediate → valid final (no permanent quarantine)",
	tags: ["s07f", "plugin-writes", "frontmatter", "quarantine", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = p("s07f-invalid-fm");

		// 1. Create with valid initial content.
		await ctx.createFile(path, FM_VALID_FINAL.replace("Fixed", "Initial").replace("complete", "draft"));
		await ctx.waitForCrdtFile(path, 15000);
		await ctx.waitForIdle(5000);
		const hashInitial = await ctx.yaos.getDiskHash(path);
		console.log("[S07f] initial state", { hashInitial });

		// 2. Write invalid YAML (no closing fence) — simulates template half-write.
		await ctx.modifyFile(path, FM_INVALID);
		await ctx.waitForIdle(8000);
		const hashInvalid = await ctx.yaos.getDiskHash(path);
		console.log("[S07f] after invalid write", { hashInvalid });

		// 3. Write valid final content — YAOS must accept it.
		await ctx.modifyFile(path, FM_VALID_FINAL);
		// Use waitForDiskCrdtConverge: CRDT already non-null so waitForCrdtFile would return immediately.
		await ctx.waitForDiskCrdtConverge(path, 15000);
		await ctx.waitForIdle(8000);

		// 4. POSTCONDITION: disk == CRDT == final (not quarantined at invalid state).
		const diskFinal = await ctx.yaos.getDiskHash(path);
		const crdtFinal = await ctx.yaos.getCrdtHash(path);
		console.log("[S07f] final state", { diskFinal, crdtFinal });

		if (!diskFinal || !crdtFinal) {
			throw new Error("S07f: could not read final hashes");
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07f: disk != CRDT after valid final write\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		// The critical check: CRDT must NOT be stuck at the invalid intermediate state.
		if (crdtFinal === hashInvalid) {
			throw new Error(
				"S07f: CRDT is stuck at the invalid intermediate state — " +
				"valid final write was not synced (possible permanent quarantine)",
			);
		}
		if (crdtFinal === hashInitial) {
			throw new Error("S07f: CRDT reverted to initial state — invalid write may have triggered a rollback");
		}

		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07h — multi-file burst (create + modify 25 files concurrently)
//
// One template command creates 25 files and fills them — all at once.
// Bug class: watcher batching/coalescing drops events, leaving files
// unsynced.
// -----------------------------------------------------------------------

const BURST_FILE_COUNT = 25;
const BURST_CONTENT = (i: number) => [
	"---",
	`title: "S07h File ${i}"`,
	`index: ${i}`,
	"status: active",
	"---",
	"",
	`## File ${i}`,
	"",
	"Created by bulk template run.",
	"",
	`Index: ${i}`,
].join("\n");

export const s07hMultiFileBurst: QaScenario = {
	id: "s07h-multi-file-burst",
	title: `S07h: Multi-file burst — ${BURST_FILE_COUNT} concurrent creates + fills (watcher storm)`,
	tags: ["s07h", "plugin-writes", "templater-class", "burst", "bulk", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const paths = Array.from({ length: BURST_FILE_COUNT }, (_, i) =>
			`${FOLDER}/s07h-burst-${ts}-${String(i).padStart(2, "0")}.md`,
		);
		const contents = paths.map((_, i) => BURST_CONTENT(i));

		// 1. Create all files concurrently (watcher storm).
		await Promise.all(paths.map((path, i) => ctx.createFile(path, contents[i]!)));
		console.log(`[S07h] created ${BURST_FILE_COUNT} files concurrently`);

		// 2. Wait for all to appear in CRDT (in parallel).
		await Promise.all(paths.map((path) => ctx.waitForCrdtFile(path, 30000)));
		await ctx.waitForIdle(15000);
		console.log("[S07h] all files in CRDT");

		// 3. POSTCONDITION: every file has disk == CRDT.
		const results = await Promise.all(
			paths.map(async (path) => ({
				path,
				disk: await ctx.yaos.getDiskHash(path),
				crdt: await ctx.yaos.getCrdtHash(path),
			})),
		);

		const mismatches = results.filter((r) => !r.disk || !r.crdt || r.disk !== r.crdt);
		if (mismatches.length > 0) {
			const detail = mismatches
				.slice(0, 5)
				.map((r) => `  ${r.path.split("/").pop()}: disk=${r.disk?.slice(0, 8) ?? "null"} crdt=${r.crdt?.slice(0, 8) ?? "null"}`)
				.join("\n");
			throw new Error(
				`S07h: ${mismatches.length}/${BURST_FILE_COUNT} files did not converge:\n${detail}`,
			);
		}
		console.log(`[S07h] all ${BURST_FILE_COUNT} files converged (disk == CRDT)`);

		// 4. Cleanup.
		await Promise.all(paths.map((path) => ctx.deleteFile(path)));
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},
};
