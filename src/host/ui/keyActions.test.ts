import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyLinkE2ee, installRecoveryKey, pairingLink, pairingLinkE2ee, PendingQrKeys, rekeyBlocked, rekeyLinkNow, revokeRekey,
	RK_CHECKSUM_MESSAGE, RK_MALFORMED_MESSAGE, routeSetupLink, type RetryOptions,
} from "./keyActions";
import { buildRekeyLink, buildSetupLink, decodeKeyParam, parseSetupLink, type LinkE2ee } from "./pairing";
import { formatRecoveryKey, RK_BYTES } from "./recoveryKeyText";
import { FakeUiHost, identityFor, snapshot } from "./testkit/fakeUiHost";
import { testVaultId } from "../keys/testkit/vaultIds";

const VAULT = testVaultId("mine");
const OTHER = testVaultId("theirs");
const HOST = "https://sync.example.com";
const CODE = `${VAULT}.codeSecretPart0123456789`;
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

const linkKey = () => ({ e: 2, k: KEY_BYTES.slice() });
const params = (link: string): Record<string, string> => Object.fromEntries(new URL(link).searchParams);

/** Clock and sleep the test controls: every sleep advances the clock. */
function fakeClock(): RetryOptions & { slept: number[] } {
	let t = 0;
	const slept: number[] = [];
	return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, setTimer: () => 0, clearTimer: () => {} };
}

/** Timers that fire at once (a wait that is not satisfied right away times out). */
const instantTimeout: RetryOptions = { setTimer: (_ms, fn) => { queueMicrotask(fn); return 0; }, clearTimer: () => {} };

test("routeSetupLink: a setup link naming this device's vault takes only its key or suite=0, never re-enrolls", () => {
	const data = new FakeUiHost({ identity: identityFor(VAULT, HOST) }).data();
	const withKey = parseSetupLink(params(buildSetupLink(HOST, CODE, { suite: 1, key: linkKey() })));
	const r1 = routeSetupLink(withKey, data, snapshot("key-missing"));
	assert.equal(r1.kind, "apply");
	assert.ok(r1.kind === "apply" && r1.e2ee.suite === 1 && r1.e2ee.key.e === 2);

	const suite0 = routeSetupLink(parseSetupLink(params(buildSetupLink(HOST, CODE, { suite: 0 }))), data, null);
	assert.deepEqual(suite0, { kind: "apply", e2ee: { suite: 0 } });

	const keyless = routeSetupLink(parseSetupLink(params(buildSetupLink(HOST, CODE))), data, null);
	assert.equal(keyless.kind, "ignore");
});

test("routeSetupLink: another vault, another server, an unpaired or a revoked device go to the pair modal", () => {
	const paired = new FakeUiHost({ identity: identityFor(VAULT, HOST) }).data();
	const unpaired = new FakeUiHost().data();
	const otherCode = `${OTHER}.codeSecretPart0123456789`;
	const cases: [string, ReturnType<typeof parseSetupLink>, typeof paired, ReturnType<typeof snapshot> | null][] = [
		["other vault", parseSetupLink(params(buildSetupLink(HOST, otherCode, { suite: 0 }))), paired, null],
		["other server", parseSetupLink(params(buildSetupLink("https://other.example.com", CODE))), paired, null],
		["unpaired", parseSetupLink(params(buildSetupLink(HOST, CODE, { suite: 1, key: linkKey() }))), unpaired, null],
		["revoked", parseSetupLink(params(buildSetupLink(HOST, CODE))), paired, snapshot("revoked")],
		["code without a vault id", parseSetupLink({ action: "setup", host: HOST, pairingCode: "pc_ABCDEFGHIJKLMNOP" }), paired, null],
	];
	for (const [name, parsed, data, status] of cases) {
		const r = routeSetupLink(parsed, data, status);
		assert.equal(r.kind, "pair", name);
	}
});

test("routeSetupLink: a re-key link needs a paired device; a dropped link zero-fills its key; bad links are ignored", () => {
	const parsed = parseSetupLink(params(buildRekeyLink(linkKey())));
	assert.ok(parsed.ok && parsed.kind === "rekey");
	const key = parsed.ok && parsed.kind === "rekey" ? parsed.key : null;
	assert.equal(routeSetupLink(parsed, new FakeUiHost().data(), null).kind, "ignore");
	assert.ok(key!.k.every((b) => b === 0));

	const again = parseSetupLink(params(buildRekeyLink(linkKey())));
	assert.equal(routeSetupLink(again, new FakeUiHost({ identity: identityFor(VAULT) }).data(), null).kind, "apply");
	assert.equal(routeSetupLink(parseSetupLink({ action: "setup", host: HOST, pairingCode: CODE, suite: "1" }), new FakeUiHost().data(), null).kind, "ignore");
});

test("routeSetupLink never routes to creation: every outcome is ignore, apply or pair", () => {
	const datas = [new FakeUiHost().data(), new FakeUiHost({ identity: identityFor(VAULT, HOST) }).data(), new FakeUiHost({ identity: identityFor(VAULT, HOST), creating: { vaultId: VAULT } }).data()];
	const links = [
		buildSetupLink(HOST, CODE), buildSetupLink(HOST, CODE, { suite: 0 }), buildSetupLink(HOST, CODE, { suite: 1, key: linkKey() }),
		buildRekeyLink(linkKey()), `obsidian://yaos?action=setup&host=${HOST}&pairingCode=${CODE}&vault=Notes`,
	];
	for (const data of datas) {
		for (const link of links) {
			for (const status of [null, snapshot("key-missing", { creatable: true })]) {
				const r = routeSetupLink(parseSetupLink(params(link)), data, status);
				assert.ok(r.kind === "ignore" || r.kind === "apply" || r.kind === "pair");
			}
		}
	}
});

test("applyLinkE2ee: a key goes to the engine as installKey qr and is zero-filled; verified once main pins suite 1", async () => {
	const host = new FakeUiHost({ identity: identityFor(VAULT) });
	host.handler = (_c, h) => {
		queueMicrotask(() => { h.pin(1); h.setStatus(snapshot("live", { suite: 1, sealEpoch: 2, keyMissing: null })); });
		return { t: "ok" };
	};
	const e2ee: LinkE2ee = { suite: 1, key: linkKey() };
	assert.equal(await applyLinkE2ee(host, VAULT, e2ee, fakeClock()), "verified");
	const c = host.commands[0]!;
	assert.ok(c.t === "installKey" && c.source === "qr" && c.e === 2);
	assert.deepEqual(c.t === "installKey" && c.source === "qr" ? [...c.k] : [], [...KEY_BYTES]);
	assert.ok(e2ee.suite === 1 && e2ee.key.k.every((b) => b === 0));
});

test("applyLinkE2ee: no matching record yet is pending; suite=0 retries while k is still being read", async () => {
	const pending = new FakeUiHost({ identity: identityFor(VAULT) });
	pending.setStatus(snapshot("key-missing", { keyMissing: "no-pin" }));
	assert.equal(await applyLinkE2ee(pending, VAULT, { suite: 1, key: linkKey() }, instantTimeout), "pending");

	const host = new FakeUiHost({ identity: identityFor(VAULT) });
	let n = 0;
	host.handler = () => {
		n++;
		if (n === 1) throw new Error("YAOS is not running.");
		if (n === 2) throw new Error("refused: k is not read to head yet");
		return { t: "ok" };
	};
	const clock = fakeClock();
	assert.equal(await applyLinkE2ee(host, VAULT, { suite: 0 }, clock), "suite0");
	assert.deepEqual(host.commands.map((c) => c.t === "pinSuite0" ? c.source : c.t), ["link", "link", "link"]);
	assert.deepEqual(clock.slept, [1000, 1000]);
});

test("applyLinkE2ee: a definitive refusal is shown plainly and not retried; a moved identity is refused", async () => {
	const host = new FakeUiHost({ identity: identityFor(VAULT) });
	host.handler = () => { throw new Error("refused: this device has read an encryption key record for the vault"); };
	await assert.rejects(applyLinkE2ee(host, VAULT, { suite: 0 }, fakeClock()), /a link without a key cannot set it up/);
	assert.equal(host.commands.length, 1);

	const key = linkKey();
	await assert.rejects(applyLinkE2ee(host, OTHER, { suite: 1, key }, fakeClock()), /no longer paired/);
	assert.ok(key.k.every((b) => b === 0));
	assert.equal(host.commands.length, 1);
});

test("installRecoveryKey checks the format and the checksum before any command, then sends installKey rk", async () => {
	const host = new FakeUiHost({ identity: identityFor(VAULT) });
	await assert.rejects(installRecoveryKey(host, "YAOS-RK1-ABCD", instantTimeout), (e: Error) => e.message === RK_MALFORMED_MESSAGE);
	const rk = new Uint8Array(RK_BYTES).fill(3);
	rk.set(await host.rkChecksum(rk.subarray(0, 32)), 32);
	const good = formatRecoveryKey(rk);
	const typo = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
	await assert.rejects(installRecoveryKey(host, typo, instantTimeout), (e: Error) => e.message === RK_CHECKSUM_MESSAGE);
	assert.equal(host.commands.length, 0);

	host.handler = (_c, h) => { queueMicrotask(() => { h.pin(1); h.setStatus(snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null })); }); return { t: "ok" }; };
	assert.equal(await installRecoveryKey(host, good.toLowerCase(), fakeClock()), "verified");
	const c = host.commands[0]!;
	assert.ok(c.t === "installKey" && c.source === "rk");
	assert.deepEqual(c.t === "installKey" && c.source === "rk" ? [...c.rk] : [], [...rk]);

	const wrong = new FakeUiHost({ identity: identityFor(VAULT) });
	wrong.setStatus(snapshot("key-missing", { keyMissing: "encrypted-vault" }));
	assert.equal(await installRecoveryKey(wrong, good, instantTimeout), "pending");
	for (const m of [RK_MALFORMED_MESSAGE, RK_CHECKSUM_MESSAGE]) assert.ok(!m.includes(good));
});

test("pairing and re-key links come from the stored key only, and only when the device holds it", () => {
	const host = new FakeUiHost({ identity: identityFor(VAULT), e2ee: { suite: 1 } });
	assert.equal(pairingLinkE2ee(host), null, "no usable key: nothing to hand on");
	assert.equal(rekeyLinkNow(host), null);
	host.qrKey = linkKey();
	const e2ee = pairingLinkE2ee(host);
	assert.ok(e2ee?.suite === 1);
	const link = pairingLink(HOST, CODE, e2ee);
	assert.ok(e2ee.key.k.every((b) => b === 0), "the copy is zero-filled once the link is built");
	const p = new URL(link).searchParams;
	assert.deepEqual(decodeKeyParam(p.get("key")!)?.k, KEY_BYTES);
	assert.equal(p.get("pairingCode"), CODE);
	const rekey = rekeyLinkNow(host)!;
	assert.match(rekey, /^obsidian:\/\/yaos\?action=rekey&key=/);
	assert.deepEqual([...host.qrKey.k], [...KEY_BYTES], "the stored key is untouched");

	assert.deepEqual(pairingLinkE2ee(new FakeUiHost({ e2ee: { suite: 0 } })), { suite: 0 });
	assert.equal(pairingLinkE2ee(new FakeUiHost()), null);
	const suite0 = new FakeUiHost({ e2ee: { suite: 0 } });
	suite0.qrKey = linkKey();
	assert.equal(rekeyLinkNow(suite0), null);
});

test("revokeRekey: only with the current key; resolves with the new epoch and zero-fills the RK", async () => {
	const blocked = new FakeUiHost({ identity: identityFor(VAULT), e2ee: { suite: 1 } });
	blocked.setStatus(snapshot("key-missing", { suite: 1, keyMissing: "revoked-epoch", sealEpoch: 0 }));
	assert.match(rekeyBlocked(blocked)!, /current key/);
	const rk0 = new Uint8Array(35).fill(1);
	await assert.rejects(revokeRekey(blocked, rk0, instantTimeout), /current key/);
	assert.ok(rk0.every((b) => b === 0));
	assert.equal(blocked.commands.length, 0);
	assert.match(rekeyBlocked(new FakeUiHost({ e2ee: { suite: 0 } }))!, /not end-to-end encrypted/);

	const host = new FakeUiHost({ identity: identityFor(VAULT), e2ee: { suite: 1 } });
	host.setStatus(snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null }));
	host.handler = (_c, h) => { queueMicrotask(() => h.setStatus(snapshot("live", { suite: 1, sealEpoch: 2, keyMissing: null }))); return { t: "ok" }; };
	const rk = new Uint8Array(35).fill(7);
	assert.equal(await revokeRekey(host, rk, { setTimer: () => 0, clearTimer: () => {} }), 2);
	assert.ok(rk.every((b) => b === 0));
	const c = host.commands[0]!;
	assert.deepEqual(c.t === "revokeRekey" ? [...c.rk] : [], new Array(35).fill(7));

	const raced = new FakeUiHost({ identity: identityFor(VAULT), e2ee: { suite: 1 } });
	raced.setStatus(snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null }));
	raced.handler = () => { throw new Error("refused: another key record won the epoch; revoke again"); };
	await assert.rejects(revokeRekey(raced, new Uint8Array(35), instantTimeout), /Re-key after revoking a device/);
});

test("PendingQrKeys shows only for the enrolled vault while it is blocked", () => {
	const host = new FakeUiHost({ identity: identityFor(VAULT) });
	const pending = new PendingQrKeys();
	pending.mark(VAULT);
	assert.equal(pending.shows(host), true);
	host.current = { ...host.current, identity: identityFor(OTHER) };
	assert.equal(pending.shows(host), false);
	host.current = { ...host.current, identity: identityFor(VAULT), e2ee: { suite: 1 } };
	host.snap = snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null });
	assert.equal(pending.shows(host), false);
	host.snap = snapshot("key-missing", { suite: 1, keyMissing: "no-key" });
	assert.equal(pending.shows(host), false, "cleared once the key was usable");
});
