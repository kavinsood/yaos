import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, StatusBarController, unsyncedCount, type StatusBarElement, type StatusBarTimers } from "./statusBar";
import { defaultPluginData, type EngineRunState, type YaosPluginData } from "./api";
import type { EnginePhase, StatusSnapshot } from "../../protocol/status";
import type { BrakeReport } from "../../core/types";

const RUNNING: EngineRunState = { phase: "running", transport: "worker", lastError: null };

type Counts = StatusSnapshot["counts"];

function snap(phase: EnginePhase, over: Partial<Omit<StatusSnapshot, "counts">> & { counts?: Partial<Counts> } = {}): StatusSnapshot {
	const { counts, ...rest } = over;
	return {
		phase,
		deviceClass: "desktop",
		transport: "worker",
		vaultEpoch: "e1",
		vaultSeq: 10,
		headSeq: 10,
		relay: { connected: true, lastCloseCode: null, reconnectInMs: null, rttMs: null },
		counts: {
			liveDocs: 3, staleStreams: 0, outboxFrames: 0, outboxBytes: 0, unreceiptedFrames: 0, residentDocs: 3,
			residentBytesEstimate: 0, pendingDiskOps: 0, pendingBlobs: 0, quarantinedRows: 0, frozenDocs: 0, conflictCopiesToday: 0,
			...counts,
		},
		bootstrap: null,
		brake: null,
		lastFullReconcileAtMs: null,
		lastSyncedAtMs: null,
		dailyFramesUsed: 0,
		maxBlobBytes: null,
		notices: [],
		...rest,
	};
}

const BRAKE: BrakeReport = { id: "brk-1", reason: "mass-delete-remote", heldCount: 120, syncedCount: 400, samplePaths: ["a.md"] };

const EXPECTED: Record<EnginePhase, { text: string; level: string }> = {
	"starting": { text: "YAOS: starting…", level: "busy" },
	"recovering": { text: "YAOS: recovering…", level: "busy" },
	"bootstrapping": { text: "YAOS: downloading vault…", level: "busy" },
	"catching-up": { text: "YAOS: catching up", level: "busy" },
	"live": { text: "YAOS: synced", level: "ok" },
	"offline": { text: "YAOS: offline", level: "warn" },
	"paused": { text: "YAOS: paused", level: "warn" },
	"braked": { text: "YAOS: needs approval", level: "warn" },
	"daily-limit": { text: "YAOS: daily limit", level: "warn" },
	"superseded": { text: "YAOS: reconnecting", level: "warn" },
	"revoked": { text: "YAOS: re-pair device", level: "error" },
	"epoch-migrating": { text: "YAOS: re-syncing vault", level: "busy" },
	"upgrade-required": { text: "YAOS: update required", level: "error" },
	"error": { text: "YAOS: error", level: "error" },
};

test("renderStatus covers every EnginePhase with a non-empty tooltip", () => {
	for (const phase of Object.keys(EXPECTED) as EnginePhase[]) {
		const out = renderStatus(snap(phase), RUNNING);
		assert.equal(out.text, EXPECTED[phase].text, phase);
		assert.equal(out.level, EXPECTED[phase].level, phase);
		assert.ok(out.tooltip.length > 0, phase);
	}
});

test("renderStatus: unsynced count is outbox + unreceipted, shown per phase", () => {
	const counts = { outboxFrames: 3, unreceiptedFrames: 2 };
	assert.equal(unsyncedCount(snap("live", { counts })), 5);
	assert.equal(renderStatus(snap("live", { counts }), RUNNING).text, "YAOS: syncing · 5 unsynced");
	assert.equal(renderStatus(snap("live", { counts }), RUNNING).level, "busy");
	assert.equal(renderStatus(snap("offline", { counts }), RUNNING).text, "YAOS: offline · 5 unsynced");
	assert.equal(renderStatus(snap("paused", { counts }), RUNNING).text, "YAOS: paused · 5 unsynced");
	assert.equal(renderStatus(snap("daily-limit", { counts }), RUNNING).text, "YAOS: daily limit · 5 unsynced");
	assert.match(renderStatus(snap("live", { counts }), RUNNING).tooltip, /3 queued, 2 awaiting server receipt/);
	assert.equal(unsyncedCount(snap("live", { counts: { outboxFrames: -1 } })), 0);
});

test("renderStatus: bootstrap and catch-up progress", () => {
	const bootstrap = { docsTotal: 200, docsMaterialized: 37 };
	assert.equal(renderStatus(snap("bootstrapping", { bootstrap }), RUNNING).text, "YAOS: downloading 37/200");
	assert.equal(renderStatus(snap("bootstrapping", { bootstrap: { docsTotal: 5, docsMaterialized: 9 } }), RUNNING).text, "YAOS: downloading 5/5");
	assert.equal(renderStatus(snap("catching-up", { bootstrap, counts: { outboxFrames: 1, staleStreams: 4 } }), RUNNING).text, "YAOS: catching up 37/200 · 1 unsynced");
	assert.match(renderStatus(snap("catching-up", { counts: { staleStreams: 4 } }), RUNNING).tooltip, /4 streams behind/);
});

test("renderStatus: offline reconnect, error notice, revoked", () => {
	const offline = snap("offline", { relay: { connected: false, lastCloseCode: 1006, reconnectInMs: 12_000, rttMs: null } });
	assert.match(renderStatus(offline, RUNNING).tooltip, /Reconnecting in 12 s/);
	assert.match(renderStatus(snap("offline", { relay: { connected: false, lastCloseCode: null, reconnectInMs: null, rttMs: null } }), RUNNING).tooltip, /Waiting for the network/);
	const err = snap("error", { notices: [{ code: "old", level: "error", atMs: 1 }, { code: "disk_full", level: "error", atMs: 5 }, { code: "info_x", level: "info", atMs: 9 }] });
	assert.match(renderStatus(err, RUNNING).tooltip, /disk_full/);
	assert.doesNotMatch(renderStatus(err, RUNNING).tooltip, /info_x/);
	assert.match(renderStatus(snap("revoked"), RUNNING).tooltip, /Pair this device again/);
});

test("renderStatus: brake, attention counts, last synced, rtt, inline transport", () => {
	assert.match(renderStatus(snap("braked", { brake: BRAKE }), RUNNING).tooltip, /holding 120 changes/);
	const liveWithBrake = renderStatus(snap("live", { brake: BRAKE }), RUNNING);
	assert.equal(liveWithBrake.level, "warn");
	assert.match(liveWithBrake.tooltip, /Click to review/);
	const attention = renderStatus(snap("live", { counts: { frozenDocs: 1, quarantinedRows: 2 } }), RUNNING);
	assert.equal(attention.text, "YAOS: synced · 3 need attention");
	assert.equal(attention.level, "warn");
	const rich = renderStatus(snap("live", { lastSyncedAtMs: 1_000, relay: { connected: true, lastCloseCode: null, reconnectInMs: null, rttMs: 41.6 }, transport: "inline" }), RUNNING, 181_000);
	assert.match(rich.tooltip, /Last synced 3 min ago/);
	assert.match(rich.tooltip, /round trip 42 ms/);
	assert.match(rich.tooltip, /main thread/);
	assert.doesNotMatch(renderStatus(snap("live", { lastSyncedAtMs: 1_000 }), RUNNING).tooltip, /Last synced/);
});

test("renderStatus: run phases take precedence over the snapshot", () => {
	const live = snap("live");
	assert.deepEqual(
		[
			renderStatus(live, { phase: "unpaired", transport: null, lastError: null }),
			renderStatus(live, { phase: "stopped", transport: null, lastError: null }),
			renderStatus(live, { phase: "starting", transport: null, lastError: null }),
		].map((r) => [r.text, r.level]),
		[["YAOS: not paired", "warn"], ["YAOS: stopped", "warn"], ["YAOS: starting…", "busy"]],
	);
	const failed = renderStatus(live, { phase: "failed", transport: null, lastError: "worker crashed" });
	assert.equal(failed.text, "YAOS: stopped (error)");
	assert.equal(failed.level, "error");
	assert.match(failed.tooltip, /worker crashed/);
	assert.equal(renderStatus(null, RUNNING).text, "YAOS: starting…");
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class FakeElement implements StatusBarElement {
	textContent: string | null = null;
	attrs = new Map<string, string>();
	classes = new Set<string>();
	listeners = new Set<() => void>();
	style = { display: "" };
	writes = 0;
	readonly classList = {
		add: (...t: string[]) => { for (const c of t) this.classes.add(c); },
		remove: (...t: string[]) => { for (const c of t) this.classes.delete(c); },
	};
	setAttribute(name: string, value: string): void {
		if (name === "aria-label") this.writes++;
		this.attrs.set(name, value);
	}
	addEventListener(_t: "click", l: () => void): void { this.listeners.add(l); }
	removeEventListener(_t: "click", l: () => void): void { this.listeners.delete(l); }
	click(): void { for (const l of this.listeners) l(); }
}

class FakeTimers implements StatusBarTimers {
	t = 1_000;
	nextId = 1;
	queue = new Map<number, { at: number; fn: () => void }>();
	now(): number { return this.t; }
	setTimeout(fn: () => void, ms: number): number { const id = this.nextId++; this.queue.set(id, { at: this.t + ms, fn }); return id; }
	clearTimeout(id: number): void { this.queue.delete(id); }
	advance(ms: number): void {
		const end = this.t + ms;
		for (;;) {
			let next: [number, { at: number; fn: () => void }] | null = null;
			for (const e of this.queue) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
			if (!next) break;
			this.queue.delete(next[0]);
			this.t = next[1].at;
			next[1].fn();
		}
		this.t = end;
	}
}

function makeHost(initial: StatusSnapshot | null) {
	let status = initial;
	let brake: BrakeReport | null = null;
	let data: YaosPluginData = defaultPluginData("Mac");
	const listeners = new Set<() => void>();
	return {
		host: {
			status: () => status,
			runState: () => RUNNING,
			data: () => data,
			brake: () => brake,
			onChange: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
		},
		set(s: StatusSnapshot | null) { status = s; for (const l of listeners) l(); },
		setBrake(b: BrakeReport | null) { brake = b; for (const l of listeners) l(); },
		setData(d: YaosPluginData) { data = d; },
		listeners,
	};
}

test("controller renders immediately, then throttles to at most one render per 250 ms", () => {
	const el = new FakeElement();
	const timers = new FakeTimers();
	const h = makeHost(snap("live"));
	const opens: string[] = [];
	const c = new StatusBarController(el, h.host, { openBrake: () => opens.push("brake"), openSettings: () => opens.push("settings"), timers });
	assert.equal(el.textContent, "YAOS: synced");
	assert.ok(el.classes.has("yaos-status-ok") && el.classes.has("mod-clickable"));
	assert.equal(el.writes, 1);

	for (let i = 1; i <= 20; i++) {
		h.set(snap("live", { counts: { outboxFrames: i } }));
		timers.advance(10);
	}
	// 200 ms elapsed since the first render: nothing new rendered yet; one trailing render pending.
	assert.equal(el.writes, 1);
	timers.advance(50);
	assert.equal(el.writes, 2);
	assert.equal(el.textContent, "YAOS: syncing · 20 unsynced");
	assert.ok(el.classes.has("yaos-status-busy") && !el.classes.has("yaos-status-ok"));

	// Over one simulated second of constant updates, at most 4 renders.
	const before = el.writes;
	for (let i = 0; i < 100; i++) {
		h.set(snap("offline", { counts: { outboxFrames: 100 + i } }));
		timers.advance(10);
	}
	assert.ok(el.writes - before <= 4, `rendered ${el.writes - before} times in 1 s`);

	c.dispose();
	assert.equal(h.listeners.size, 0);
	assert.equal(el.listeners.size, 0);
	assert.equal(timers.queue.size, 0);
});

test("controller skips identical renders", () => {
	const el = new FakeElement();
	const timers = new FakeTimers();
	const h = makeHost(snap("live"));
	new StatusBarController(el, h.host, { openBrake() {}, openSettings() {}, timers });
	timers.advance(1_000);
	h.set(snap("live"));
	timers.advance(1_000);
	assert.equal(el.writes, 1);
});

test("controller click routes to brake modal when a brake is pending, else settings", () => {
	const el = new FakeElement();
	const timers = new FakeTimers();
	const h = makeHost(snap("live"));
	const opens: string[] = [];
	new StatusBarController(el, h.host, { openBrake: () => opens.push("brake"), openSettings: () => opens.push("settings"), timers });
	el.click();
	h.setBrake(BRAKE);
	el.click();
	h.setBrake(null);
	h.set(snap("braked", { brake: BRAKE }));
	el.click();
	assert.deepEqual(opens, ["settings", "brake", "brake"]);
});

test("controller merges host.brake() into the snapshot and hides when the status bar is off", () => {
	const el = new FakeElement();
	const timers = new FakeTimers();
	const h = makeHost(snap("live"));
	const c = new StatusBarController(el, h.host, { openBrake() {}, openSettings() {}, timers });
	h.setBrake(BRAKE);
	timers.advance(300);
	assert.equal(el.attrs.get("aria-label")?.includes("holding 120 changes"), true);
	h.setData({ ...defaultPluginData("Mac"), showStatusBar: false });
	c.renderNow();
	assert.equal(el.style.display, "none");
	h.setData(defaultPluginData("Mac"));
	c.renderNow();
	assert.equal(el.style.display, "");
	assert.ok(el.textContent?.startsWith("YAOS: "));
});
