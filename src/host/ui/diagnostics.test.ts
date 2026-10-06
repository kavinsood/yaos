import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticsFileName, diagnosticsSettings, exportDiagnostics, formatDiagnostics, isSecretKey } from "./diagnostics";
import type { DiagnosticsBundle, StatusSnapshot } from "../../protocol/status";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import { DEFAULT_ENGINE_SETTINGS, type YaosPluginData } from "./api";

const STATUS = {
	phase: "live", deviceClass: "desktop", transport: "worker", vaultEpoch: "e1", vaultSeq: 5, headSeq: 5,
	relay: { connected: true, lastCloseCode: null, reconnectInMs: null, rttMs: 20 },
	counts: {
		liveDocs: 1, staleStreams: 0, outboxFrames: 0, outboxBytes: 0, unreceiptedFrames: 0, residentDocs: 1,
		residentBytesEstimate: 10, pendingDiskOps: 0, pendingBlobs: 0, quarantinedRows: 0, frozenDocs: 0, conflictCopiesToday: 0,
	},
	bootstrap: null, brake: null, lastFullReconcileAtMs: null, lastSyncedAtMs: 1, dailyFramesUsed: 3, notices: [],
} satisfies StatusSnapshot;

function bundle(over: Partial<DiagnosticsBundle> = {}): DiagnosticsBundle {
	return {
		generatedAtMs: Date.UTC(2026, 9, 5, 12, 34, 56, 789),
		clientVersion: "2.0.0",
		status: STATUS,
		recentEvents: [{ atMs: 1, code: "ws_open", fields: { zeta: 1, alpha: true } }],
		quarantine: [],
		frozenDocs: [],
		stores: { meta: { records: 1, bytes: 2 }, blobs: { records: 0, bytes: 0 } },
		paths: null,
		...over,
	};
}

const IDENTITY_SECRETS = ["tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "PAIR-CODE-123456", "https://sync.example.com", "vault-secret-id"];

test("formatDiagnostics: stable, recursively sorted key order regardless of input order", () => {
	const a = formatDiagnostics(bundle());
	const shuffled = JSON.parse(JSON.stringify(bundle()), (_k, v: unknown) => {
		if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).reverse());
		return v;
	}) as DiagnosticsBundle;
	assert.equal(formatDiagnostics(shuffled), a);
	const parsed = JSON.parse(a) as { format: string; bundle: Record<string, unknown> };
	assert.equal(parsed.format, "yaos-diagnostics/1");
	assert.deepEqual(Object.keys(parsed.bundle), [...Object.keys(parsed.bundle)].sort());
	assert.ok(a.indexOf('"alpha"') < a.indexOf('"zeta"'));
	assert.ok(a.endsWith("}\n"));
});

test("formatDiagnostics: adds no identity data and redacts secret-looking keys at any depth", () => {
	const out = formatDiagnostics(bundle());
	for (const s of IDENTITY_SECRETS) assert.ok(!out.includes(s), "identity data leaked");
	assert.deepEqual(Object.keys(JSON.parse(out) as object).sort(), ["bundle", "format"]);

	// A hostile/buggy engine smuggling secrets into the bundle still cannot get them into the file.
	const smuggled = {
		...bundle(),
		deviceToken: IDENTITY_SECRETS[0],
		recentEvents: [{ atMs: 1, code: "x", fields: { pairing_code: IDENTITY_SECRETS[1], Authorization: "Bearer abc", ok: 1 } }],
		stores: { nested: { records: 1, bytes: 1, recoveryKey: "rk-very-secret", wsTicket: "tkt-secret" } },
	} as unknown as DiagnosticsBundle;
	const red = formatDiagnostics(smuggled);
	for (const s of [IDENTITY_SECRETS[0], IDENTITY_SECRETS[1], "Bearer abc", "rk-very-secret", "tkt-secret"]) assert.ok(!red.includes(s!), `leaked ${s}`);
	assert.match(red, /"deviceToken": "\[redacted\]"/);
	assert.match(red, /"ok": 1/);
});

test("isSecretKey", () => {
	for (const k of ["deviceToken", "token", "pairingCode", "pairing_code", "recoveryKey", "Authorization", "password", "clientSecret", "wsTicket", "credentials"]) assert.equal(isSecretKey(k), true, k);
	for (const k of ["phase", "outboxFrames", "code", "pathHash", "records", "vaultSeq"]) assert.equal(isSecretKey(k), false, k);
});

test("formatDiagnostics: non-finite numbers and binary are safe", () => {
	const b = { ...bundle(), stores: { x: { records: Number.NaN, bytes: Infinity } }, blob: new Uint8Array(4) } as unknown as DiagnosticsBundle;
	const parsed = JSON.parse(formatDiagnostics(b)) as { bundle: { stores: { x: { records: unknown } }; blob: unknown } };
	assert.equal(parsed.bundle.stores.x.records, null);
	assert.equal(parsed.bundle.blob, "[4 bytes]");
});

test("diagnosticsFileName", () => {
	assert.equal(diagnosticsFileName(Date.UTC(2026, 9, 5, 12, 34, 56, 789)), "yaos-diagnostics-2026-10-05T12-34-56-789Z.json");
	assert.equal(diagnosticsFileName(Number.NaN), "yaos-diagnostics-1970-01-01T00-00-00-000Z.json");
	assert.doesNotMatch(diagnosticsFileName(Date.now()), /[:\\/]/);
	assert.equal(diagnosticsFileName(0, true), "yaos-diagnostics-1970-01-01T00-00-00-000Z-with-file-names.json");
});

const TOKEN = "dtok_9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZ";
const DATA: YaosPluginData = {
	version: 1,
	identity: { host: "https://sync.example.com", vaultId: "v-123", deviceId: "d-456", deviceToken: TOKEN, deviceName: "Laptop", vaultGeneration: "g1" },
	deviceLabel: "Laptop",
	engine: { ...DEFAULT_ENGINE_SETTINGS, excludePatterns: ["Clients/Acme/", "**.tmp"] },
	showStatusBar: true,
};

function fakeHost(result: EngineResultValue | Error, writeFails = false, data: YaosPluginData = DATA) {
	const commands: UserCommand[] = [];
	const writes: { name: string; text: string }[] = [];
	return {
		commands,
		writes,
		host: {
			pluginVersion: "2.1.0",
			data: () => data,
			runState: () => ({ phase: "running" as const, transport: "worker" as const, lastError: null }),
			async command(c: UserCommand): Promise<EngineResultValue> {
				commands.push(c);
				if (result instanceof Error) throw result;
				return result;
			},
			async writeDiagnosticsFile(name: string, text: string): Promise<string> {
				if (writeFails) throw new Error("disk full");
				writes.push({ name, text });
				return `.obsidian/plugins/yaos/diagnostics/${name}`;
			},
		},
	};
}

test("exportDiagnostics: command -> write -> copy -> notify", async () => {
	const b = bundle();
	const h = fakeHost({ t: "diagnostics", bundle: b });
	const notes: [string, string][] = [];
	const copied: string[] = [];
	const res = await exportDiagnostics(h.host, { notify: (m, l) => notes.push([m, l]), copyText: async (t) => { copied.push(t); } });
	assert.deepEqual(h.commands, [{ t: "exportDiagnostics", includePaths: false }]);
	assert.equal(h.writes.length, 1);
	assert.equal(h.writes[0]?.name, "yaos-diagnostics-2026-10-05T12-34-56-789Z.json");
	assert.equal(h.writes[0]?.text, formatDiagnostics(b, diagnosticsSettings(h.host, false)));
	assert.deepEqual(copied, [h.writes[0]?.text]);
	assert.deepEqual(res, { path: ".obsidian/plugins/yaos/diagnostics/yaos-diagnostics-2026-10-05T12-34-56-789Z.json", copied: true });
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.[1], "info");
	assert.match(notes[0]?.[0] ?? "", /copied to the clipboard/);
});

test("exportDiagnostics: failures notify and never throw", async () => {
	const notes: [string, string][] = [];
	const notify = (m: string, l: "info" | "error") => notes.push([m, l]);
	assert.equal(await exportDiagnostics(fakeHost(new Error("engine stopped")).host, { notify }), null);
	assert.equal(await exportDiagnostics(fakeHost({ t: "ok" } as EngineResultValue).host, { notify }), null);
	assert.equal(await exportDiagnostics(fakeHost({ t: "diagnostics", bundle: bundle() }, true).host, { notify }), null);
	const noClip = await exportDiagnostics(fakeHost({ t: "diagnostics", bundle: bundle() }).host, { notify, copyText: async () => { throw new Error("denied"); } });
	assert.equal(noClip?.copied, false);
	assert.deepEqual(notes.map((n) => n[1]), ["error", "error", "error", "info"]);
	assert.match(notes[0]?.[0] ?? "", /engine stopped/);
	assert.match(notes[2]?.[0] ?? "", /disk full/);
	assert.doesNotMatch(notes[3]?.[0] ?? "", /clipboard/);
});

test("exportDiagnostics: settings section names the device and engine settings, never the device token", async () => {
	for (const includePaths of [false, true]) {
		const h = fakeHost({ t: "diagnostics", bundle: bundle() });
		const copied: string[] = [];
		await exportDiagnostics(h.host, { notify: () => {}, copyText: async (t) => { copied.push(t); } }, { includePaths });
		assert.deepEqual(h.commands, [{ t: "exportDiagnostics", includePaths }]);
		const text = h.writes[0]?.text ?? "";
		for (const out of [text, copied[0] ?? ""]) {
			assert.ok(!out.includes(TOKEN), "device token leaked");
			assert.ok(!out.includes(TOKEN.slice(5, 20)), "part of the device token leaked");
		}
		const s = (JSON.parse(text) as { settings: Record<string, unknown> }).settings;
		assert.deepEqual(Object.keys(s).sort(), ["deviceId", "deviceLabel", "engine", "host", "pluginVersion", "transport", "vaultId"]);
		assert.equal(s.host, "https://sync.example.com");
		assert.equal(s.vaultId, "v-123");
		assert.equal(s.deviceId, "d-456");
		assert.equal(s.pluginVersion, "2.1.0");
		assert.equal(s.transport, "worker");
		const engine = s.engine as Record<string, unknown>;
		assert.equal(engine.excludePatternCount, 2);
		assert.equal(engine.syncAttachments, DEFAULT_ENGINE_SETTINGS.syncAttachments);
		// Exclude patterns name folders: only with the file-names opt-in.
		assert.equal(text.includes("Clients/Acme/"), includePaths);
		assert.equal(h.writes[0]?.name.endsWith("-with-file-names.json"), includePaths);
	}
});

test("diagnosticsSettings: unpaired device has null identity fields", () => {
	const s = diagnosticsSettings({ pluginVersion: "2.1.0", data: () => ({ ...DATA, identity: null }), runState: () => ({ phase: "stopped", transport: null, lastError: null }) }, false);
	assert.deepEqual([s.host, s.vaultId, s.deviceId, s.transport], [null, null, null, null]);
	assert.equal("excludePatterns" in s.engine, false);
});
