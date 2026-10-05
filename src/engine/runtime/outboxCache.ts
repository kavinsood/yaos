/**
 * In-memory mirror of the outbox store (every state). Updated only from
 * committed transaction results (tEdit / tLive / tReadPage / tOutbox), so it
 * equals the DB between transactions. Bounded by OUTBOX_SOFT_BYTES in practice.
 */

import { streamClass, type ClientFrameId, type StreamName } from "../../core/types";
import type { OutboxRecord } from "../store/schema";

export class OutboxCache {
	private readonly byId = new Map<ClientFrameId, OutboxRecord>();
	private readonly byStream = new Map<StreamName, Map<ClientFrameId, OutboxRecord>>();
	private bytes = 0;

	get size(): number {
		return this.byId.size;
	}
	get totalBytes(): number {
		return this.bytes;
	}

	get(cfid: ClientFrameId): OutboxRecord | undefined {
		return this.byId.get(cfid);
	}
	has(cfid: ClientFrameId): boolean {
		return this.byId.has(cfid);
	}
	all(): OutboxRecord[] {
		return [...this.byId.values()].sort((a, b) => a.order - b.order);
	}
	values(): IterableIterator<OutboxRecord> {
		return this.byId.values();
	}
	ofStream(stream: StreamName): OutboxRecord[] {
		const m = this.byStream.get(stream);
		return m ? [...m.values()].sort((a, b) => a.order - b.order) : [];
	}

	put(rec: OutboxRecord): void {
		this.delete(rec.clientFrameId);
		this.byId.set(rec.clientFrameId, rec);
		let m = this.byStream.get(rec.stream);
		if (!m) this.byStream.set(rec.stream, (m = new Map()));
		m.set(rec.clientFrameId, rec);
		this.bytes += rec.sealed.length;
	}
	delete(cfid: ClientFrameId): OutboxRecord | undefined {
		const old = this.byId.get(cfid);
		if (!old) return undefined;
		this.byId.delete(cfid);
		const m = this.byStream.get(old.stream);
		if (m) {
			m.delete(cfid);
			if (m.size === 0) this.byStream.delete(old.stream);
		}
		this.bytes -= old.sealed.length;
		return old;
	}

	/** Newest adoptable of the stream (dependsOn target for new own frames, DESIGN §d.5). */
	newestAdoptable(stream: StreamName): OutboxRecord | null {
		let best: OutboxRecord | null = null;
		const m = this.byStream.get(stream);
		if (!m) return null;
		for (const r of m.values()) if (r.state === "adoptable" && (!best || r.order > best.order)) best = r;
		return best;
	}

	/** Dependency of the newest held record of the stream (an unfolded ns create), if any. */
	heldDependency(stream: StreamName): ClientFrameId | null {
		let best: OutboxRecord | null = null;
		const m = this.byStream.get(stream);
		if (!m) return null;
		for (const r of m.values()) if (r.state === "held" && r.dependsOn && (!best || r.order > best.order)) best = r;
		return best ? best.dependsOn : null;
	}

	/** Compaction precondition (DESIGN §d.8): no own pending / sent / held record of the stream. */
	blocksCompaction(stream: StreamName): boolean {
		const m = this.byStream.get(stream);
		if (!m) return false;
		for (const r of m.values()) if (r.state === "pending" || r.state === "sent" || r.state === "held") return true;
		return false;
	}

	/** Unreceipted (pending / sent) count. */
	unreceipted(): number {
		let n = 0;
		for (const r of this.byId.values()) if (r.state === "pending" || r.state === "sent") n++;
		return n;
	}

	/** Own x: chunk records with order below `order` (a bodyUpdateRef waits for the last one). */
	lastChunkBefore(order: number, stream?: StreamName): OutboxRecord | null {
		let best: OutboxRecord | null = null;
		for (const r of this.byId.values()) {
			if (streamClass(r.stream) !== "blobchunk" || r.order >= order) continue;
			if (stream && r.stream !== stream) continue;
			if (!best || r.order > best.order) best = r;
		}
		return best;
	}
}
