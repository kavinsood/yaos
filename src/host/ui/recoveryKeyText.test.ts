import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { decodeRecoveryKey, encodeRecoveryKey, makeRecoveryKey } from "../../core/codec/recoveryKey";
import {
	formatRecoveryKey,
	groupMatches,
	newRecoveryKey,
	parseRecoveryKey,
	pickConfirmGroups,
	readRecoveryKey,
	recoveryKeyGroups,
	RK_GROUPS,
	RK_TEXT_PREFIX,
} from "./recoveryKeyText";

/** The engine's checksum (hashService fingerprint, first 3 bytes), computed here with node:crypto. */
const checksum = async (secret: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(createHash("sha256").update(secret).digest().subarray(0, 3));

test("recoveryKeyText: format and parse agree with core/codec/recoveryKey on random keys", () => {
	for (let i = 0; i < 200; i++) {
		const rk = makeRecoveryKey(new Uint8Array(randomBytes(32)));
		const text = formatRecoveryKey(rk);
		assert.equal(text, encodeRecoveryKey(rk));
		assert.deepEqual(parseRecoveryKey(text), rk);
		assert.deepEqual(decodeRecoveryKey(text), parseRecoveryKey(text));
		const typed = text.toLowerCase().replace(/-/g, " ").replace(/^yaos rk1 /, "");
		assert.deepEqual(parseRecoveryKey(typed), rk);
	}
});

test("recoveryKeyText: malformed text is rejected the same way core rejects it", () => {
	const rk = makeRecoveryKey(new Uint8Array(32).fill(7));
	const text = formatRecoveryKey(rk);
	for (const bad of [
		"",
		text.slice(0, -1),
		`${text}0`,
		text.replace(/.$/, "U"),
		text.replace(/.$/, "ß"),
		`XAOS-RK1-${text.slice(RK_TEXT_PREFIX.length)}`,
	]) {
		assert.equal(parseRecoveryKey(bad), null, "malformed");
		assert.equal(decodeRecoveryKey(bad), null);
	}
	// I/L read as 1 and O as 0 (Crockford).
	const swapped = RK_TEXT_PREFIX + text.slice(RK_TEXT_PREFIX.length).replace(/1/g, "l").replace(/0/g, "O");
	assert.deepEqual(parseRecoveryKey(swapped), rk);
});

test("recoveryKeyText: readRecoveryKey checks the engine's checksum and zero-fills on a mismatch", async () => {
	const rk = makeRecoveryKey(new Uint8Array(randomBytes(32)));
	const text = formatRecoveryKey(rk);
	const ok = await readRecoveryKey(text, checksum);
	assert.ok(ok.ok);
	if (ok.ok) assert.deepEqual(ok.rk, rk);

	// One character changed: the checksum catches it before any crypto.
	const groups = recoveryKeyGroups(text);
	const g = groups[3]!;
	groups[3] = (g[0] === "A" ? "B" : "A") + g.slice(1);
	const typo = RK_TEXT_PREFIX + groups.join("-");
	let seen: Uint8Array | null = null;
	const res = await readRecoveryKey(typo, async (secret) => {
		seen = secret;
		return checksum(secret);
	});
	assert.deepEqual(res, { ok: false, reason: "checksum" });
	assert.ok(seen !== null && (seen as Uint8Array).every((b) => b === 0), "the decoded bytes are zero-filled");

	assert.deepEqual(await readRecoveryKey("not a key", checksum), { ok: false, reason: "malformed" });
	await assert.rejects(readRecoveryKey(text, async () => { throw new Error("YAOS is not running."); }), /not running/);
});

test("recoveryKeyText: newRecoveryKey matches core makeRecoveryKey and wipes the random secret", async () => {
	const fixed = new Uint8Array(32).map((_, i) => i * 3);
	let handed: Uint8Array | null = null;
	const out = await newRecoveryKey((n) => {
		handed = new Uint8Array(fixed.subarray(0, n));
		return handed;
	}, checksum);
	assert.deepEqual(out.rk, makeRecoveryKey(fixed));
	assert.equal(out.text, encodeRecoveryKey(out.rk));
	assert.ok((handed as unknown as Uint8Array).every((b) => b === 0));
});

test("recoveryKeyText: confirm groups are two distinct in-range indices, and retyping tolerates case and look-alikes", () => {
	let n = 0;
	const seq = [0xff, 0x0d, 3, 3, 9, 2];
	const rnd = (len: number): Uint8Array => new Uint8Array(len).map(() => seq[n++ % seq.length]!);
	const [a, b] = pickConfirmGroups(rnd);
	assert.deepEqual([a, b], [2, 9], "15 and the repeated pair are resampled");
	for (let i = 0; i < 500; i++) {
		const [x, y] = pickConfirmGroups((len) => new Uint8Array(randomBytes(len)));
		assert.ok(x < y && x >= 0 && y < RK_GROUPS);
	}
	assert.ok(groupMatches("ab1o", "AB10"));
	assert.ok(groupMatches(" AB-1 0", "AB10"));
	assert.ok(!groupMatches("AB1", "AB10"));
	assert.ok(!groupMatches("AB100", "AB10"));
	assert.ok(!groupMatches("AB11", "AB10"));
});
