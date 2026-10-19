import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyStream, type ClientFrameId, type DocId } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { applyChanges, type TextChanges } from "../body/textChanges";
import type { LogEngine } from "./engine";
import type { EngineTuning } from "./options";
import { converged, sleep, startTestEngine, until, createDoc, docText, editDoc } from "./testHarness";

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

async function pair(relay: SimRelay, tuning: Partial<EngineTuning> = {}) {
	const views = new Map<string, View>();
	const origins: Record<string, string[]> = { a: [], b: [] };
	const mk = (dev: "a" | "b") => startTestEngine({ relay, deviceId: `dev-${dev}`, tuning, extra: {
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

/** The device's adoptable on `id`'s stream (DESIGN §d.5), if any. */
const adoptableOf = (e: LogEngine, id: DocId) => e.c.outbox.ofStream(bodyStream(id)).find((r) => r.state === "adoptable") ?? null;
/** The device's own (non-adopted) outbox records on `id`'s stream. */
const ownOf = (e: LogEngine, id: DocId) => e.c.outbox.ofStream(bodyStream(id)).filter((r) => r.adoptOf === null);

test("provisional: bound peer applies provisional, adopts, settles on commit", async () => {
	const relay = new SimRelay();
	const { a, b, view, origins } = await pair(relay);
	try {
		const id = await createDoc(a, "p.md", "base");
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
		const id = await createDoc(a, "d.md", "x");
		await converged([a, b]);
		const va = await view("a", a, id);
		const vb = await view("b", b, id);
		relay.failNextCommit("durability");
		va.type("Y");
		await until(() => vb.text === "xY", 3_000, "b applied the provisional");
		vb.type("Z");
		await until(() => b.c.docs.stats.adoptToPending >= 1, 3_000, "adopt -> pending on drop");
		await converged([a, b]);
		assert.equal(vb.text, "xYZ");
		assert.equal(await docText(b, id), "xYZ");
		assert.equal(await docText(a, id), "xYZ");
		const fromB = relay.rows(("b:" + id) as never).filter((r) => r.deviceId === "dev-b");
		assert.ok(fromB.length >= 2, "b re-appended the adopted frame, and its own edit");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("provisional: no commit within provisionalAdoptMs -> pending; commits once resumed", async () => {
	const relay = new SimRelay();
	const { a, b, view } = await pair(relay);
	try {
		const id = await createDoc(a, "t.md", "");
		await converged([a, b]);
		const va = await view("a", a, id);
		const vb = await view("b", b, id);
		relay.pauseCommits();
		va.type("slow");
		await until(() => b.c.docs.stats.adopted >= 1 && vb.text === "slow", 3_000, "adopted");
		const adopted = adoptableOf(b, id)!.clientFrameId;
		vb.type("!");
		await until(() => b.c.docs.stats.adoptToPending >= 1, 3_000, "timeout -> pending");
		await until(() => b.c.sender.inflightCount >= 2, 3_000, "the adopted copy is re-appended next to b's own frame");
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await docText(b, id), "slow!");
		assert.equal(await docText(a, id), "slow!");
		assert.ok(relay.rows(("b:" + id) as never).some((r) => r.deviceId === "dev-b" && r.clientFrameId === adopted), "b's adopted copy committed");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("provisional: an adoptable holds nothing: own frames typed on top are pending and go out before the adopted frame's commit", async () => {
	const relay = new SimRelay();
	// A long adopt timeout: the adoptable stays adoptable for the whole test.
	const { a, b, view } = await pair(relay, { provisionalAdoptMs: 60_000 });
	try {
		const id = await createDoc(a, "h.md", "");
		await converged([a, b]);
		const va = await view("a", a, id);
		const vb = await view("b", b, id);
		relay.pauseCommits();
		va.type("A");
		await until(() => adoptableOf(b, id) !== null && vb.text === "A", 3_000, "b adopted a's provisional");
		const adopted: ClientFrameId = adoptableOf(b, id)!.clientFrameId;
		vb.type("B");
		await until(() => ownOf(b, id).length > 0, 3_000, "b closed a frame");
		const [own] = ownOf(b, id);
		assert.notEqual(own!.state, "held", "not held behind the adoptable");
		assert.equal(own!.dependsOn, null);
		await until(() => b.c.sender.inflightCount === 1, 3_000, "b's frame is on the wire");
		assert.equal(relay.pendingCount(), 2, "a's frame and b's, neither committed");
		assert.equal(adoptableOf(b, id)?.clientFrameId, adopted, "the adoptable is still waiting for a's commit");
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await docText(a, id), "AB");
		assert.equal(await docText(b, id), "AB");
		assert.equal(b.c.outbox.size, 0, "the adoptable settled on a's commit");
		assert.ok(!relay.rows(("b:" + id) as never).some((r) => r.clientFrameId === adopted), "and was never appended");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("resend: relay restart loses unreceipted frames; STREAM_RESEND resends them", async () => {
	const relay = new SimRelay();
	const { a, b } = await pair(relay);
	try {
		const id = await createDoc(a, "r.md", "one");
		await converged([a, b]);
		relay.pauseCommits();
		await editDoc(a, id, (t) => t.insert(3, " two"));
		await until(() => a.c.sender.inflightCount > 0, 2_000, "inflight");
		relay.restart();
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await docText(b, id), "one two");
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
		const id = await createDoc(a, "w.md", "");
		relay.pauseCommits();
		for (let i = 0; i < 20; i++) await editDoc(a, id, (t) => t.insert(t.length, `line ${i} ${"z".repeat(300)}\n`));
		await sleep(50);
		assert.ok(a.c.sender.inflightByteCount <= 2_000 + 400, `inflight bytes ${a.c.sender.inflightByteCount}`);
		assert.ok(a.c.sender.queued > 0, "window held frames back");
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal((await docText(b, id)).split("\n").length, 21);
	} finally {
		await a.stop();
		await b.stop();
	}
});
