/**
 * INV-EDIT-02 — heal() contamination after recovery integration test.
 */

import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { EditorBindingManager } from "../src/sync/editorBinding";
import { TFile, MarkdownView } from "obsidian";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

// ── Test 1: heal() contamination (S-B) — FIXED ────────────────────────────────
console.log("\n--- Test 1: heal() contamination (S-B) — FIXED ---");
(async () => {
	const path = "test.md";
	const diskContent = "v2 (disk)";
	const staleCrdt = "v1 (stale)";
	const staleEditor = "v1 (stale)";

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, staleCrdt);

	const file = makeTFile(path);
	const fakeCm = {
		state: {
			field: () => ({}),
			doc: { length: staleEditor.length },
		},
		dispatch: () => {},
	};
	const view = {
		file,
		editor: {
			getValue: () => staleEditor,
			cm: fakeCm,
		},
		leaf: { id: "leaf-1" },
	} as any;
	Object.setPrototypeOf(view, MarkdownView.prototype);

	const fakeVaultSync = {
		provider: {
			__kind: "fake-provider",
			awareness: {
				setLocalStateField: () => {},
				getLocalState: () => ({}),
				on: () => {},
				off: () => {},
			},
		},
		ydoc: doc,
		getTextForPath: () => ytext,
		getFileIdForText: () => "file-1",
		getFileId: () => "file-1",
		serverAckTracker: { withActiveOpId: (_id: any, cb: any) => cb() },
		ensureFile: (path: string, content: string) => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, content);
			return ytext;
		},
	};

	const editorBindings = new EditorBindingManager(
		fakeVaultSync as any,
		false,
	);
	(editorBindings as any).getCmView = () => fakeCm;
	editorBindings.bind(view as any, "device");
	const b = (editorBindings as any).bindings.get("leaf-1");
	if (b) b.lastEditorChangeAtMs = 0;

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: 10, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === path ? file : null),
		},
		workspace: {
			iterateAllLeaves: (cb: any) => {
				cb({ view });
			},
		},
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () =>
			({
				maxFileSizeBytes: 0,
				maxFileSizeKB: 0,
				excludePatterns: [],
				externalEditPolicy: "always",
			}) as any,
		getVaultSync: () => fakeVaultSync as any,
		getDiskMirror: () =>
			({
				updateDiskIndexForPath: async () => {},
				isPreservedUnresolved: () => false,
				recordRepairEcho: async () => {},
			}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
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

	// Trigger disk-authority recovery (IDLE branch)
	// We use "v2 (disk)" on disk, "v1 (stale)" in CRDT and Editor.
	await (controller as any).syncFileFromDisk(file, "modify");

	assert(
		ytext.toString() === diskContent,
		`after recovery: CRDT equals disk content (content="${ytext.toString()}")`,
	);

	const isActive = controller.isDiskAuthorityRecoveryActive(path);
	assert(isActive, "recovery lock is active");

	// Simulate concurrent heal() call in the same tick.
	editorBindings.heal(view as any, "device", "concurrent-check", (p) =>
		controller.isDiskAuthorityRecoveryActive(p),
	);

	assert(
		ytext.toString() === diskContent,
		`SUCCESS: heal() skipped overwrite (content is still "${ytext.toString()}")`,
	);

	doc.destroy();
	process.exit(failed > 0 ? 1 : 0);
})();
