import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { editorInfoField, MarkdownView, Notice, type MarkdownFileInfo, type Workspace } from "obsidian";
import type { SyncRuntimePort } from "./vaultSync";
import { applyDiffToYText } from "./diff";
import type { TraceRecord } from "../observability/traceContext";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import { ORIGIN_EDITOR_HEALTH_HEAL } from "./origins";
import { awarenessCursorUser } from "../utils/deviceCursorColor";

/**
 * Manages per-editor CM6 bindings via yCollab.
 *
 * Strategy:
 *   - One global Compartment registered via registerEditorExtension.
 *   - When a MarkdownView is opened/focused, we reconfigure that
 *     editor's compartment to yCollab(ytext, awareness, {undoManager}).
 *   - When the view is closed or switches files, reconfigure to empty.
 */

/**
 * Freshly reconfigured editors can briefly report no ySyncFacet even though
 * the compartment update is still settling into the live view state.
 */
const BASE_BINDING_SETTLE_WINDOW_MS = 750;
const FAST_SWITCH_BINDING_SETTLE_WINDOW_MS = 1600;
const FAST_SWITCH_WINDOW_MS = 2000;
const POST_BIND_HEALTH_GRACE_MS = 100;
const LIVE_UPDATE_HEALTH_RETRY_DELAY_MS = 120;
const CM_RESOLVE_RETRY_DELAY_MS = 100;
const CM_RESOLVE_MAX_RETRIES = 8;

/** Why a getCmView() call failed to resolve an editor, for degraded traces. */
interface CmResolveFailure {
	reason: "no-known-cm-views" | "no-container-match" | "ambiguous";
	knownCmViews: number;
	containerMatches: number;
	infoMatches: number;
}

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	view: MarkdownView;
	path: string;
	undoManager: Y.UndoManager;
	cm: EditorView;
	cmId: string;
	fileId?: string;
	lastBoundAt: string;
	lastBoundAtMs: number;
	lastEditorChangeAtMs: number;
	settleWindowMs: number;
}

export interface BindingDebugInfo {
	leafId: string;
	path: string;
	fileId?: string;
	storedCmId: string;
	liveCmId: string | null;
	cmMatches: boolean;
	lastBoundAt: string;
}

export interface CollabDebugInfo {
	leafId: string;
	path: string;
	cmId: string | null;
	hasSyncFacet: boolean;
	awarenessMatchesProvider: boolean | null;
	yTextMatchesExpected: boolean | null;
	undoManagerMatchesFacet: boolean | null;
	facetFileId: string | null;
	expectedFileId: string | null;
	facetTextLength: number | null;
	cmDocLength: number | null;
}

export interface BindingHealthStatus {
	bound: boolean;
	healthy: boolean;
	settling: boolean;
	issues: string[];
}

interface BindingHealthCheck {
	healthy: boolean;
	settling: boolean;
	issues: string[];
	deferredIssues: string[];
}

interface BindingTarget {
	ytext: Y.Text;
	fileId?: string;
}

/**
 * Harness-only gate for pausing editor<->CRDT propagation on specific paths.
 * Supplied by the QA harness via the EditorBindingManager constructor.
 * Absent in production. Default: all paths are unpaused.
 *
 * The gate owns the mutable paused-path set. The EditorBindingManager
 * only reads from it (isPaused) — it does not mutate it.
 *
 * The harness must call reconfigureBindingForPath after mutating the set
 * so that the CodeMirror compartment is updated.
 */
export interface BindingPropagationGate {
	/** Returns true if propagation for this path is currently paused. */
	isPaused(path: string): boolean;
	/**
	 * Called by EditorBindingManager to expose a reconfigure hook for
	 * the harness. The harness calls reconfigure(path, deviceName) after
	 * pausing or resuming to apply the CM extension change.
	 */
	registerReconfigureHook(
		fn: (path: string, deviceName: string, action: "pause" | "resume") => void,
	): void;
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();
	private knownCmViews = new Set<EditorView>();
	private cmIds = new WeakMap<EditorView, string>();
	private cmToLeafId = new WeakMap<EditorView, string>();
	private cmCounter = 0;
	private pendingHealthChecks = new Map<string, number>();
	private healthWorkInFlight = new Set<string>();
	private lastDeviceName = "unknown";
	private cmDegradedWarned = false;
	private cmResolveAttempts = new Map<string, number>();
	private pendingCmResolveRetries = new Map<string, number>();
	private pendingBodyLoads = new Map<string, { path: string; generation: number }>();
	private bodyLeases = new Map<string, string>();
	private bodyLoadGeneration = 0;
	/**
	 * Why the last getCmView() call returned null. Attached to the degraded
	 * trace so field reports separate "no editor ever registered" (our CM6
	 * extension reached this editor too late) from "registered but
	 * unclaimable" (ambiguous container).
	 */
	private lastCmResolveFailure: CmResolveFailure | null = null;

	private readonly debug: boolean;

	constructor(
		private vaultSync: SyncRuntimePort,
		private readonly workspace: Workspace,
		debug: boolean,
		private trace?: TraceRecord,
		private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void,
		private readonly bindingPropagationGate?: BindingPropagationGate,
	) {
		this.debug = debug;
		// Register the reconfigure hook so the harness can trigger CM extension
		// changes after mutating the paused-path set.
		bindingPropagationGate?.registerReconfigureHook((path, deviceName, action) => {
			for (const [leafId, binding] of this.bindings) {
				if (binding.path !== path) continue;
				if (action === "pause") {
					try {
						binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
					} catch {
						// view may be destroyed
					}
				} else {
					// Resume: re-apply yCollab via repair.
					this.repair(binding.view, deviceName, "harness-resume-binding-propagation");
				}
				void leafId;
			}
		});
	}

	/**
	 * Returns the base extension to register globally.
	 * Starts as empty; reconfigured per-editor when a note is opened.
	 */
	getBaseExtension(): Extension {
		const registerKnownCmView = this.registerKnownCmView.bind(this);
		const handleLiveEditorUpdate = this.handleLiveEditorUpdate.bind(this);
		const unregisterKnownCmView = this.unregisterKnownCmView.bind(this);
		return [
			this.compartment.of([]),
			ViewPlugin.fromClass(
				class {
					constructor(readonly view: EditorView) {
						registerKnownCmView(view);
					}

					update(update: ViewUpdate): void {
						handleLiveEditorUpdate(update);
					}

					destroy(): void {
						unregisterKnownCmView(this.view);
					}
				},
			),
		];
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;

		// Only bind .md files
		if (!file.path.endsWith(".md")) return;

		const leafId = view.leaf.id ?? file.path;
		const tracked = this.bindings.get(leafId);
		if (tracked && tracked.path !== file.path) {
			// Never leave the previous body's extension attached while the next
			// body is loading and proving currentness.
			this.unbind(view);
		}
		if (!this.ensureEditorBodyReady(view, deviceName, leafId, file.path)) {
			return;
		}
		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`bind: no CM EditorView for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, "bind");
			return;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;
		const cmId = this.getCmId(cm);
		const existing = this.bindings.get(leafId);

		if (existing && existing.path === file.path && existing.cm === cm) {
			const health = this.inspectBindingHealth(view, existing);
			if (health.healthy) {
				if (health.settling) {
					const deferred = health.deferredIssues.join(",");
					this.log(
						`bind: waiting for "${file.path}" to settle ` +
						`(leaf=${leafId}, cm=${cmId}, deferred=${deferred})`,
					);
					return;
				}

				this.log(`bind: already bound "${file.path}" (leaf=${leafId}, cm=${cmId})`);
				return;
			}

			const reason = health.issues.join(",") || "unknown";
			this.log(
				`bind: repairing unhealthy binding "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}, issues=${reason})`,
			);
			if (this.repair(view, deviceName, `bind-health:${reason}`)) {
				return;
			}

			this.log(
				`bind: repair failed for "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}) — falling back to rebind`,
			);
		}

		if (existing && existing.path === file.path && existing.cm !== cm) {
			this.log(
				`bind: editor view changed for "${file.path}" ` +
				`(leaf=${leafId}, stored=${existing.cmId}, live=${cmId})`,
			);
		}

		// Unbind previous if switching files in the same leaf
		if (existing) {
			this.unbind(view);
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			"bind",
		);
		if (!target) {
			return;
		}

		this.applyBinding({
			action: "bind",
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
		});
	}

	repair(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const leafId = view.leaf.id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`repair: no CM EditorView for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, `repair:${reason}`);
			return true;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;

		const existing = this.bindings.get(leafId);
		if (!existing) {
			this.log(
				`repair: no tracked binding for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason})`,
			);
			this.bind(view, deviceName);
			const rebound = this.bindings.get(leafId);
			return rebound?.path === file.path && rebound.cm === cm;
		}

		if (existing.path !== file.path || existing.cm !== cm) {
			this.log(
				`repair: binding target changed for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason}) — forcing rebind`,
			);
			this.rebind(view, deviceName, reason);
			return true;
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`repair:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		return this.applyBinding({
			action: "repair",
			deviceName,
			view,
			cm,
			cmId: this.getCmId(cm),
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			existing,
			reason,
		});
	}

	heal(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`heal:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		const currentContent = view.editor.getValue();
		const crdtContent = target.ytext.toJSON();
		const diffApplied = crdtContent !== currentContent;
		if (diffApplied) {
			this.log(
				`heal: applying local editor content to "${file.path}" ` +
				`(${crdtContent.length} -> ${currentContent.length} chars, reason=${reason})`,
			);
			applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL);
		}

		// Emit editor.heal.applied unconditionally on heal() entry so that
		// "no editor.heal.applied event" means "heal() was not invoked",
		// not "heal() was invoked but happened to be a no-op". The
		// diffApplied flag distinguishes the two cases.
		this.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.editorHealApplied,
			severity: "info",
			scope: "file",
			source: "editorBinding",
			layer: "editor",
			path: file.path,
			data: {
				reason,
				crdtLength: crdtContent.length,
				editorLength: currentContent.length,
				crdtMatchesEditorBefore: !diffApplied,
				diffApplied,
			},
		});

		return this.repair(view, deviceName, reason);
	}

	rebind(view: MarkdownView, deviceName: string, reason: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;
		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, `rebind:${reason}`);
			return;
		}

		const leafId =
			view.leaf.id ?? file.path;
		const pending = this.pendingBodyLoads.get(leafId);
		if (pending?.path === file.path) {
			this.log(`rebind: waiting for v4 body "${file.path}" (leaf=${leafId}, reason=${reason})`);
			return;
		}
		this.log(`rebind: forcing "${file.path}" (leaf=${leafId}, reason=${reason})`);
		this.unbind(view);
		this.bind(view, deviceName);
	}

	/**
	 * Unbind a MarkdownView's editor (clear yCollab extension).
	 */
	unbind(view: MarkdownView): void {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";
		this.cancelPendingBodyLoad(leafId);
		this.releaseBodyLease(leafId);

		const binding = this.bindings.get(leafId);
		if (!binding) return;

		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		binding.undoManager.destroy();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);

		try {
			binding.cm.dispatch({
				effects: this.compartment.reconfigure([]),
			});
		} catch {
			// View may already be destroyed
		}

		this.clearLocalCursor("unbind");

		this.log(`unbind: unbound "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`);
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const leafId of Array.from(this.pendingBodyLoads.keys())) {
			this.cancelPendingBodyLoad(leafId);
		}
		for (const leafId of Array.from(this.bodyLeases.keys())) {
			this.releaseBodyLease(leafId);
		}
		for (const [leafId, binding] of this.bindings) {
			this.clearScheduledHealthCheck(leafId);
			this.clearCmResolveRetry(leafId);
			this.healthWorkInFlight.delete(leafId);
			this.cmToLeafId.delete(binding.cm);
			binding.undoManager.destroy();
			this.log(`unbindAll: destroyed binding for "${binding.path}"`);
		}
		this.bindings.clear();
	}

	/**
	 * Unbind any editors that are bound to the given path.
	 * Called when a file is deleted (locally or remotely).
	 */
	unbindByPath(path: string): void {
		for (const [leafId, pending] of Array.from(this.pendingBodyLoads)) {
			if (pending.path === path) this.cancelPendingBodyLoad(leafId);
		}
		for (const [leafId, leasedPath] of Array.from(this.bodyLeases)) {
			if (leasedPath === path) this.releaseBodyLease(leafId, path);
		}
		for (const [leafId, binding] of this.bindings) {
			if (binding.path === path) {
				this.cancelPendingBodyLoad(leafId);
				this.clearScheduledHealthCheck(leafId);
				this.clearCmResolveRetry(leafId);
				this.healthWorkInFlight.delete(leafId);
				binding.undoManager.destroy();
				try {
					binding.cm.dispatch({
						effects: this.compartment.reconfigure([]),
					});
				} catch {
					// View may already be destroyed
				}
				this.cmToLeafId.delete(binding.cm);
				this.bindings.delete(leafId);
				this.log(`unbindByPath: unbound "${path}" (leaf=${leafId})`);
				// Don't break — a path could theoretically be open in multiple leaves
			}
		}
	}

	/**
	 * Release bindings whose workspace leaf no longer exists.
	 *
	 * Closing a tab is the one lifecycle event with no cleanup path: `unbind`
	 * needs a live MarkdownView to derive its key, `unbindByPath` only fires on
	 * delete/rename, and `auditBindings` skips detached views outright because
	 * `isAuditActionable` bails when `view.file` is null. Measured on a
	 * 121-note vault: `bindings` reached 133 entries with a single tab open,
	 * each stranded entry pinning a dead MarkdownView, its EditorView, the
	 * detached DOM and a live UndoManager doc listener (~39 KB apiece).
	 *
	 * Two independent signals must agree before we release anything:
	 *
	 *   1. the leaf key is absent from the workspace, and
	 *   2. CodeMirror already tore the view down, so our ViewPlugin.destroy
	 *      hook removed it from knownCmViews.
	 *
	 * Requiring both keeps a workspace mutation that transiently hides a leaf
	 * from stranding a live editor. Verified against reading-mode toggles,
	 * sidebar collapse, popout moves and split focus changes: every one of
	 * those keeps the EditorView registered, so none of them prune.
	 */
	pruneOrphanedBindings(liveLeafKeys: ReadonlySet<string>, source: string): number {
		let pruned = 0;
		let deferred = 0;
		for (const leafId of Array.from(this.pendingBodyLoads.keys())) {
			if (!liveLeafKeys.has(leafId)) this.cancelPendingBodyLoad(leafId);
		}
		for (const leafId of Array.from(this.bodyLeases.keys())) {
			if (!liveLeafKeys.has(leafId) && !this.bindings.has(leafId)) {
				this.releaseBodyLease(leafId);
			}
		}

		for (const [leafId, binding] of Array.from(this.bindings)) {
			if (liveLeafKeys.has(leafId)) continue;
			if (this.knownCmViews.has(binding.cm)) {
				// Signals disagree: the leaf is gone but CodeMirror still holds
				// the view. Leave it for the next sweep rather than guess.
				deferred += 1;
				continue;
			}

			this.clearScheduledHealthCheck(leafId);
			this.clearCmResolveRetry(leafId);
			this.healthWorkInFlight.delete(leafId);
			binding.undoManager.destroy();
			this.cmToLeafId.delete(binding.cm);
			this.bindings.delete(leafId);
			this.releaseBodyLease(leafId, binding.path);
			pruned += 1;
			this.log(
				`pruneOrphanedBindings: released "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`,
			);
		}

		if (pruned > 0 || deferred > 0) {
			this.trace?.("editor", "bindings-pruned", {
				source,
				pruned,
				deferred,
				remaining: this.bindings.size,
				knownCmViews: this.knownCmViews.size,
			});
		}
		return pruned;
	}

	/**
	 * Build a per-binding UndoManager without Yjs's permanent doc listener.
	 *
	 * Y.UndoManager's constructor registers two subscriptions on the shared
	 * vault doc: `afterTransaction`, which `destroy()` removes, and an
	 * anonymous `destroy` closure, which it does not — `destroy()` only calls
	 * `doc.off('afterTransaction', ...)`. That closure holds a hard reference
	 * to every UndoManager ever constructed on the doc, including the ones we
	 * tear down correctly, so the observer set grows for the whole session.
	 * Measured against a real vault: 268 `destroy` observers after ordinary
	 * use, and creating then correctly destroying 50 managers left 50 behind.
	 *
	 * We already destroy our managers explicitly on unbind, prune and
	 * teardown, so the auto-destroy-on-doc-destroy hook buys us nothing.
	 * Remove whichever `destroy` observers the constructor just added.
	 *
	 * `_observers` is Yjs-internal, so every access is shape-checked; if a
	 * future Yjs changes it we silently keep the old behaviour rather than
	 * throw during a bind.
	 */
	private createUndoManager(ytext: Y.Text): Y.UndoManager {
		const doc = ytext.doc;
		// Only the `destroy` hook is surplus here — this manager's
		// `afterTransaction` subscription is the one that makes undo work.
		const before = this.snapshotDocObservers(doc, "destroy");
		const undoManager = new Y.UndoManager(ytext);
		this.releaseAddedDocObservers(doc, "destroy", before);
		return undoManager;
	}

	/**
	 * Build the collab extension without the manager y-codemirror hides in it.
	 *
	 * `YSyncConfig`'s constructor unconditionally runs `new Y.UndoManager(ytext)`
	 * (y-codemirror.next/src/y-sync.js:11) and then never reads it — the manager
	 * the editor actually drives is the one we pass to yUndoManagerFacet. That
	 * stray manager stays subscribed to the vault doc forever, so every rebind
	 * leaked one `afterTransaction` observer and one of Yjs's unremovable
	 * `destroy` closures. Measured: +72 of each across 72 tab opens, even with
	 * binding pruning working.
	 *
	 * Our own manager is constructed before this call, so anything that appears
	 * on either observer set during `yCollab` belongs to the stray one and is
	 * safe to drop.
	 */
	private buildCollabExtension(
		ytext: Y.Text,
		undoManager: Y.UndoManager,
		path: string,
	): Extension {
		const doc = ytext.doc;
		const destroyBefore = this.snapshotDocObservers(doc, "destroy");
		const transactionBefore = this.snapshotDocObservers(doc, "afterTransaction");

		const extension = yCollab(ytext, this.vaultSync.getBodyAwareness(path), {
			undoManager,
		});

		this.releaseAddedDocObservers(doc, "destroy", destroyBefore);
		this.releaseAddedDocObservers(doc, "afterTransaction", transactionBefore);
		return extension;
	}

	/**
	 * Drop observers registered on `doc` since `before` was captured.
	 *
	 * Yjs never removes an UndoManager's `destroy` hook — `destroy()` only
	 * unsubscribes `afterTransaction` — so managers we create would otherwise be
	 * pinned for the lifetime of the doc. We destroy ours explicitly on unbind,
	 * prune and teardown, so the auto-destroy hook buys us nothing.
	 */
	private releaseAddedDocObservers(
		doc: Y.Doc | null,
		event: "destroy" | "afterTransaction",
		before: ReadonlySet<(...args: never[]) => void> | null,
	): void {
		if (!doc || !before) return;
		const after = this.snapshotDocObservers(doc, event);
		if (!after) return;
		for (const observer of after) {
			if (before.has(observer)) continue;
			doc.off(event, observer);
		}
	}

	/**
	 * Copy of the doc's observers for `event`, or null if Yjs's shape changed.
	 * `_observers` is Yjs-internal, so every step is shape-checked; on an
	 * unexpected layout we return null and keep the old leaky behaviour rather
	 * than throw mid-bind.
	 */
	private snapshotDocObservers(
		doc: Y.Doc | null,
		event: string,
	): Set<(...args: never[]) => void> | null {
		if (!doc || !("_observers" in doc)) return null;
		const observers = doc._observers;
		if (!(observers instanceof Map)) return null;
		const forEvent = observers.get(event);
		if (!(forEvent instanceof Set)) return null;
		return new Set(forEvent);
	}

	/**
	 * Check if a path is currently bound to an active editor.
	 */
	isBound(path: string): boolean {
		for (const binding of this.bindings.values()) {
			if (binding.path === path) return true;
		}
		return false;
	}

	/**
	 * Update binding metadata after a batch rename. If any bound editor's
	 * tracked path was renamed, update the tracking. The yCollab binding
	 * itself doesn't need to change (stable file IDs), but our bookkeeping does.
	 */
	updatePathsAfterRename(renames: Map<string, string>): void {
		for (const [leafId, binding] of this.bindings) {
			const newPath = renames.get(binding.path);
			if (newPath) {
				this.log(`updatePaths: "${binding.path}" -> "${newPath}" (leaf=${leafId})`);
				binding.path = newPath;
			}
		}
	}

	getBindingDebugInfoForView(view: MarkdownView): BindingDebugInfo | null {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) return null;

		const liveCm = this.getCmView(view);
		const liveCmId = liveCm ? this.getCmId(liveCm) : null;
		return {
			leafId,
			path: binding.path,
			fileId: binding.fileId,
			storedCmId: binding.cmId,
			liveCmId,
			cmMatches: liveCm === binding.cm,
			lastBoundAt: binding.lastBoundAt,
		};
	}

	getBindingDebugInfo(path: string): BindingDebugInfo | null {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path !== path) continue;
			return {
				leafId,
				path: binding.path,
				fileId: binding.fileId,
				storedCmId: binding.cmId,
				liveCmId: binding.cmId,
				cmMatches: true,
				lastBoundAt: binding.lastBoundAt,
			};
		}
		return null;
	}

	getBindingHealthForView(view: MarkdownView): BindingHealthStatus {
		const file = view.file;
		const leafId =
			view.leaf.id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) {
			return {
				bound: false,
				healthy: false,
				settling: false,
				issues: ["missing-binding"],
			};
		}

		const health = this.inspectBindingHealth(view, binding);
		return {
			bound: true,
			healthy: health.healthy,
			settling: health.settling,
			issues: health.issues,
		};
	}

	auditBindings(source: string): number {
		let triggered = 0;
		const snapshot = Array.from(this.bindings.entries());
		for (const [leafId, binding] of snapshot) {
			if (this.bindings.get(leafId) !== binding) continue;
			if (this.healthWorkInFlight.has(leafId)) continue;

			const health = this.inspectBindingHealth(binding.view, binding);
			if (health.healthy || health.settling) continue;
			if (!this.isAuditActionable(binding.view, health.issues)) continue;

			triggered += 1;
			this.maybeHealBinding(leafId, binding, source);
		}
		return triggered;
	}

	getLastEditorActivityForPath(path: string): number | null {
		let latest: number | null = null;
		for (const binding of this.bindings.values()) {
			if (binding.path !== path) continue;
			if (latest == null || binding.lastEditorChangeAtMs > latest) {
				latest = binding.lastEditorChangeAtMs;
			}
		}
		return latest;
	}

	getCollabDebugInfoForView(view: MarkdownView): CollabDebugInfo | null {
		const file = view.file;
		if (!file) return null;

		const leafId =
			view.leaf.id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			return {
				leafId,
				path: file.path,
				cmId: null,
				hasSyncFacet: false,
				awarenessMatchesProvider: null,
				yTextMatchesExpected: null,
				undoManagerMatchesFacet: null,
				facetFileId: null,
				expectedFileId: this.vaultSync.getFileId(file.path) ?? null,
				facetTextLength: null,
				cmDocLength: null,
			};
		}

		type SyncFacetLike = {
			ytext?: Y.Text;
			awareness?: unknown;
			undoManager?: Y.UndoManager;
		} | undefined;

		let syncFacet: SyncFacetLike;
		try {
			syncFacet = cm.state.facet(ySyncFacet);
		} catch {
			syncFacet = undefined;
		}

		const binding = this.bindings.get(leafId);
		const expectedText = this.vaultSync.getTextForPath(file.path);
		const expectedFileId =
			this.vaultSync.getFileId(file.path)
			?? (expectedText ? this.vaultSync.getFileIdForText(expectedText) : undefined)
			?? null;
		const facetText = syncFacet?.ytext ?? null;
		const facetFileId =
			facetText instanceof Y.Text
				? (this.vaultSync.getFileIdForText(facetText) ?? null)
				: null;

		const facetUndoManager =
			syncFacet && "undoManager" in syncFacet
				? (syncFacet.undoManager ?? null)
				: null;

		return {
			leafId,
			path: file.path,
			cmId: this.getCmId(cm),
			hasSyncFacet: !!syncFacet,
			awarenessMatchesProvider: syncFacet
				? syncFacet.awareness === this.vaultSync.getBodyAwareness(file.path)
				: null,
			yTextMatchesExpected: syncFacet
				? (expectedText ? syncFacet.ytext === expectedText : false)
				: null,
			undoManagerMatchesFacet: syncFacet
				? ("undoManager" in syncFacet
					? (binding ? facetUndoManager === binding.undoManager : null)
					: null)
				: null,
			facetFileId,
			expectedFileId,
			facetTextLength:
				facetText instanceof Y.Text
						? facetText.toJSON().length
						: null,
			cmDocLength: cm.state.doc.length,
		};
	}

	clearLocalCursor(reason: string): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField("cursor", null);
			this.trace?.("editor", "cursor-cleared", { reason });
		} catch {
			// Provider may be disconnected
		}
	}

	/**
	 * Get the CM6 EditorView from a MarkdownView.
	 *
	 * Primary strategy is Obsidian's public `editorInfoField`, which every
	 * editor state carries and which names the view owning that editor. It is
	 * exact even when several editors share one container (embeds,
	 * plugin-injected editors) or the DOM was re-parented mid-switch.
	 *
	 * DOM containment over the CM6 views registered by our global ViewPlugin
	 * stays as the fallback. Both strategies use public API only.
	 *
	 * Resolution is fail-closed: while ownership is ambiguous we return null
	 * and let the caller retry rather than bind the wrong editor.
	 */
	private getCmView(view: MarkdownView): EditorView | null {
		const container = view.containerEl;
		if (!container) return null;

		const leafId =
			view.leaf.id ?? view.file?.path ?? null;
		if (leafId) {
			const existing = this.bindings.get(leafId);
			if (
				existing
				&& existing.cm.dom.isConnected
				&& container.contains(existing.cm.dom)
			) {
				return existing.cm;
			}
		}

		const infoMatches: EditorView[] = [];
		const matches: EditorView[] = [];
		const stale: EditorView[] = [];
		for (const cm of this.knownCmViews) {
			if (!cm.dom.isConnected) {
				stale.push(cm);
				continue;
			}
			if (this.cmBelongsToView(cm, view)) {
				infoMatches.push(cm);
			}
			if (container.contains(cm.dom)) {
				matches.push(cm);
			}
		}
		for (const cm of stale) {
			this.knownCmViews.delete(cm);
			this.cmToLeafId.delete(cm);
		}

		if (infoMatches.length === 1) {
			this.lastCmResolveFailure = null;
			return infoMatches[0]!;
		}
		if (infoMatches.length > 1) {
			const focusedInfoMatch = this.findFocusedCm(infoMatches);
			if (focusedInfoMatch) {
				this.lastCmResolveFailure = null;
				return focusedInfoMatch;
			}
		}

		if (matches.length === 0) {
			// knownCmViews only fills once our global ViewPlugin is constructed,
			// and that construction can lag the workspace event that triggered
			// bind(). Measured on a 121-note vault: the editor is already live
			// (view.editor.cm connected) while knownCmViews still holds 0-2
			// entries, so both the ownership and containment passes come up
			// empty and we burn the retry budget waiting for registration.
			// CodeMirror's public findFromDOM resolves the live EditorView
			// straight from this view's container, so the note binds on the
			// first attempt instead.
			// knownCmViews only ever holds connected views (disconnected ones are
			// pruned above), so the containment pass can never return a detached
			// editor. findFromDOM has no such invariant — on a closed leaf it
			// happily finds the dead EditorView still sitting in the detached
			// container — so re-establish the invariant explicitly.
			const fromDom = EditorView.findFromDOM(container);
			if (fromDom?.dom.isConnected) {
				this.registerKnownCmView(fromDom);
				this.lastCmResolveFailure = null;
				return fromDom;
			}
			this.lastCmResolveFailure = {
				reason: this.knownCmViews.size === 0
					? "no-known-cm-views"
					: "no-container-match",
				knownCmViews: this.knownCmViews.size,
				containerMatches: 0,
				infoMatches: infoMatches.length,
			};
			return null;
		}
		if (matches.length === 1) {
			this.lastCmResolveFailure = null;
			return matches[0]!;
		}

		const focused = this.findFocusedCm(matches);
		if (focused) {
			this.lastCmResolveFailure = null;
			return focused;
		}

		const ids = matches.map((cm) => this.getCmId(cm));
		this.lastCmResolveFailure = {
			reason: "ambiguous",
			knownCmViews: this.knownCmViews.size,
			containerMatches: matches.length,
			infoMatches: infoMatches.length,
		};
		this.trace?.("editor", "cm-resolution-ambiguous", {
			leafId: leafId ?? "unknown",
			path: view.file?.path ?? null,
			matches: ids,
		});
		this.log(
			`getCmView: ambiguous CM6 match for "${view.file?.path ?? "(unknown)"}" ` +
			`(leaf=${leafId ?? "unknown"}, matches=${ids.join(",")})`,
		);

		return null;
	}

	private warnCmDegraded(): void {
		if (this.cmDegradedWarned) return;
		this.cmDegradedWarned = true;
		new Notice(
			"YAOS: Could not resolve the active editor instance. " +
			"Live collaborative editing is unavailable. Background sync may still continue, " +
			"but live cursors and editor binding are degraded. Please check for a plugin update.",
			10000,
		);
		console.error(
			"[yaos] Critical: Could not locate CodeMirror 6 EditorView. Live binding disabled.",
		);
	}

	/**
	 * True when `cm` is the editor Obsidian associates with `view`, according
	 * to the public editorInfoField carried in the editor's state.
	 */
	private cmBelongsToView(cm: EditorView, view: MarkdownView): boolean {
		let info: MarkdownFileInfo | undefined;
		try {
			info = cm.state.field(editorInfoField, false);
		} catch {
			return false;
		}

		if (!info) return false;
		if (info === view) return true;
		// Some editors expose a separate MarkdownFileInfo for the same file.
		// Demand a live file plus a shared Editor before claiming ownership so
		// two fileless editors cannot resolve to each other.
		if (!view.file || info.file !== view.file) return false;
		return info.editor !== undefined && info.editor === view.editor;
	}

	private findFocusedCm(cms: EditorView[]): EditorView | null {
		const activeElement =
			typeof document !== "undefined" ? document.activeElement : null;
		const focused = cms.filter((cm) =>
			cm.hasFocus || (activeElement ? cm.dom.contains(activeElement) : false),
		);
		return focused.length === 1 ? focused[0]! : null;
	}

	private getCmId(cm: EditorView): string {
		const existing = this.cmIds.get(cm);
		if (existing) return existing;
		const cmId = `cm-${++this.cmCounter}`;
		this.cmIds.set(cm, cmId);
		return cmId;
	}

	private registerKnownCmView(cm: EditorView): void {
		this.knownCmViews.add(cm);
	}

	private unregisterKnownCmView(cm: EditorView): void {
		this.knownCmViews.delete(cm);
		this.cmToLeafId.delete(cm);
	}

	private inspectBindingHealth(
		view: MarkdownView,
		binding: EditorBinding,
	): BindingHealthCheck {
		if (this.bindingPropagationGate?.isPaused(binding.path)) {
			// Harness gate: treat as healthy so we don't auto-heal/rebind mid-scenario.
			return { healthy: true, settling: false, issues: [], deferredIssues: [] };
		}
		const issues: string[] = [];
		const deferredIssues: string[] = [];
		const file = view.file;
		const liveCm = this.getCmView(view);
		const collab = this.getCollabDebugInfoForView(view);
		const withinSettleWindow =
			Date.now() - binding.lastBoundAtMs < binding.settleWindowMs;

		if (!file) {
			issues.push("missing-file");
		} else if (binding.path !== file.path) {
			issues.push("path-changed");
		}

		if (!liveCm) {
			issues.push("missing-cm");
		} else if (liveCm !== binding.cm) {
			issues.push("cm-changed");
		}

		if (!collab) {
			issues.push("missing-collab-info");
		} else {
			if (!collab.hasSyncFacet) {
				if (withinSettleWindow) {
					deferredIssues.push("missing-sync-facet");
				} else {
					issues.push("missing-sync-facet");
				}
			}
			if (collab.awarenessMatchesProvider === false) {
				issues.push("awareness-mismatch");
			}
			if (collab.yTextMatchesExpected === false) {
				issues.push("ytext-mismatch");
			}
		}

		return {
			healthy: issues.length === 0,
			settling: issues.length === 0 && deferredIssues.length > 0,
			issues,
			deferredIssues,
		};
	}

	private handleLiveEditorUpdate(update: ViewUpdate): void {
		const match = this.findBindingForCm(update.view);
		if (!match) return;
		if (update.docChanged) {
			match.binding.lastEditorChangeAtMs = Date.now();
		}
		this.maybeHealBinding(match.leafId, match.binding, "live-update");
	}

	private maybeHealBinding(
		leafId: string,
		binding: EditorBinding,
		source: string,
	): void {
		if (this.healthWorkInFlight.has(leafId)) return;
		if (this.bindings.get(leafId) !== binding) return;
		if (this.bindingPropagationGate?.isPaused(binding.path)) return;

		const health = this.inspectBindingHealth(binding.view, binding);
		if (health.healthy || health.settling) return;
		if (source === "live-update") {
			this.scheduleHealthCheck(leafId, LIVE_UPDATE_HEALTH_RETRY_DELAY_MS, "live-update-deferred");
			return;
		}
		const onlyMissingSyncFacet =
			health.issues.length === 1 && health.issues[0] === "missing-sync-facet";
		if (onlyMissingSyncFacet && source !== "retry-health-check") {
			const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
			this.trace?.("editor", "binding-health-missing-sync-facet-deferred", {
				...traceDetails,
				action: "deferred",
			});
			const retryDelayMs = binding.settleWindowMs + POST_BIND_HEALTH_GRACE_MS;
			this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
			return;
		}

		const issues = health.issues.join(",") || "unknown";
		const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
		this.healthWorkInFlight.add(leafId);
		this.trace?.("editor", "binding-health-failed", traceDetails);
		this.log(
			`binding-health-failed: "${binding.path}" ` +
			`(leaf=${leafId}, cm=${binding.cmId}, source=${source}, issues=${issues})`,
		);

		try {
			const repaired = this.repair(
				binding.view,
				this.lastDeviceName,
				`${source}:${issues}`,
			);
			if (!repaired) {
				this.rebind(binding.view, this.lastDeviceName, `${source}:${issues}`);
			}
			const latestBinding = this.bindings.get(leafId);
			const tombstoned = this.isHardTombstonedPath(binding.path);
			const postView = latestBinding?.view ?? binding.view;
			const postHealth = latestBinding
				? this.inspectBindingHealth(postView, latestBinding)
				: null;
			const restored =
				tombstoned
				|| (!!postHealth && (postHealth.healthy || postHealth.settling));
			if (!restored) {
				this.trace?.("editor", "binding-health-retry-scheduled", {
					...traceDetails,
					action: "retry-scheduled",
					post: this.getCollabDebugInfoForView(postView),
					postIssues: postHealth?.issues ?? ["missing-binding"],
				});
				const retryDelayMs =
					(latestBinding?.settleWindowMs ?? BASE_BINDING_SETTLE_WINDOW_MS)
					+ POST_BIND_HEALTH_GRACE_MS;
				this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
				return;
			}
			this.trace?.("editor", "binding-health-restored", {
				...traceDetails,
				action: tombstoned
					? "unbound-tombstone"
					: (postHealth?.settling
						? "settling"
						: (repaired
							? (!latestBinding
								? "unbound"
								: (latestBinding.path === binding.path
									&& latestBinding.fileId === binding.fileId
									? "repair-only"
									: "rebound-target"))
							: "rebind")),
				postIssues: postHealth?.issues ?? [],
				post: this.getCollabDebugInfoForView(postView),
			});
		} finally {
			this.healthWorkInFlight.delete(leafId);
		}
	}

	private scheduleCmResolveRetry(
		view: MarkdownView,
		deviceName: string,
		leafId: string,
		source: string,
	): void {
		const attempts = (this.cmResolveAttempts.get(leafId) ?? 0) + 1;
		this.cmResolveAttempts.set(leafId, attempts);

		if (attempts > CM_RESOLVE_MAX_RETRIES) {
			this.warnCmDegraded();
			this.trace?.("editor", "cm-resolution-degraded", {
				leafId,
				path: view.file?.path ?? null,
				source,
				attempts,
				failure: this.lastCmResolveFailure,
			});
			return;
		}

		if (this.pendingCmResolveRetries.has(leafId)) {
			return;
		}

		const retryDelay = CM_RESOLVE_RETRY_DELAY_MS * attempts;
		const timer = window.setTimeout(() => {
			this.pendingCmResolveRetries.delete(leafId);
			this.bind(view, deviceName);
		}, retryDelay);
		this.pendingCmResolveRetries.set(leafId, timer);
	}

	private clearCmResolveRetry(leafId: string): void {
		const timer = this.pendingCmResolveRetries.get(leafId);
		if (timer) {
			window.clearTimeout(timer);
			this.pendingCmResolveRetries.delete(leafId);
		}
		this.cmResolveAttempts.delete(leafId);
	}

	private scheduleHealthCheck(
		leafId: string,
		delayMs: number,
		source: string,
	): void {
		this.clearScheduledHealthCheck(leafId);
		const timer = window.setTimeout(() => {
			this.pendingHealthChecks.delete(leafId);
			const binding = this.bindings.get(leafId);
			if (!binding) return;
			this.maybeHealBinding(leafId, binding, source);
		}, delayMs);
		this.pendingHealthChecks.set(leafId, timer);
	}

	private schedulePostBindHealthCheck(leafId: string, settleWindowMs: number): void {
		this.scheduleHealthCheck(
			leafId,
			settleWindowMs + POST_BIND_HEALTH_GRACE_MS,
			"post-bind-health",
		);
	}

	private clearScheduledHealthCheck(leafId: string): void {
		const timer = this.pendingHealthChecks.get(leafId);
		if (timer) {
			window.clearTimeout(timer);
			this.pendingHealthChecks.delete(leafId);
		}
	}

	private applyBinding(options: {
		action: "bind" | "repair";
		deviceName: string;
		view: MarkdownView;
		cm: EditorView;
		cmId: string;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		fileId?: string;
		existing?: EditorBinding;
		reason?: string;
	}): boolean {
		const {
			action,
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath,
			ytext,
			fileId,
			existing,
			reason,
		} = options;

		const undoManager = this.createUndoManager(ytext);

		const awareness = this.vaultSync.getBodyAwareness(filePath);
		awareness.setLocalStateField(
			"user",
			awarenessCursorUser(deviceName, this.vaultSync.deviceId),
		);

		const collabExtension = this.buildCollabExtension(ytext, undoManager, filePath);

		try {
			this.clearLocalCursor(`${action}-pre-reconfigure`);
			cm.dispatch({
				effects: this.compartment.reconfigure(collabExtension),
			});
		} catch (err) {
			undoManager.destroy();
			if (!existing) this.releaseBodyLease(leafId, filePath);
			this.log(
				`${action}: failed "${filePath}" ` +
				`(leaf=${leafId}, cm=${cmId}, reason=${reason ?? "n/a"}): ${String(err)}`,
			);
			return false;
		}

		existing?.undoManager.destroy();
		if (existing) {
			this.cmToLeafId.delete(existing.cm);
		}
		const boundAtMs = Date.now();
		const rapidSwitch =
			!!existing
			&& existing.path !== filePath
			&& boundAtMs - existing.lastBoundAtMs <= FAST_SWITCH_WINDOW_MS;
		const settleWindowMs = rapidSwitch
			? FAST_SWITCH_BINDING_SETTLE_WINDOW_MS
			: BASE_BINDING_SETTLE_WINDOW_MS;
		this.bindings.set(leafId, {
			view,
			path: filePath,
			undoManager,
			cm,
			cmId,
			fileId,
			lastBoundAt: new Date(boundAtMs).toISOString(),
			lastBoundAtMs: boundAtMs,
			lastEditorChangeAtMs: boundAtMs,
			settleWindowMs,
		});
		this.cmToLeafId.set(cm, leafId);
		this.schedulePostBindHealthCheck(leafId, settleWindowMs);
		this.trace?.("editor", "binding-applied", {
			action,
			leafId,
			path: filePath,
			cmId,
			fileId: fileId ?? null,
			reason: reason ?? null,
			settleWindowMs,
			rapidSwitch,
		});

		// Emit editor.repair.applied only for successful repair-action applications.
		if (action === "repair") {
			this.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path: filePath,
				data: {
					leafId,
					cmId,
					reason: reason ?? null,
					rapidSwitch,
				},
			});
		}

		const result = action === "repair" ? "repaired" : "bound";
		const reasonSuffix = reason ? `, reason=${reason}` : "";
		const settleSuffix = rapidSwitch
			? `, settleWindowMs=${settleWindowMs}, rapidSwitch=true`
			: `, settleWindowMs=${settleWindowMs}`;
		this.log(
			`${action}: ${result} "${filePath}" ` +
			`(leaf=${leafId}, cm=${cmId}${fileId ? `, fileId=${fileId}` : ""}${reasonSuffix}${settleSuffix})`,
		);
		return true;
	}

	private log(msg: string): void {
		this.trace?.("editor", msg);
		if (this.debug) {
			console.debug(`[yaos:editor] ${msg}`);
		}
	}

	private findBindingForCm(cm: EditorView): { leafId: string; binding: EditorBinding } | null {
		const leafId = this.cmToLeafId.get(cm);
		if (leafId) {
			const binding = this.bindings.get(leafId);
			if (binding && binding.cm === cm) {
				return { leafId, binding };
			}
		}

		for (const [fallbackLeafId, binding] of this.bindings) {
			if (binding.cm === cm) {
				this.cmToLeafId.set(cm, fallbackLeafId);
				return { leafId: fallbackLeafId, binding };
			}
		}

		return null;
	}

	private ensureEditorBodyReady(
		view: MarkdownView,
		deviceName: string,
		leafId: string,
		path: string,
	): boolean {
		const runtime = this.vaultSync;
		if (!runtime.acquireEditorBody) return true;
		if (runtime.isEditorBodyReady?.(path, leafId)) return true;

		const pending = this.pendingBodyLoads.get(leafId);
		if (pending?.path === path) return false;
		if (pending) this.cancelPendingBodyLoad(leafId);

		const generation = ++this.bodyLoadGeneration;
		this.pendingBodyLoads.set(leafId, { path, generation });
		void runtime.acquireEditorBody(path, leafId).then(
			() => {
				const current = this.pendingBodyLoads.get(leafId);
				const stillCurrent =
					current?.generation === generation
					&& current.path === path
					&& view.file?.path === path;
				if (!stillCurrent) {
					this.vaultSync.releaseEditorBody?.(path, leafId);
					return;
				}
				this.bodyLeases.set(leafId, path);
				this.pendingBodyLoads.delete(leafId);
				if (!this.vaultSync.isEditorBodyReady?.(path, leafId)) {
					this.releaseBodyLease(leafId, path);
					return;
				}
				this.bind(view, deviceName);
			},
			(error: unknown) => {
				const current = this.pendingBodyLoads.get(leafId);
				if (current?.generation === generation) {
					this.pendingBodyLoads.delete(leafId);
				}
				this.log(`bind: body load failed for "${path}" (leaf=${leafId}): ${String(error)}`);
			},
		);
		return false;
	}

	private cancelPendingBodyLoad(leafId: string): void {
		const pending = this.pendingBodyLoads.get(leafId);
		if (!pending) return;
		this.pendingBodyLoads.delete(leafId);
		this.vaultSync.releaseEditorBody?.(pending.path, leafId);
	}
	private releaseBodyLease(leafId: string, fallbackPath?: string): void {
		const path = this.bodyLeases.get(leafId) ?? fallbackPath;
		this.bodyLeases.delete(leafId);
		if (path) this.vaultSync.releaseEditorBody?.(path, leafId);
	}

	private resolveBindingTarget(
		view: MarkdownView,
		deviceName: string,
		reason: string,
	): BindingTarget | null {
		const file = view.file;
		if (!file) return null;

		const existingText = this.vaultSync.getTextForPath(file.path);
		if (existingText) {
			return {
				ytext: existingText,
				fileId:
					this.vaultSync.getFileId(file.path)
					?? this.vaultSync.getFileIdForText(existingText),
			};
		}

		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, reason);
			return null;
		}
		if (this.vaultSync.acquireEditorBody) {
			// V4 bodies are admitted by the durable root/catalog and may only
			// bind after async load, HTTP catch-up, and provider synchronization.
			this.log(`resolveBindingTarget: v4 body is not ready for "${file.path}" (reason=${reason})`);
			return null;
		}

		const currentContent = view.editor.getValue();
		const ytext = this.vaultSync.ensureFile(file.path, currentContent, deviceName);
		if (!ytext) {
			if (this.isHardTombstonedPath(file.path)) {
				this.handleTombstonedBinding(view, `${reason}:ensureFile-null`);
			} else {
				this.log(`resolveBindingTarget: ensureFile returned null for "${file.path}" (reason=${reason})`);
				this.trace?.("editor", "binding-target-missing", {
					path: file.path,
					reason,
					leafId:
						view.leaf.id ?? file.path,
				});
			}
			return null;
		}

		return {
			ytext,
			fileId:
				this.vaultSync.getFileId(file.path)
				?? this.vaultSync.getFileIdForText(ytext),
		};
	}

	private isHardTombstonedPath(path: string): boolean {
		return (
			!this.vaultSync.getTextForPath(path)
			&& !this.vaultSync.isPendingRenameTarget(path)
			&& this.vaultSync.isMarkdownTombstoned(path)
		);
	}

	private handleTombstonedBinding(view: MarkdownView, reason: string): void {
		const file = view.file;
		if (!file) return;

		const leafId =
			view.leaf.id ?? file.path;
		const existing = this.bindings.get(leafId);
		this.trace?.("editor", "binding-blocked-tombstone", {
			path: file.path,
			leafId,
			reason,
			hadBinding: !!existing,
			pendingRenameTarget: this.vaultSync.isPendingRenameTarget(file.path),
		});
		this.log(
			`binding blocked by tombstone for "${file.path}" ` +
			`(leaf=${leafId}, reason=${reason})`,
		);
		if (existing) {
			this.unbind(view);
		}
	}

	private buildHealthTraceDetails(
		leafId: string,
		binding: EditorBinding,
		source: string,
		issues: string[],
	): Record<string, unknown> {
		const isActiveView =
			this.workspace.getActiveViewOfType(MarkdownView) === binding.view;
		return {
			leafId,
			path: binding.path,
			cmId: binding.cmId,
			source,
			issues,
			binding: this.getBindingDebugInfoForView(binding.view),
			collab: this.getCollabDebugInfoForView(binding.view),
			isActiveLeaf: isActiveView,
			documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
		};
	}

	private isAuditActionable(view: MarkdownView, issues: string[]): boolean {
		const file = view.file;
		if (!file) {
			return false;
		}

		const isActiveLeaf =
			this.workspace.getActiveViewOfType(MarkdownView) === view;
		if (isActiveLeaf) {
			return true;
		}

		return issues.some(
			(issue) =>
				issue !== "missing-file"
				&& issue !== "missing-collab-info",
		);
	}
}
