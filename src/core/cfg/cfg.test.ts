import { test } from "node:test";
import assert from "node:assert/strict";
import type { CfgFoldState, CfgOp, ClientFrameId, ContentHash, DeviceId } from "../types";
import { CheckpointEncoding } from "../envelope";
import { bytesEqual, utf8Encode } from "../codec/lib0";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "../codec/cfgFoldV1";
import { decodeCfgOps, encodeCfgOps } from "../codec/cfgOps";
import {
	CFG_FOLD_RULES_VERSION,
	changedRegisters,
	cloneCfgFold,
	foldCfgFrame,
	foldCfgFrameWith,
	isConfigRelPath,
	isPluginId,
	jsonRegisterKey,
	newCfgFoldState,
	overlayPendingCfg,
	splitJsonRegisterKey,
	type CfgFoldEvent,
} from "./fold";
import { canonicalJson, canonicalizeJsonText, isCanonicalJson } from "./json";
import {
	applyJsonKeys,
	canApplyPluginData,
	diffCommunityPlugins,
	diffJsonFile,
	enabledPlugins,
	isYaosOwnPath,
	jsonFilesOf,
	jsonRegistersOf,
	pluginIdOfDataJson,
	projectCommunityPlugins,
	projectJsonFile,
	readCommunityPlugins,
	readJsonTopLevel,
} from "./projection";
import { checkCfgInvariants, verifyCfgCheckpoint, verifyCfgFoldBytes } from "./verify";

const A = "devA" as DeviceId;
const B = "devB" as DeviceId;
let fid = 0;
const F = () => `c${(fid++).toString().padStart(21, "0")}` as ClientFrameId;
const H = (n: number) => n.toString(16).padStart(2, "0").repeat(32) as ContentHash;
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function fold(s: CfgFoldState, seq: number, deviceId: DeviceId, ops: CfgOp[], clientFrameId = F()): CfgFoldEvent[] {
	const ev = foldCfgFrame(s, { seq, deviceId, clientFrameId, ops });
	assert.equal(checkCfgInvariants(s), null);
	const bytes = encodeCfgFoldV1(s);
	const v = verifyCfgFoldBytes(bytes, s.coversSeq);
	assert.ok(v.ok, v.ok ? "" : v.detail);
	return ev;
}

test("canonical JSON: sorted keys, compact, rejects non-canonical text", () => {
	assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 1.5 }] }), '{"a":[true,null,{"c":1.5,"d":"x"}],"b":1}');
	assert.equal(canonicalizeJsonText(' { "b" : 1 , "a" : 2 } '), '{"a":2,"b":1}');
	assert.equal(canonicalizeJsonText("1.0"), "1");
	assert.equal(canonicalizeJsonText("{bad"), null);
	assert.ok(isCanonicalJson('{"a":2,"b":1}'));
	assert.ok(!isCanonicalJson('{"b":1,"a":2}'));
	assert.ok(!isCanonicalJson("{ }"));
	assert.ok(isCanonicalJson('"x"'));
	assert.ok(!isCanonicalJson(""));
	// __proto__ is an ordinary own key.
	assert.equal(canonicalizeJsonText('{"z":1,"__proto__":{"y":2}}'), '{"__proto__":{"y":2},"z":1}');
	// Code-unit order (not locale): "B" < "a" < "é".
	assert.equal(canonicalJson({ "é": 1, a: 2, B: 3 }), '{"B":3,"a":2,"é":1}');
	// Too deep: not representable, never throws.
	const deep = "[".repeat(5000) + "]".repeat(5000);
	assert.equal(canonicalizeJsonText(deep), null);
	assert.ok(!isCanonicalJson(deep));
});

test("register keys and structural checks", () => {
	const k = jsonRegisterKey("app.json", "vimMode");
	assert.equal(k, "app.json\u0000vimMode");
	assert.deepEqual(splitJsonRegisterKey(k), { file: "app.json", key: "vimMode" });
	assert.deepEqual(splitJsonRegisterKey(jsonRegisterKey("app.json", "a\u0000b")), { file: "app.json", key: "a\u0000b" });
	assert.equal(splitJsonRegisterKey("nokey"), null);
	for (const p of ["app.json", "plugins/x/data.json", "snippets/a.css"]) assert.ok(isConfigRelPath(p), p);
	for (const p of ["", "/app.json", "a//b", "./a", "a/../b", "a\\b", "a\u0000", "a/"]) assert.ok(!isConfigRelPath(p), JSON.stringify(p));
	assert.ok(isPluginId("dataview"));
	for (const id of ["", "a/b", ".", "..", "a\\b"]) assert.ok(!isPluginId(id), id);
});

test("fold: LWW by (seq, index), tombstones, events, coversSeq", () => {
	const s = newCfgFoldState();
	let ev = fold(s, 1, A, [
		{ t: "jsonSet", file: "app.json", key: "vimMode", valueJson: "true" },
		{ t: "jsonSet", file: "app.json", key: "vimMode", valueJson: "false" },
		{ t: "pluginSet", pluginId: "dataview", enabled: true },
		{ t: "filePut", file: "snippets/a.css", content: { t: "inline", bytes: utf8Encode("a{}") }, pluginVersion: null },
	]);
	assert.deepEqual(ev.map((e) => e.outcome.t), ["applied", "applied", "applied", "applied"]);
	assert.equal(s.coversSeq, 1);
	assert.equal(s.json.get(jsonRegisterKey("app.json", "vimMode"))!.value, "false");
	assert.deepEqual(s.json.get(jsonRegisterKey("app.json", "vimMode"))!.version, { seq: 1, index: 1, deviceId: A });
	assert.deepEqual(changedRegisters(ev).map((r) => `${r.map}:${r.key}`), ["json:app.json\u0000vimMode", "plugins:dataview", "files:snippets/a.css"]);

	ev = fold(s, 2, B, [
		{ t: "jsonSet", file: "app.json", key: "vimMode", valueJson: "false" },
		{ t: "jsonDel", file: "app.json", key: "missing" },
		{ t: "pluginDel", pluginId: "dataview" },
		{ t: "filePut", file: "snippets/a.css", content: { t: "inline", bytes: utf8Encode("a{}") }, pluginVersion: null },
		{ t: "fileDel", file: "snippets/b.css" },
	]);
	assert.deepEqual(ev.map((e) => e.outcome.t), ["same", "applied", "applied", "same", "applied"]);
	assert.deepEqual(s.json.get(jsonRegisterKey("app.json", "vimMode"))!.version, { seq: 2, index: 0, deviceId: B });
	assert.equal(s.json.get(jsonRegisterKey("app.json", "missing"))!.value, null);
	assert.equal(s.plugins.get("dataview")!.value, null);
	assert.equal(s.files.get("snippets/b.css")!.value, null);
	assert.deepEqual(changedRegisters(ev).map((r) => r.key), ["app.json\u0000missing", "dataview", "snippets/b.css"]);

	// Already folded seq: nothing.
	const before = encodeCfgFoldV1(s);
	assert.deepEqual(foldCfgFrame(s, { seq: 2, deviceId: A, clientFrameId: F(), ops: [{ t: "pluginDel", pluginId: "x" }] }), []);
	assert.ok(bytesEqual(before, encodeCfgFoldV1(s)));
});

test("fold: duplicate frames, ring expiry, malformed = empty, invalid ops", () => {
	const s = newCfgFoldState();
	const f1 = F();
	fold(s, 1, A, [{ t: "pluginSet", pluginId: "p", enabled: true }], f1);
	let ev = fold(s, 2, A, [{ t: "pluginSet", pluginId: "p", enabled: false }], f1);
	assert.equal(ev.length, 1);
	assert.deepEqual(ev[0]!.outcome, { t: "ignored", reason: "duplicate-frame" });
	assert.equal(ev[0]!.index, -1);
	assert.equal(s.coversSeq, 2);
	assert.equal(s.plugins.get("p")!.value, true);
	// Same clientFrameId from another device is not a duplicate.
	ev = fold(s, 3, B, [{ t: "pluginSet", pluginId: "p", enabled: false }], f1);
	assert.equal(ev[0]!.outcome.t, "applied");
	// Malformed payload: ops [] still enters the ring and advances coversSeq.
	const fm = F();
	assert.deepEqual(fold(s, 4, A, [], fm), []);
	assert.equal(s.coversSeq, 4);
	assert.ok(s.recentFrames.get(A)!.includes(fm));
	// Ring expiry with a small ring.
	const t = newCfgFoldState();
	const ids = [F(), F(), F()];
	ids.forEach((id, i) => foldCfgFrameWith({ dedupeRing: 2 }, t, { seq: i + 1, deviceId: A, clientFrameId: id, ops: [] }));
	assert.deepEqual(t.recentFrames.get(A), ids.slice(1));
	ev = foldCfgFrameWith({ dedupeRing: 2 }, t, { seq: 4, deviceId: A, clientFrameId: ids[0]!, ops: [{ t: "pluginSet", pluginId: "q", enabled: true }] });
	assert.equal((ev[0]!.outcome as { t: string }).t, "applied");
	// Invalid ops are ignored individually.
	const u = newCfgFoldState();
	ev = fold(u, 1, A, [
		{ t: "jsonSet", file: "app.json", key: "k", valueJson: '{"b":1,"a":2}' },
		{ t: "jsonSet", file: "../app.json", key: "k", valueJson: "1" },
		{ t: "filePut", file: "themes/x/theme.css", content: { t: "blob", hash: "nothex" as ContentHash, size: 1 }, pluginVersion: null },
		{ t: "filePut", file: "plugins/x/data.json", content: { t: "inline", bytes: new Uint8Array() }, pluginVersion: "" },
		{ t: "pluginSet", pluginId: "a/b", enabled: true },
		{ t: "jsonSet", file: "app.json", key: "k", valueJson: '{"a":2,"b":1}' },
	]);
	assert.deepEqual(ev.map((e) => (e.outcome.t === "ignored" ? e.outcome.reason : e.outcome.t)), ["invalid-op", "invalid-op", "invalid-op", "invalid-op", "invalid-op", "applied"]);
	assert.deepEqual(u.json.get(jsonRegisterKey("app.json", "k"))!.version.index, 5);
});

test("cfgFoldV1 round-trip, V1 non-canonical rejection, V2 violations, checkpoint header", () => {
	const s = newCfgFoldState();
	fold(s, 3, A, [
		{ t: "jsonSet", file: "hotkeys.json", key: "editor:toggle", valueJson: '[{"key":"K","modifiers":["Mod"]}]' },
		{ t: "filePut", file: "themes/T/theme.css", content: { t: "blob", hash: H(7), size: 70000 }, pluginVersion: null },
		{ t: "filePut", file: "plugins/dv/data.json", content: { t: "inline", bytes: utf8Encode("{}") }, pluginVersion: "0.5.1" },
		{ t: "pluginSet", pluginId: "dv", enabled: true },
		{ t: "pluginDel", pluginId: "old" },
	]);
	const bytes = encodeCfgFoldV1(s);
	const back = decodeCfgFoldV1(bytes)!;
	assert.ok(bytesEqual(encodeCfgFoldV1(back), bytes));
	assert.deepEqual(back.files.get("plugins/dv/data.json")!.value!.pluginVersion, "0.5.1");
	assert.ok(verifyCfgFoldBytes(bytes, 3).ok);
	const cs = verifyCfgFoldBytes(bytes, 4);
	assert.ok(!cs.ok && cs.reason === "covers-seq");
	// Truncated / trailing bytes: malformed.
	assert.equal((verifyCfgFoldBytes(bytes.subarray(0, bytes.length - 1), 3) as { reason: string }).reason, "malformed");
	const trailing = new Uint8Array(bytes.length + 1);
	trailing.set(bytes);
	assert.equal((verifyCfgFoldBytes(trailing, 3) as { reason: string }).reason, "malformed");
	// Non-minimal varuint for formatVersion (0x81 0x00 = 1): decoder rejects.
	const nm = new Uint8Array(bytes.length + 1);
	nm.set([0x81, 0x00], 0);
	nm.set(bytes.subarray(1), 2);
	assert.ok(!verifyCfgFoldBytes(nm, 3).ok);

	// V2 violations.
	const bad = (mut: (t: CfgFoldState) => void, re: RegExp) => {
		const t = cloneCfgFold(s);
		mut(t);
		const e = checkCfgInvariants(t);
		assert.ok(e !== null && re.test(e), `${e} !~ ${re}`);
	};
	bad((t) => { t.json.set("app.json\u0000x", { value: "{ }", version: { seq: 1, index: 9, deviceId: A } }); }, /invalid value/);
	bad((t) => { t.json.set("noNul", { value: "1", version: { seq: 1, index: 9, deviceId: A } }); }, /invalid key/);
	bad((t) => { t.plugins.set("x", { value: true, version: { seq: 3, index: 0, deviceId: A } }); }, /used twice/);
	bad((t) => { t.plugins.set("x", { value: true, version: { seq: 3, index: 9, deviceId: B } }); }, /written by/);
	bad((t) => { t.plugins.set("x", { value: true, version: { seq: 4, index: 9, deviceId: A } }); }, /out of/);
	bad((t) => { t.plugins.set("x", { value: true, version: { seq: 1, index: 512, deviceId: A } }); }, /index/);
	bad((t) => { t.files.set("a//b", { value: null, version: { seq: 1, index: 0, deviceId: A } }); }, /invalid key/);
	bad((t) => { t.recentFrames.set(B, []); }, /size 0/);

	// Checkpoint content header.
	const content = { encoding: CheckpointEncoding.cfgFoldV1, coversSeq: 3, foldRulesVersion: CFG_FOLD_RULES_VERSION, state: bytes };
	assert.ok(verifyCfgCheckpoint(content, 3).ok);
	assert.equal((verifyCfgCheckpoint({ ...content, encoding: CheckpointEncoding.nsFoldV1 }, 3) as { reason: string }).reason, "malformed");
	assert.equal((verifyCfgCheckpoint({ ...content, foldRulesVersion: 2 }, 3) as { reason: string }).reason, "rules-version");
	assert.equal((verifyCfgCheckpoint(content, 5) as { reason: string }).reason, "covers-seq");
});

test("overlay: pending frames on a copy", () => {
	const s = newCfgFoldState();
	fold(s, 5, B, [{ t: "pluginSet", pluginId: "p", enabled: true }]);
	const before = encodeCfgFoldV1(s);
	const o = overlayPendingCfg(s, A, [
		{ clientFrameId: F(), ops: [{ t: "pluginSet", pluginId: "p", enabled: false }] },
		{ clientFrameId: F(), ops: [{ t: "jsonSet", file: "app.json", key: "k", valueJson: "1" }] },
	]);
	assert.ok(bytesEqual(before, encodeCfgFoldV1(s)));
	assert.equal(o.state.plugins.get("p")!.value, false);
	assert.deepEqual(o.state.plugins.get("p")!.version, { seq: 6, index: 0, deviceId: A });
	assert.equal(o.state.json.get(jsonRegisterKey("app.json", "k"))!.version.seq, 7);
	assert.equal(o.events.length, 2);
});

test("projection: JSON files", () => {
	const local = utf8Encode('{\n  "z": 1,\n  "vimMode": false,\n  "deviceLocal": "x",\n  "gone": [1]\n}');
	assert.deepEqual([...readJsonTopLevel(local)!], [["z", "1"], ["vimMode", "false"], ["deviceLocal", '"x"'], ["gone", "[1]"]]);
	assert.equal(readJsonTopLevel(utf8Encode("[1]")), null);
	assert.equal(readJsonTopLevel(utf8Encode("{bad")), null);
	assert.equal(readJsonTopLevel(new Uint8Array([0xff])), null);
	assert.deepEqual([...readJsonTopLevel(utf8Encode('﻿{"a":1}'))!], [["a", "1"]]);

	const r = applyJsonKeys(local, new Map<string, string | null>([
		["vimMode", "true"], ["gone", null], ["b", '{"y":[1,2],"x":"s"}'], ["a", "2"], ["deviceLocal", '"remote"'],
	]), new Set(["deviceLocal"]))!;
	assert.ok(r.changed);
	assert.equal(dec(r.bytes), '{\n  "z": 1,\n  "vimMode": true,\n  "deviceLocal": "x",\n  "a": 2,\n  "b": {\n    "x": "s",\n    "y": [\n      1,\n      2\n    ]\n  }\n}');
	// Output is exactly JSON.stringify(_, null, 2) of the same object.
	assert.equal(dec(r.bytes), JSON.stringify({ z: 1, vimMode: true, deviceLocal: "x", a: 2, b: { x: "s", y: [1, 2] } }, null, 2));
	// No-op updates return the local bytes untouched (formatting preserved).
	const odd = utf8Encode('{"a":1,  "b":2}');
	const n = applyJsonKeys(odd, new Map([["a", "1"], ["c", null]]))!;
	assert.ok(!n.changed);
	assert.equal(n.bytes, odd);
	// Absent file: created.
	const c = applyJsonKeys(null, new Map([["k", '"v"']]))!;
	assert.ok(c.changed);
	assert.equal(dec(c.bytes), '{\n  "k": "v"\n}');
	assert.equal(dec(applyJsonKeys(null, new Map())!.bytes), "{}");
	// Unparsable local: refuse.
	assert.equal(applyJsonKeys(utf8Encode("{oops"), new Map([["k", "1"]])), null);
	// __proto__ key is handled as data.
	const p = applyJsonKeys(utf8Encode("{}"), new Map([["__proto__", '{"polluted":true}']]))!;
	assert.equal(dec(p.bytes), '{\n  "__proto__": {\n    "polluted": true\n  }\n}');
	assert.equal(({} as Record<string, unknown>).polluted, undefined);

	// diffJsonFile.
	const base = new Map([["a", "1"], ["b", "2"], ["deny", "0"]]);
	const now = new Map([["a", "1"], ["b", "3"], ["c", "[]"], ["deny", "9"]]);
	assert.deepEqual(diffJsonFile("app.json", base, now, new Set(["deny"])), [
		{ t: "jsonSet", file: "app.json", key: "b", valueJson: "3" },
		{ t: "jsonSet", file: "app.json", key: "c", valueJson: "[]" },
	]);
	assert.deepEqual(diffJsonFile("app.json", base, new Map([["a", "1"]])), [
		{ t: "jsonDel", file: "app.json", key: "b" },
		{ t: "jsonDel", file: "app.json", key: "deny" },
	]);
	assert.equal(diffJsonFile("app.json", null, now).length, 4);

	// projectJsonFile over the fold.
	const s = newCfgFoldState();
	fold(s, 1, A, diffJsonFile("app.json", null, now));
	fold(s, 2, A, [{ t: "jsonDel", file: "app.json", key: "a" }, { t: "jsonSet", file: "app.jsonx", key: "q", valueJson: "1" }]);
	assert.deepEqual([...jsonRegistersOf(s, "app.json").keys()], ["a", "b", "c", "deny"]);
	assert.deepEqual(jsonFilesOf(s), ["app.json", "app.jsonx"]);
	const pj = projectJsonFile(s, "app.json", utf8Encode('{"a":1,"local":true}'), new Set(["deny"]))!;
	assert.equal(dec(pj.bytes), JSON.stringify({ local: true, b: 3, c: [] }, null, 2));
});

test("projection: community plugins, plugin data gate, paths", () => {
	const s = newCfgFoldState();
	fold(s, 1, A, [
		{ t: "pluginSet", pluginId: "zeta", enabled: true },
		{ t: "pluginSet", pluginId: "alpha", enabled: true },
		{ t: "pluginSet", pluginId: "off", enabled: false },
		{ t: "pluginSet", pluginId: "yaos", enabled: true },
		{ t: "pluginDel", pluginId: "gone" },
		{ t: "filePut", file: "plugins/dv/data.json", content: { t: "inline", bytes: utf8Encode("{}") }, pluginVersion: "1.2.0" },
		{ t: "filePut", file: "plugins/nv/data.json", content: { t: "inline", bytes: utf8Encode("{}") }, pluginVersion: null },
	]);
	assert.deepEqual(enabledPlugins(s), ["alpha", "zeta"]);
	assert.equal(dec(projectCommunityPlugins(s)), '[\n  "alpha",\n  "zeta"\n]');
	assert.deepEqual(readCommunityPlugins(utf8Encode('["b","a","b"]')), ["b", "a"]);
	assert.equal(readCommunityPlugins(utf8Encode('["b",1]')), null);
	assert.equal(readCommunityPlugins(utf8Encode("{}")), null);
	assert.deepEqual(diffCommunityPlugins(["a", "b", "yaos"], ["b", "c", "yaos"]), [
		{ t: "pluginSet", pluginId: "a", enabled: false },
		{ t: "pluginSet", pluginId: "c", enabled: true },
	]);
	assert.deepEqual(diffCommunityPlugins(null, ["b", "a"]).map((o) => (o as { pluginId: string }).pluginId), ["a", "b"]);

	const dv = s.files.get("plugins/dv/data.json");
	assert.ok(canApplyPluginData("1.2.0", dv));
	assert.ok(!canApplyPluginData("1.2.1", dv));
	assert.ok(!canApplyPluginData("", dv));
	assert.ok(!canApplyPluginData(null, dv));
	assert.ok(!canApplyPluginData("1.2.0", undefined));
	assert.ok(!canApplyPluginData("1.2.0", s.files.get("plugins/nv/data.json")));
	fold(s, 2, B, [{ t: "fileDel", file: "plugins/dv/data.json" }]);
	assert.ok(!canApplyPluginData("1.2.0", s.files.get("plugins/dv/data.json")));

	assert.ok(isYaosOwnPath("plugins/yaos/data.json"));
	assert.ok(isYaosOwnPath("plugins/yaos"));
	assert.ok(!isYaosOwnPath("plugins/yaos2/data.json"));
	assert.equal(pluginIdOfDataJson("plugins/dv/data.json"), "dv");
	assert.equal(pluginIdOfDataJson("plugins/dv/main.js"), null);
	assert.equal(pluginIdOfDataJson("plugins/a/b/data.json"), null);
});

// Small deterministic cfg fuzz: random frames (incl. codec round-trip of ops,
// duplicates, malformed), V1+V2 after every frame, replay from every 25th cut.
test("cfg fold fuzz: V1/V2 per frame, cut-point replay, determinism", () => {
	const seeds = Number(process.env.YAOS_CFG_FUZZ_SEEDS ?? 20);
	for (let seed = 1; seed <= seeds; seed++) {
		let x = seed * 0x9e3779b1;
		const rnd = () => {
			x = (x + 0x6d2b79f5) | 0;
			let t = Math.imul(x ^ (x >>> 15), 1 | x);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
		const files = ["app.json", "appearance.json", "hotkeys.json", "core-plugins.json"];
		const keys = ["a", "b", "vimMode", "__proto__", "", "k\u0000x", "é"];
		const vals = ["1", "true", "null", '"s"', '{"a":[1,{"b":2}]}', "[]", "{ }"];
		const devices = ["d1", "d2", "d3"] as DeviceId[];
		const genOp = (): CfgOp => {
			const r = rnd();
			if (r < 0.35) return { t: "jsonSet", file: pick(files), key: pick(keys), valueJson: pick(vals) };
			if (r < 0.45) return { t: "jsonDel", file: pick(files), key: pick(keys) };
			if (r < 0.6) return { t: "filePut", file: pick(["snippets/a.css", "plugins/p/data.json", "themes/t/theme.css"]), content: rnd() < 0.5 ? { t: "inline", bytes: utf8Encode(pick(vals)) } : { t: "blob", hash: H(Math.floor(rnd() * 4)), size: 70000 }, pluginVersion: rnd() < 0.5 ? null : pick(["1.0", "2.0"]) };
			if (r < 0.7) return { t: "fileDel", file: pick(["snippets/a.css", "plugins/p/data.json"]) };
			if (r < 0.9) return { t: "pluginSet", pluginId: pick(["p", "q", "r"]), enabled: rnd() < 0.5 };
			return { t: "pluginDel", pluginId: pick(["p", "q", "r"]) };
		};
		type Fr = { seq: number; deviceId: DeviceId; clientFrameId: ClientFrameId; ops: CfgOp[] };
		const frames: Fr[] = [];
		const sent: Fr[] = [];
		let seq = 0;
		for (let i = 0; i < 300; i++) {
			seq += 1 + (rnd() < 0.1 ? Math.floor(rnd() * 5) : 0);
			if (sent.length > 0 && rnd() < 0.08) {
				const old = pick(sent);
				frames.push({ ...old, seq });
				continue;
			}
			const n = rnd() < 0.05 ? 0 : 1 + Math.floor(rnd() * 6);
			const ops = Array.from({ length: n }, genOp);
			const decoded = n === 0 ? [] : decodeCfgOps(encodeCfgOps(ops));
			assert.ok(decoded !== null);
			const fr: Fr = { seq, deviceId: pick(devices), clientFrameId: F(), ops: decoded };
			sent.push(fr);
			frames.push(fr);
		}
		const run = (from: CfgFoldState, list: readonly Fr[]) => {
			for (const fr of list) {
				foldCfgFrame(from, fr);
				const e = checkCfgInvariants(from);
				assert.equal(e, null, `seed ${seed} seq ${fr.seq}: ${e}`);
			}
			return from;
		};
		const full = run(newCfgFoldState(), frames);
		const finalBytes = encodeCfgFoldV1(full);
		assert.ok(verifyCfgFoldBytes(finalBytes, full.coversSeq).ok, `seed ${seed}`);
		assert.ok(bytesEqual(encodeCfgFoldV1(run(newCfgFoldState(), frames)), finalBytes), `seed ${seed}: non-deterministic`);
		for (let cut = 25; cut < frames.length; cut += 25) {
			const mid = run(newCfgFoldState(), frames.slice(0, cut));
			const resumed = decodeCfgFoldV1(encodeCfgFoldV1(mid))!;
			run(resumed, frames.slice(cut));
			assert.ok(bytesEqual(encodeCfgFoldV1(resumed), finalBytes), `seed ${seed}: cut ${cut} diverges`);
		}
	}
});
