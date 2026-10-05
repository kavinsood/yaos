/**
 * Status bar: pure rendering of StatusSnapshot + EngineRunState (DESIGN §j.7: phase + unsynced
 * count), and a small controller that keeps one status bar element up to date.
 * Ported from legacy-src/status/statusBarController.ts.
 *
 * No obsidian runtime import: the controller touches only standard DOM APIs on the element it is
 * given, and its timers are injectable, so it is testable in Node with a fake element.
 */

import type { StatusSnapshot } from "../../protocol/status";
import type { EngineRunState, YaosUiHost } from "./api";
import { pendingBrake } from "./api";
import { brakeHeadline } from "./brake";
import { formatAgo, formatDuration, plural } from "./format";

export type StatusLevel = "ok" | "busy" | "warn" | "error";

export interface RenderedStatus {
	readonly text: string;
	readonly tooltip: string;
	readonly level: StatusLevel;
}

const PREFIX = "YAOS: ";

/** Frames not yet durable on the relay: queued in the outbox plus sent but unreceipted. */
export function unsyncedCount(s: StatusSnapshot): number {
	return Math.max(0, s.counts.outboxFrames) + Math.max(0, s.counts.unreceiptedFrames);
}

function withUnsynced(base: string, n: number): string {
	return n > 0 ? `${base} · ${n} unsynced` : base;
}

function progress(s: StatusSnapshot): string | null {
	const b = s.bootstrap;
	if (!b || b.docsTotal <= 0) return null;
	return `${Math.min(b.docsMaterialized, b.docsTotal)}/${b.docsTotal}`;
}

function latestNotice(s: StatusSnapshot, level?: "warn" | "error"): string | null {
	let best: StatusSnapshot["notices"][number] | null = null;
	for (const n of s.notices) {
		if (level && n.level !== level && !(level === "warn" && n.level === "error")) continue;
		if (!best || n.atMs >= best.atMs) best = n;
	}
	return best ? best.code : null;
}

/**
 * Render the status bar text, tooltip and level. `nowMs` only feeds relative times in the tooltip
 * ("last synced 3 min ago"); omit it to leave them out.
 */
export function renderStatus(snapshot: StatusSnapshot | null, run: EngineRunState, nowMs?: number): RenderedStatus {
	switch (run.phase) {
		case "unpaired":
			return { text: `${PREFIX}not paired`, tooltip: "This device is not paired with a YAOS server. Click to open settings and pair it.", level: "warn" };
		case "failed":
			return {
				text: `${PREFIX}stopped (error)`,
				tooltip: `Sync engine failed: ${run.lastError ?? "unknown error"}. Open settings to restart it.`,
				level: "error",
			};
		case "stopped":
			return { text: `${PREFIX}stopped`, tooltip: "Sync engine is stopped. Open settings to restart it.", level: "warn" };
		case "starting":
			return { text: `${PREFIX}starting…`, tooltip: "Starting the sync engine.", level: "busy" };
		case "running":
			break;
	}
	if (!snapshot) return { text: `${PREFIX}starting…`, tooltip: "Waiting for the first status from the sync engine.", level: "busy" };

	const n = unsyncedCount(snapshot);
	const lines: string[] = [];
	let text: string;
	let level: StatusLevel;
	switch (snapshot.phase) {
		case "starting":
			text = "starting…";
			level = "busy";
			lines.push("Starting the sync engine.");
			break;
		case "recovering":
			text = "recovering…";
			level = "busy";
			lines.push("Rebuilding local sync state from this device's files and the server.");
			break;
		case "bootstrapping": {
			const p = progress(snapshot);
			text = p ? `downloading ${p}` : "downloading vault…";
			level = "busy";
			lines.push(p ? `First sync: ${p} notes written to this vault.` : "First sync: downloading the vault.");
			break;
		}
		case "catching-up": {
			const p = progress(snapshot);
			text = withUnsynced(p ? `catching up ${p}` : "catching up", n);
			level = "busy";
			lines.push(`Fetching changes from the server (${plural(snapshot.counts.staleStreams, "stream")} behind).`);
			break;
		}
		case "live":
			if (n === 0) {
				text = "synced";
				level = "ok";
				lines.push("Up to date with the server.");
			} else {
				text = `syncing · ${n} unsynced`;
				level = "busy";
				lines.push("Sending local changes to the server.");
			}
			break;
		case "offline": {
			text = withUnsynced("offline", n);
			level = "warn";
			const r = snapshot.relay.reconnectInMs;
			lines.push(r !== null ? `Offline. Reconnecting in ${formatDuration(r)}.` : "Offline. Waiting for the network.");
			if (n > 0) lines.push("Local changes are kept and will be sent when the connection returns.");
			break;
		}
		case "paused":
			text = withUnsynced("paused", n);
			level = "warn";
			lines.push("Sync is paused. Local changes are kept. Use the Resume command to continue.");
			break;
		case "braked": {
			const brake = snapshot.brake;
			text = "needs approval";
			level = "warn";
			lines.push(brake ? `${brakeHeadline(brake)} Click to review.` : "A risky change is waiting for your approval. Click to review.");
			break;
		}
		case "daily-limit":
			text = withUnsynced("daily limit", n);
			level = "warn";
			lines.push("The server reached its free-plan daily write limit. Edits are kept on this device and sync resumes after 00:00 UTC.");
			break;
		case "superseded":
			text = withUnsynced("reconnecting", n);
			level = "warn";
			lines.push("The server asked this device to reconnect (permissions changed). Retrying.");
			break;
		case "revoked":
			text = "re-pair device";
			level = "error";
			lines.push("The server no longer accepts this device's credentials. Pair this device again in settings.");
			break;
		case "epoch-migrating":
			text = "re-syncing vault";
			level = "busy";
			lines.push("The server vault was reset. Re-syncing this device against the new vault.");
			break;
		case "upgrade-required":
			text = "update required";
			level = "error";
			lines.push("The server needs a newer YAOS plugin. Update the plugin to continue syncing.");
			break;
		case "error": {
			text = withUnsynced("error", n);
			level = "error";
			const code = latestNotice(snapshot, "error");
			lines.push(code ? `Sync error (${code}). See settings for details.` : "Sync error. See settings for details.");
			break;
		}
	}

	if (n > 0) lines.push(`Unsynced: ${snapshot.counts.outboxFrames} queued, ${snapshot.counts.unreceiptedFrames} awaiting server receipt.`);
	if (snapshot.counts.pendingDiskOps > 0) lines.push(`${plural(snapshot.counts.pendingDiskOps, "file change")} pending on disk.`);
	if (snapshot.counts.pendingBlobs > 0) lines.push(`${plural(snapshot.counts.pendingBlobs, "attachment")} pending.`);
	const frozen = snapshot.counts.frozenDocs;
	const quarantined = snapshot.counts.quarantinedRows;
	if (frozen > 0 || quarantined > 0) {
		lines.push(`Needs attention: ${plural(frozen, "frozen note")}, ${plural(quarantined, "quarantined change")}. Export diagnostics for details.`);
		if (level === "ok") level = "warn";
		if (snapshot.phase === "live") text = `${text} · ${frozen + quarantined} need attention`;
	}
	if (snapshot.brake && snapshot.phase !== "braked") {
		lines.push(`${brakeHeadline(snapshot.brake)} Click to review.`);
		if (level === "ok" || level === "busy") level = "warn";
	}
	if (nowMs !== undefined && snapshot.lastSyncedAtMs !== null) lines.push(`Last synced ${formatAgo(snapshot.lastSyncedAtMs, nowMs)}.`);
	if (snapshot.relay.connected && snapshot.relay.rttMs !== null) lines.push(`Server round trip ${Math.round(snapshot.relay.rttMs)} ms.`);
	if (snapshot.transport === "inline") lines.push("Running on the main thread (background worker unavailable); sync may be slower.");
	return { text: `${PREFIX}${text}`, tooltip: lines.join("\n"), level };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface StatusBarTimers {
	now(): number;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(handle: number): void;
}

/** Minimal element surface used by the controller (an HTMLElement satisfies it). */
export interface StatusBarElement {
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	addEventListener(type: "click", listener: () => void): void;
	removeEventListener(type: "click", listener: () => void): void;
	readonly classList: { add(...tokens: string[]): void; remove(...tokens: string[]): void };
	readonly style: { display: string };
}

export interface StatusBarOptions {
	/** Click while a brake is pending. */
	openBrake(): void;
	/** Click otherwise. */
	openSettings(): void;
	timers?: StatusBarTimers;
	/** Minimum gap between renders (default 250 ms = at most 4/s). */
	minIntervalMs?: number;
}

const LEVEL_CLASSES = ["yaos-status-ok", "yaos-status-busy", "yaos-status-warn", "yaos-status-error"];

function defaultTimers(): StatusBarTimers {
	return {
		now: () => Date.now(),
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (h) => window.clearTimeout(h),
	};
}

export class StatusBarController {
	private readonly timers: StatusBarTimers;
	private readonly minIntervalMs: number;
	private lastRenderAt = Number.NEGATIVE_INFINITY;
	private pending: number | null = null;
	private unsubscribe: (() => void) | null = null;
	private last: RenderedStatus | null = null;
	private disposed = false;
	private readonly onClick = (): void => {
		if (pendingBrake(this.host)) this.opts.openBrake();
		else this.opts.openSettings();
	};

	constructor(
		private readonly el: StatusBarElement,
		private readonly host: Pick<YaosUiHost, "status" | "runState" | "onChange" | "data" | "brake">,
		private readonly opts: StatusBarOptions,
	) {
		this.timers = opts.timers ?? defaultTimers();
		this.minIntervalMs = opts.minIntervalMs ?? 250;
		el.classList.add("mod-clickable", "yaos-status");
		el.addEventListener("click", this.onClick);
		this.unsubscribe = host.onChange(() => this.schedule());
		this.renderNow();
	}

	/** Request a render; coalesced so renders happen at most once per minIntervalMs. */
	schedule(): void {
		if (this.disposed || this.pending !== null) return;
		const wait = this.lastRenderAt + this.minIntervalMs - this.timers.now();
		if (wait <= 0) {
			this.renderNow();
			return;
		}
		this.pending = this.timers.setTimeout(() => {
			this.pending = null;
			this.renderNow();
		}, wait);
	}

	renderNow(): void {
		if (this.disposed) return;
		this.lastRenderAt = this.timers.now();
		const visible = this.host.data().showStatusBar;
		this.el.style.display = visible ? "" : "none";
		if (!visible) {
			this.last = null;
			return;
		}
		const status = this.host.status();
		const brake = this.host.brake();
		// host.brake() can lead status().brake by one status tick; render it either way.
		const snapshot = status && brake && !status.brake ? { ...status, brake } : status;
		const out = renderStatus(snapshot, this.host.runState(), this.lastRenderAt);
		if (this.last && this.last.text === out.text && this.last.tooltip === out.tooltip && this.last.level === out.level) return;
		this.last = out;
		this.el.textContent = out.text;
		this.el.setAttribute("aria-label", out.tooltip);
		this.el.setAttribute("data-tooltip-position", "top");
		this.el.classList.remove(...LEVEL_CLASSES);
		this.el.classList.add(`yaos-status-${out.level}`);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pending !== null) this.timers.clearTimeout(this.pending);
		this.pending = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.el.removeEventListener("click", this.onClick);
	}
}
