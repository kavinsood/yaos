/**
 * One open frame per stream (DESIGN §d.4). Holds raw update buffers (MAIN
 * bytes as received, MERGE updates from doc.on("update")). Closing merges the
 * small batch; nothing here is O(doc).
 */

import { FRAME_MAX_BYTES, FRAME_MAX_UPDATES, OPEN_FRAME_IDLE_MS, OPEN_FRAME_MAX_MS } from "../../core/limits";
import { mergeSmallBatch } from "./yjsCounters";

export class FrameBuilder {
	private updates: Uint8Array[] = [];
	private bytes = 0;
	private openedAt = 0;
	private lastPushAt = 0;
	private flags = 0;

	get empty(): boolean {
		return this.updates.length === 0;
	}
	get pendingBytes(): number {
		return this.bytes;
	}
	get count(): number {
		return this.updates.length;
	}

	/** Returns true when the frame hit FRAME_MAX_UPDATES / FRAME_MAX_BYTES and must close now. */
	push(update: Uint8Array, nowMono: number, flags = 0): boolean {
		if (this.updates.length === 0) this.openedAt = nowMono;
		this.updates.push(update);
		this.bytes += update.length;
		this.lastPushAt = nowMono;
		this.flags |= flags;
		return this.updates.length >= FRAME_MAX_UPDATES || this.bytes >= FRAME_MAX_BYTES;
	}

	/** Monotonic time the frame should close at (idle or max age), stretched under the daily soft budget. */
	dueAt(stretch = 1): number | null {
		if (this.updates.length === 0) return null;
		return Math.min(this.lastPushAt + OPEN_FRAME_IDLE_MS * stretch, this.openedAt + OPEN_FRAME_MAX_MS * stretch);
	}

	/** Close: content = u[0] or mergeUpdates(small batch). */
	take(): { content: Uint8Array; flags: number; updates: number } | null {
		if (this.updates.length === 0) return null;
		const content = mergeSmallBatch(this.updates);
		const out = { content, flags: this.flags, updates: this.updates.length };
		this.updates = [];
		this.bytes = 0;
		this.flags = 0;
		return out;
	}
}
