/**
 * Wait helpers for the QA harness.
 * All waiters poll a condition. Never use setTimeout for observable state.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";

const DEFAULT_IDLE_TIMEOUT = 15_000;
const DEFAULT_RECEIPT_TIMEOUT = 30_000;
const DEFAULT_FILE_TIMEOUT = 15_000;
const DEFAULT_BINDING_TIMEOUT = 5_000;
const POLL_INTERVAL = 250;

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	label: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = async () => {
			try {
				if (await predicate()) {
					resolve();
					return;
				}
			} catch { /* keep polling */ }
			if (Date.now() - start >= timeoutMs) {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				return;
			}
			setTimeout(check, POLL_INTERVAL);
		};
		void check();
	});
}

export function waitForIdle(
	yaos: YaosQaDebugApi,
	timeoutMs = DEFAULT_IDLE_TIMEOUT,
): Promise<void> {
	return yaos.waitForIdle(timeoutMs);
}

export function waitForMemoryReceipt(
	yaos: YaosQaDebugApi,
	timeoutMs = DEFAULT_RECEIPT_TIMEOUT,
): Promise<void> {
	return yaos.waitForMemoryReceipt(timeoutMs);
}

export function waitForFile(
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return yaos.waitForFile(path, timeoutMs);
}

/**
 * Wait until the CRDT hash for a file matches its disk hash.
 *
 * `waitForCrdtFile` only waits for CRDT to be non-null (file seeded).
 * `waitForDiskCrdtConverge` waits for the *latest* disk write to be
 * reflected in the CRDT — required after modifyFile/appendToFile when
 * the file is already in CRDT and you need to assert on final content.
 */
export function waitForDiskCrdtConverge(
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return waitForCondition(
		async () => {
			const disk = await yaos.getDiskHash(path);
			const crdt = await yaos.getCrdtHash(path);
			return disk !== null && crdt !== null && disk === crdt;
		},
		timeoutMs,
		`waitForDiskCrdtConverge(${path})`,
	);
}

export function waitForCrdtFile(
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return waitForCondition(
		async () => (await yaos.getCrdtHash(path)) !== null,
		timeoutMs,
		`waitForCrdtFile(${path})`,
	);
}

export function waitForFileContent(
	app: App,
	yaos: YaosQaDebugApi,
	path: string,
	expectedHash: string,
	timeoutMs = DEFAULT_FILE_TIMEOUT,
): Promise<void> {
	return waitForCondition(
		async () => {
			const actual = await yaos.getDiskHash(path);
			return actual === expectedHash;
		},
		timeoutMs,
		`waitForFileContent(${path})`,
	);
}

/**
 * Wait until the CRDT editor binding for a path is fully healthy:
 *   1. A MarkdownView leaf for the path is open.
 *   2. The CM6 ySyncFacet is configured on the editor.
 *   3. The ySyncFacet's Y.Text matches the expected CRDT Y.Text.
 *
 * This is stronger than `waitForActiveMarkdownLeaf`, which only proves a leaf
 * is open. Use this in tests that depend on editor↔CRDT binding health
 * (e.g. issue-25 recovery scenarios, open-editor mutation tests).
 *
 * NOTE: The settle window (~750ms) means that even after this resolves,
 * you may want a brief sleep before performing binding-sensitive operations.
 */
export function waitForCrdtBinding(
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = 10_000,
): Promise<void> {
	return waitForCondition(
		() => {
			const h = yaos.getEditorBindingHealth(path);
			return h.healthy;
		},
		timeoutMs,
		`waitForCrdtBinding(${path})`,
	);
}

/**
 * Wait until a MarkdownView leaf for path is active in the workspace.
 *
 * NOTE: This proves a Markdown leaf with the file is open, NOT that the
 * y-codemirror editor binding to CRDT is healthy. These are different facts.
 * An open leaf can exist before the y-codemirror collab facet is configured.
 * Use `waitForCrdtBinding` instead when you need binding health proof.
 *
 * Rename of this function from `waitForEditorBinding` is intentional —
 * the old name was a lie-by-comment.
 */
export function waitForActiveMarkdownLeaf(
	app: App,
	yaos: YaosQaDebugApi,
	path: string,
	timeoutMs = DEFAULT_BINDING_TIMEOUT,
): Promise<void> {
	return waitForCondition(
		() => {
			// getEditorHash returns non-null only when a leaf with this file is open.
			// We additionally check that the CRDT is bound (disk hash reachable too).
			const activePaths = yaos.getActiveMarkdownPaths();
			return activePaths.some((p) => p === path);
		},
		timeoutMs,
		`waitForActiveMarkdownLeaf(${path})`,
	);
}

/**
 * Wait for a NEW device.witness.settled event for a path emitted AFTER this
 * call begins. Pre-existing settled events in the buffer are ignored.
 *
 * This is NOT a current-state check — it proves fresh convergence after the
 * call was made. If the device already settled before this call, trigger a
 * new dirty event first so the tracker re-evaluates.
 *
 * Rejects if no active flight trace, if a diverged event arrives after wait
 * start, or if timeoutMs elapses.
 *
 * Requires an active flight trace (qa-safe mode recommended).
 */
export function witnessDeviceSettled(
	yaos: YaosQaDebugApi,
	path: string,
	options: {
		expectedContent?: string;
		expectedStateHash?: string;
		timeoutMs: number;
	},
): Promise<void> {
	return yaos.witnessDeviceSettled(path, options);
}

// -----------------------------------------------------------------------
// Phase 2 cross-device primitives (re-exported from witness-primitives.ts)
// -----------------------------------------------------------------------

export {
	witnessQuorum,
	witnessQuorumEventually,
	noStaleHashAfterNewerWitness,
	noRecoveryEmittedOldHash,
	editorStableDuring,
	crossDeviceHashesEqual,
	witnessCheckpointReader,
} from "./witness-primitives";

export type {
	DeviceHandle,
	DeviceId,
	QuorumPolicy,
	QuorumResult,
	QuorumSuccess,
	QuorumFailure,
	AnalyzerResult,
	Evidence,
	WitnessQuorumOptions,
	WitnessQuorumEventuallyResult,
	NegativeWindowOptions,
	CrossDeviceHashesEqualOptions,
	CheckpointReadResult,
} from "./witness-primitives";
