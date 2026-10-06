import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, VaultPath } from "../../core/types";
import type { StatusSnapshot } from "../../protocol/status";
import { simHashPort } from "../../sim/hash";
import { SeededRandom } from "../../sim/random";
import { buildDiagnosticsBundle, DIAGNOSTICS_QUARANTINE_MAX, PSEUDONYM_HEX_CHARS, type DiagnosticsInput } from "./diagnosticsBundle";

const SECRET_PATH = "Clients/Acme merger/plan.md" as VaultPath;
const OTHER_PATH = "Journal/2026-10-05.md" as VaultPath;
const DOC = "AAAAAAAAAAAAAAAAAAAAAA" as DocId;
const UNKNOWN_DOC = "BBBBBBBBBBBBBBBBBBBBBB";

function input(): DiagnosticsInput {
	const status = {
		phase: "braked", counts: { frozenDocs: 1 }, notices: [],
		brake: { id: "k", reason: "mass-delete-local", heldCount: 2, syncedCount: 9, samplePaths: [SECRET_PATH, OTHER_PATH] },
	} as unknown as StatusSnapshot;
	return {
		generatedAtMs: 5, clientVersion: "2.0.0", status,
		events: [
			{ atMs: 1, code: "phase", fields: { from: "live", to: "braked" } },
			{ atMs: 2, code: "quarantine-retried", fields: { stream: `b:${DOC}`, rows: 1 } },
			{ atMs: 3, code: "x", fields: { stream: "ns", path: OTHER_PATH } },
		],
		quarantine: [
			{ stream: `b:${DOC}`, seq: 4, reason: "decode", bytes: 10 },
			{ stream: `c:${UNKNOWN_DOC}`, seq: 6, reason: "decode", bytes: 1 },
			{ stream: "cfg", seq: 7, reason: "decode", bytes: 1 },
		],
		frozen: [{ stream: `b:${DOC}`, reason: "too-big" }],
		stores: { synced: { records: 2, bytes: 0 } },
		pathOf: (id) => (id === DOC ? SECRET_PATH : null),
	};
}

const ports = (seed: number) => ({ random: new SeededRandom(seed), hash: simHashPort() });

test("diagnostics bundle: no stream id or path in the body; one file has one pseudonym across sections", async () => {
	const b = await buildDiagnosticsBundle(input(), ports(1), false);
	const text = JSON.stringify(b);
	for (const leak of [SECRET_PATH, OTHER_PATH, "Acme", DOC, UNKNOWN_DOC]) assert.ok(!text.includes(leak), `leaked ${leak}`);
	assert.equal(b.paths, null);
	const p = b.frozenDocs[0]!.stream;
	assert.match(p, new RegExp(`^b:[0-9a-f]{${PSEUDONYM_HEX_CHARS}}$`));
	const id = p.slice(2);
	assert.equal(b.quarantine[0]!.stream, `b:${id}`);
	assert.equal(b.recentEvents[1]!.fields.stream, `b:${id}`);
	assert.equal(b.status.brake?.samplePaths[0], id, "brake sample path and the doc's streams share the path's pseudonym");
	assert.match(b.quarantine[1]!.stream, /^c:[0-9a-f]{12}$/);
	assert.equal(b.quarantine[2]!.stream, "cfg");
	assert.equal(b.recentEvents[2]!.fields.stream, "ns");
	assert.equal(b.recentEvents[2]!.fields.path, b.status.brake?.samplePaths[1]);
	assert.deepEqual(b.recentEvents[0], input().events[0]);
});

test("diagnostics bundle: a fresh salt per bundle, so pseudonyms do not match across bundles", async () => {
	const random = new SeededRandom(7);
	const a = await buildDiagnosticsBundle(input(), { random, hash: simHashPort() }, false);
	const b = await buildDiagnosticsBundle(input(), { random, hash: simHashPort() }, false);
	assert.notEqual(a.frozenDocs[0]!.stream, b.frozenDocs[0]!.stream);
	assert.notEqual(a.status.brake?.samplePaths[1], b.status.brake?.samplePaths[1]);
});

test("diagnostics bundle: paths only with opt-in, mapping every known pseudonym; quarantine capped", async () => {
	const b = await buildDiagnosticsBundle(input(), ports(3), true);
	const id = b.frozenDocs[0]!.stream.slice(2);
	assert.deepEqual(b.paths, [
		{ pseudonym: b.status.brake?.samplePaths[1], path: OTHER_PATH },
		{ pseudonym: id, path: SECRET_PATH },
	].sort((x, y) => (x.path < y.path ? -1 : 1)));
	assert.ok(!JSON.stringify({ ...b, paths: null }).includes("Acme"), "real paths appear only in `paths`");
	const many = { ...input(), quarantine: Array.from({ length: DIAGNOSTICS_QUARANTINE_MAX + 5 }, (_, i) => ({ stream: "ns", seq: i, reason: "r", bytes: 1 })) };
	assert.equal((await buildDiagnosticsBundle(many, ports(4), false)).quarantine.length, DIAGNOSTICS_QUARANTINE_MAX);
});
