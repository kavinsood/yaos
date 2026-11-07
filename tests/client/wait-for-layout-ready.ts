/**
 * Tests for waitForWorkspaceLayoutReady.
 *
 * Issue #77: startup reconciliation ran before Obsidian's workspace had
 * restored open MarkdownView leaves, so isOpenOrBound (which reads
 * app.workspace.iterateAllLeaves) was a false negative for a note the user
 * was actively typing in. The closed-file planner then treated the note as
 * closed and, with no baseline hash yet, defaulted to CRDT-wins — dumping
 * the user's in-progress disk content into a conflict artifact.
 *
 * This helper gates the first startup reconciliation on
 * workspace.layoutReady, mirroring the same pattern already used by
 * AttachmentOrchestrator's download gate (src/runtime/attachmentOrchestrator.ts).
 */

import { waitForWorkspaceLayoutReady } from "../../src/runtime/waitForLayoutReady";
import { suite } from "../harness.ts";

const s = suite("wait-for-layout-ready");

interface FakeWorkspace {
	layoutReady: boolean;
	onLayoutReady: (cb: () => void) => void;
}

function makeWorkspace(layoutReady: boolean): { workspace: FakeWorkspace; fire: () => void } {
	let pending: (() => void) | null = null;
	const workspace: FakeWorkspace = {
		layoutReady,
		onLayoutReady: (cb: () => void) => {
			pending = cb;
		},
	};
	return { workspace, fire: () => pending?.() };
}

s.section("Test 1: layout already ready resolves immediately, without registering a callback");
{
	const { workspace, fire } = makeWorkspace(true);
	let resolved = false;
	const promise = waitForWorkspaceLayoutReady(workspace).then(() => {
		resolved = true;
	});
	await promise;
	s.check(resolved, "resolves immediately when layoutReady is already true");
	// fire() is a no-op here since onLayoutReady was never called — this just
	// documents that calling it is harmless if a test does so accidentally.
	fire();
}

s.section("Test 2: layout not ready waits for onLayoutReady callback");
{
	const { workspace, fire } = makeWorkspace(false);
	let resolved = false;
	const promise = waitForWorkspaceLayoutReady(workspace).then(() => {
		resolved = true;
	});

	// Give the promise a microtask turn — it must NOT resolve yet.
	await Promise.resolve();
	s.check(!resolved, "does not resolve before onLayoutReady fires");

	fire();
	await promise;
	s.check(resolved, "resolves once onLayoutReady fires");
}

s.section("Test 3: registers exactly one onLayoutReady callback per call");
{
	let registrations = 0;
	const workspace: FakeWorkspace = {
		layoutReady: false,
		onLayoutReady: (cb: () => void) => {
			registrations++;
			cb();
		},
	};
	await waitForWorkspaceLayoutReady(workspace);
	s.check(registrations === 1, "onLayoutReady is registered exactly once");
}

await s.done();
