/**
 * STAND-IN relay for the stand-in engine (pre-integration simulation only).
 * INTEGRATION: replaced by WP-A's sim/relay.ts behind WP-C's RelayPort.
 *
 * One shared Y.Doc per doc key ("server state"); members publish Yjs updates
 * and receive everyone else's after a per-member FIFO latency. Doc identity
 * is first-come: `create` registers a key synchronously (the identity service
 * is always reachable), content travels through the normal update path.
 *
 * Offline members: uplink updates queue in the member outbox and downlink
 * deliveries are held; going online flushes the outbox and then delivers the
 * full hub state of every doc (Yjs applies idempotently).
 */

import * as Y from "yjs";
import type { ClockPort } from "../../ports/clock";

export interface HubDocInfo {
	readonly key: string;
	readonly path: string;
}

export interface HubListener {
	/** A doc update from another member (or a full-state resync after reconnect). */
	onUpdate(key: string, path: string, update: Uint8Array): void;
}

interface Member {
	readonly id: string;
	listener: HubListener | null;
	online: boolean;
	outbox: { key: string; update: Uint8Array }[];
	lastDue: number;
	inflight: Set<number>;
}

export class StandinHub {
	private readonly docs = new Map<string, { path: string; doc: Y.Doc }>();
	private readonly members = new Map<string, Member>();
	/** Counters for invariants/tests. */
	readonly stats = { published: 0, delivered: 0, creates: 0, createConflicts: 0 };

	constructor(
		private readonly clock: ClockPort,
		private readonly latencyMs: () => number = () => 5,
	) {}

	/** Join (or re-join after an engine restart) as `id`. The previous listener of `id` is replaced. */
	join(id: string, listener: HubListener): HubMemberHandle {
		let m = this.members.get(id);
		if (!m) {
			m = { id, listener: null, online: true, outbox: [], lastDue: 0, inflight: new Set() };
			this.members.set(id, m);
		}
		// Deliveries scheduled for the previous incarnation are dropped (it is gone).
		for (const t of m.inflight) this.clock.clearTimer(t);
		m.inflight.clear();
		m.listener = listener;
		const member = m;
		if (member.online) this.resyncTo(member);
		return new HubMemberHandle(this, member.id, () => {
			if (member.listener === listener) member.listener = null;
		});
	}

	setOnline(id: string, online: boolean): void {
		const m = this.members.get(id);
		if (!m || m.online === online) return;
		m.online = online;
		if (!online) {
			for (const t of m.inflight) this.clock.clearTimer(t);
			m.inflight.clear();
			return;
		}
		const out = m.outbox;
		m.outbox = [];
		for (const u of out) this.apply(m, u.key, u.update);
		this.resyncTo(m);
	}

	isOnline(id: string): boolean {
		return this.members.get(id)?.online ?? false;
	}

	/** Server-side text of a doc (invariants). */
	text(key: string): string | null {
		const e = this.docs.get(key);
		return e ? e.doc.getText("text").toString() : null;
	}

	list(): HubDocInfo[] {
		return [...this.docs.entries()].map(([key, e]) => ({ key, path: e.path }));
	}

	pendingFor(id: string): number {
		const m = this.members.get(id);
		return m ? m.inflight.size + m.outbox.length : 0;
	}

	/** True when no update is queued or in flight anywhere. */
	quiet(): boolean {
		for (const m of this.members.values()) if (m.inflight.size > 0 || (m.online && m.outbox.length > 0)) return false;
		return true;
	}

	// --- member operations (via HubMemberHandle) -------------------------------

	/** @internal */
	create(_id: string, key: string, path: string): boolean {
		if (this.docs.has(key)) {
			this.stats.createConflicts++;
			return false;
		}
		this.stats.creates++;
		this.docs.set(key, { path, doc: new Y.Doc() });
		return true;
	}

	/** @internal */
	has(key: string): boolean {
		return this.docs.has(key);
	}

	/** @internal */
	state(key: string): Uint8Array | null {
		const e = this.docs.get(key);
		return e ? Y.encodeStateAsUpdate(e.doc) : null;
	}

	/** @internal */
	pathOf(key: string): string | null {
		return this.docs.get(key)?.path ?? null;
	}

	/** @internal */
	publish(id: string, key: string, update: Uint8Array): void {
		const m = this.members.get(id);
		if (!m) return;
		this.stats.published++;
		if (!m.online) {
			m.outbox.push({ key, update: update.slice() });
			return;
		}
		this.apply(m, key, update);
	}

	private apply(from: Member, key: string, update: Uint8Array): void {
		const e = this.docs.get(key);
		if (!e) return;
		Y.applyUpdate(e.doc, update);
		for (const m of this.members.values()) {
			if (m === from) continue;
			this.deliver(m, key, e.path, update.slice());
		}
	}

	private resyncTo(m: Member): void {
		for (const [key, e] of this.docs) this.deliver(m, key, e.path, Y.encodeStateAsUpdate(e.doc));
	}

	private deliver(m: Member, key: string, path: string, update: Uint8Array): void {
		if (!m.online || !m.listener) return;
		const now = this.clock.monotonic();
		const due = Math.max(now + Math.max(0, this.latencyMs()), m.lastDue);
		m.lastDue = due;
		const listener = m.listener;
		const handle = this.clock.setTimer(due - now, () => {
			m.inflight.delete(handle);
			if (m.listener !== listener) return;
			this.stats.delivered++;
			listener.onUpdate(key, path, update);
		});
		m.inflight.add(handle);
	}
}

export class HubMemberHandle {
	constructor(
		private readonly hub: StandinHub,
		readonly id: string,
		private readonly onLeave: () => void,
	) {}

	create(key: string, path: string): boolean {
		return this.hub.create(this.id, key, path);
	}

	has(key: string): boolean {
		return this.hub.has(key);
	}

	state(key: string): Uint8Array | null {
		return this.hub.state(key);
	}

	pathOf(key: string): string | null {
		return this.hub.pathOf(key);
	}

	publish(key: string, update: Uint8Array): void {
		this.hub.publish(this.id, key, update);
	}

	leave(): void {
		this.onLeave();
	}
}
