/**
 * Per-note presence (P0c N4): body providers start with a null local
 * awareness state, on which `setLocalStateField` is a no-op, so a bound
 * editor never published its cursor. Binding now publishes a local state;
 * releasing the last editor of a note withdraws it. The root awareness (the
 * fallback when a note has no body session) carries vault presence and is
 * never cleared by an unbind.
 */
import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Workspace } from "obsidian";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("editor-body-presence");

function fixture() {
	const bodyAwareness = new Awareness(new Y.Doc());
	bodyAwareness.setLocalState(null);
	const rootAwareness = new Awareness(new Y.Doc());
	rootAwareness.setLocalStateField("user", { name: "vault presence" });
	let sessionAwareness: Awareness = bodyAwareness;
	const manager = new EditorBindingManager(
		partialOf<VaultSync>({
			provider: { awareness: rootAwareness } as never,
			getBodyAwareness: () => sessionAwareness as never,
		}),
		partialOf<Workspace>({}),
		false,
	);
	const publish = (user: unknown) => manager["publishBodyPresence"](sessionAwareness as never, user);
	const release = (path: string) => manager["releaseBodyPresence"](path);
	const bindings = manager["bindings"] as Map<string, { path: string }>;
	return {
		bodyAwareness,
		rootAwareness,
		publish,
		release,
		bindings,
		useRoot: () => { sessionAwareness = rootAwareness; },
		destroy: () => { bodyAwareness.destroy(); rootAwareness.destroy(); },
	};
}

s.test("binding publishes a local state on a body awareness that starts null", () => {
	const f = fixture();
	const user = { name: "Device A", color: "#123456" };
	assert.equal(f.bodyAwareness.getLocalState(), null);
	f.bodyAwareness.setLocalStateField("user", user);
	assert.equal(f.bodyAwareness.getLocalState(), null, "the old call is a no-op on a null state");
	f.publish(user);
	assert.deepEqual(f.bodyAwareness.getLocalState(), { user, cursor: null });
	assert.ok(
		f.bodyAwareness.getStates().has(f.bodyAwareness.clientID),
		"this device is now visible to peers of the note",
	);
	// yCollab's remote-selection plugin writes the cursor into that state.
	f.bodyAwareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
	assert.deepEqual(f.bodyAwareness.getLocalState()?.cursor, { anchor: 1, head: 1 });
	f.publish({ ...user, name: "Device A (renamed)" });
	assert.equal(
		(f.bodyAwareness.getLocalState()?.user as { name: string }).name,
		"Device A (renamed)",
		"a repeat bind only updates the user field",
	);
	assert.deepEqual(f.bodyAwareness.getLocalState()?.cursor, { anchor: 1, head: 1 });
	f.destroy();
});

s.test("releasing the last editor of a note withdraws its presence", () => {
	const f = fixture();
	f.publish({ name: "Device A" });
	f.bindings.set("leaf-2", { path: "Note.md" });
	f.release("Note.md");
	assert.notEqual(f.bodyAwareness.getLocalState(), null, "another editor still shows the note");
	f.bindings.clear();
	f.release("Note.md");
	assert.equal(f.bodyAwareness.getLocalState(), null);
	assert.equal(f.bodyAwareness.getStates().has(f.bodyAwareness.clientID), false, "gone for peers too");
	f.destroy();
});

s.test("the root awareness fallback is never cleared by an unbind", () => {
	const f = fixture();
	f.useRoot();
	f.publish({ name: "Device A" });
	f.release("Note.md");
	assert.notEqual(f.rootAwareness.getLocalState(), null, "vault presence survives");
	f.destroy();
});

await s.done();
