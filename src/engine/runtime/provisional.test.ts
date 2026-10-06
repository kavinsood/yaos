import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocId } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { applyChanges, type TextChanges } from "../body/textChanges";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, until } from "./testHarness";

/** A bound editor as main keeps it: bind() + boundText, onBoundText changes from others, typing via applyEditorChanges. */
class View {
	text = "";
	constructor(readonly engine: LogEngine, readonly docId: DocId) {}
	async open(): Promise<void> {
		await this.engine.bind(this.docId);
		this.text = this.engine.boundText(this.docId);
	}
	receive(changes: TextChanges): void {
		applyChanges({
			insert: (i, t) => void (this.text = this.text.slice(0, i) + t + this.text.slice(i)),
			delete: (i, n) => void (this.text = this.text.slice(0, i) + this.text.slice(i + n)),
		}, changes);
	}
	type(s: string, at = this.text.length): void {
		const changes: TextChanges = at > 0 ? [at, [0, s]] : [[0, s]];
		if (this.text.length > at) changes.push(this.text.length - at);
		assert.ok(this.engine.applyEditorChanges(this.docId, changes));
		this.text = this.text.slice(0, at) + s + this.text.slice(at);
	}
}

async function pair(relay: SimRelay) {
	const views = new Map<string, View>();
	const origins: Record<string, string[]> = { a: [], b: [] };
	const mk = (dev: "a" | "b") => startTestEngine({ relay, deviceId: `dev-${dev}`, extra: {
		onBoundText: (d: DocId, changes: TextChanges, _length: number, o: string) => {
			origins[dev]!.push(o);
			if (o !== "editor") views.get(`${dev}:${d}`)?.receive(changes);
		},
	} });
	const { engine: a } = await mk("a");
	const { engine: b } = await mk("b");
	await until(() => a.status().phase === "live" && b.status().phase === "live", 3_000, "live");
	const view = async (dev: "a" | "b", e: LogEngine, id: DocId) => {
		const v = new View(e, id);
		views.set(`${dev}:${id}`, v);
		await v.open();
		return v;
	};
	return { a, b, view, origins };
}

test("provisional: bound peer applies provisional, adopts, settles on commit", async () => {
	const relay = new SimRelay();
	const { a, b, view, origins } = await pair(relay);
	try {
		const id = await a.createDoc("p.md", "base");
		await converged([a, b]);
		const va = await view("a", a, id);
		const vb = await view("b", b, id);
		for (const ch of "typing") va.type(ch);
		await until(() => vb.text === "basetyping", 3_000, "b sees keystrokes");
		await converged([a, b]);
		assert.ok(origins.b!.includes("provisional"), "b forwarded a provisional update");
		const bc = b.c;
		assert.ok(bc.docs.stats.adopted >= 1, "b adopted");
		assert.equal(bc.outbox.size, 0, "adoptables settled");
		assert.equal(bc.adoptMap.size, 0);
		assert.equal(relay.rows("b:" + id as never).filter((r) => r.deviceId === "dev-b").length, 0, "b never appended its adoptable");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("provisional: dropped provisional -> adoptable sent as own frame; converges", async () => {
	const relay = new SimRelay();
	const { a, b, view } = await pair(relay);
	try {
		const id = await a.createDoc("d.md", "x");
		await converged([a, b]);
		const va = await view("a", a, id);
		const vb = await view("b", b, id);
		relay.failNextCommit("durability");
		va.type("Y");
		await until(() => b.c.docs.stats.adoptToPending >= 1, 3_000, "adopt -> pending on drop");
		await converged([a, b]);
		assert.equal(vb.text, "xY");
		assert.equal(await b.docText(id), "xY");
		assert.equal(await a.docText(id), "xY");
		assert.ok(relay.rows(("b:" + id) as never).some((r) => r.deviceId === "dev-b"), "b re-appended the adopted frame");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("provisional: no commit within provisionalAdoptMs -> pending; commits once resumed", async () => {
	const relay = new SimRelay();
	const { a, b, view } = await pair(relay);
	try {
		const id = await a.createDoc("t.md", "");
		await converged([a, b]);
		const va = await view("a", a, id);
		await view("b", b, id);
		relay.pauseCommits();
		va.type("slow");
		await until(() => b.c.docs.stats.adopted >= 1, 3_000, "adopted");
		await until(() => b.c.docs.stats.adoptToPending >= 1, 3_000, "timeout -> pending");
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await b.docText(id), "slow");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("resend: relay restart loses unreceipted frames; STREAM_RESEND resends them", async () => {
	const relay = new SimRelay();
	const { a, b } = await pair(relay);
	try {
		const id = await a.createDoc("r.md", "one");
		await converged([a, b]);
		relay.pauseCommits();
		await a.editDoc(id, (t) => t.insert(3, " two"));
		await until(() => a.c.sender.inflightCount > 0, 2_000, "inflight");
		relay.restart();
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await b.docText(id), "one two");
		assert.equal(a.c.outbox.size, 0);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("send window: many frames stay within maxInflightAppendBytes and all commit", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: { maxInflightAppendBytes: 2_000 } } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		await until(() => a.status().phase === "live", 3_000, "live");
		const id = await a.createDoc("w.md", "");
		relay.pauseCommits();
		for (let i = 0; i < 20; i++) await a.editDoc(id, (t) => t.insert(t.length, `line ${i} ${"z".repeat(300)}\n`));
		await sleep(50);
		assert.ok(a.c.sender.inflightByteCount <= 2_000 + 400, `inflight bytes ${a.c.sender.inflightByteCount}`);
		assert.ok(a.c.sender.queued > 0, "window held frames back");
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal((await b.docText(id)).split("\n").length, 21);
	} finally {
		await a.stop();
		await b.stop();
	}
});
