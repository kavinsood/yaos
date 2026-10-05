/**
 * b3-int D5: the editor of a brand-new note cannot acquire its body before the
 * create receipt ("root catalog has no active body"). Typing continues in the
 * unbound editor (disk ingest -> D5 fold/hold), and the binding retries once
 * the pending create lands instead of staying unbound until a layout event.
 */
import { strict as assert } from "node:assert";
import type { MarkdownView, Workspace } from "obsidian";
import { EditorBindingManager } from "../../legacy-src/sync/editorBinding";
import type { VaultSync } from "../../legacy-src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("editor-bind-after-create");

function fixture(settle: Promise<boolean> | undefined) {
	const waits: string[] = [];
	const manager = new EditorBindingManager(
		partialOf<VaultSync>({
			whenCreateSettled: settle === undefined ? undefined : (path: string) => { waits.push(path); return settle; },
		}),
		partialOf<Workspace>({}),
		false,
	);
	const binds: string[] = [];
	(manager as unknown as { bind: (view: MarkdownView) => void }).bind = (view) => { binds.push(view.file!.path); };
	const view = { file: { path: "New.md" } } as unknown as MarkdownView;
	const retry = (error: unknown) => manager["rebindAfterPendingCreate"](view, "Device", "leaf-1", "New.md", error);
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { manager, view, binds, waits, retry, flush };
}

s.test("a 'no active body' failure binds again once the pending create lands", async () => {
	let land!: (value: boolean) => void;
	const f = fixture(new Promise<boolean>((resolve) => { land = resolve; }));
	f.retry(new Error("root catalog has no active body for New.md"));
	assert.deepEqual(f.waits, ["New.md"]);
	await f.flush();
	assert.deepEqual(f.binds, [], "nothing binds before the receipt");
	land(true);
	await f.flush();
	assert.deepEqual(f.binds, ["New.md"]);
});

s.test("no retry for other failures, an uncreated note, a switched leaf, or an already-pending load", async () => {
	const other = fixture(Promise.resolve(true));
	other.retry(new Error("runtime closed during body acquisition"));
	await other.flush();
	assert.deepEqual(other.waits, []);
	assert.deepEqual(other.binds, []);

	const rejected = fixture(Promise.resolve(false));
	rejected.retry(new Error("root catalog has no active body for New.md"));
	await rejected.flush();
	assert.deepEqual(rejected.binds, []);

	const switched = fixture(Promise.resolve(true));
	switched.retry(new Error("root catalog has no active body for New.md"));
	(switched.view as unknown as { file: { path: string } }).file = { path: "Other.md" };
	await switched.flush();
	assert.deepEqual(switched.binds, []);

	const loading = fixture(Promise.resolve(true));
	loading.retry(new Error("root catalog has no active body for New.md"));
	(loading.manager["pendingBodyLoads"] as Map<string, unknown>).set("leaf-1", { path: "New.md", generation: 9 });
	await loading.flush();
	assert.deepEqual(loading.binds, []);

	const legacy = fixture(undefined);
	legacy.retry(new Error("root catalog has no active body for New.md"));
	await legacy.flush();
	assert.deepEqual(legacy.binds, []);
});

await s.done();
