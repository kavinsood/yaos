/**
 * The KeyReader (keyReader.ts) through SimDevice: main's side (SecretStorage, the data.json pin) is the device's
 * keysFor, and a restart after a pin is the test's. Keys and recovery keys are the testkit's fixed byte ranges or
 * come from the device's SecretStorage; none is printed.
 *
 * Suite 1 end to end (§12.4, §15.1, §14.2): the creator's genesis, a join by RK and by QR, sealed text and an
 * attachment with no plaintext on the relay or in the blob store, a suite-1 device without its key starting its
 * VaultRuntime in-process once it installs one, and a revoke with a re-key that a kept device follows by QR.
 * Blob addresses use kAddr from K_1 (e2ee-design §6.2), so the blob GC needs K_1 verified (blobGc.ts
 * preconditions): a device that joins after a roll or a revoke gets it down the prevWrap chain (evaluate.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM } from "../../core/types";
import type { EngineResultValue } from "../../protocol/messages";
import type { BlobAddress } from "../../ports/crypto";
import type { EngineTuning } from "../runtime/options";
import { SimBlobStore } from "../../sim/blobStore";
import { VirtualClock } from "../../sim/clock";
import { SIM_SETTINGS, SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import type { E2eeStatus, StatusSnapshot } from "../../protocol/status";
import { VaultKeyStore } from "../../host/keys/secretStore";
import { advanceUntil, settleWith } from "../keyring/testkit/simWait";
import { K, RK_A, RK_B, genesisFor } from "../keyring/testkit/world";
import { contains } from "../keyring/testkit/engines";
import { connectPeer, frame } from "../../sim/a-relay-testkit";

const enc = new TextEncoder();
const SECRET_TEXT = "the plaintext body of a sealed note";
const SECRET_BYTES = new Uint8Array([137, 80, 78, 71, ...enc.encode("attachment plaintext marker")]);

const ATTACHMENTS = () => ({ ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 1 << 20 });

function last(d: SimDevice): StatusSnapshot | null {
	return d.ui.statuses.at(-1) ?? null;
}

function e2ee(d: SimDevice): E2eeStatus | undefined {
	return last(d)?.e2ee;
}

const isLive = (d: SimDevice) => last(d)?.phase === "live";
const missing = (d: SimDevice, reason: string) => last(d)?.phase === "key-missing" && e2ee(d)?.keyMissing === reason;

function refusedError(e: unknown): boolean {
	return (e as { error?: { code?: string } }).error?.code === "refused" || /refused/.test(String(e));
}

/** Main restarts the engine after setting a pin (pluginController.ts requestRestart). */
async function restart(clock: VirtualClock, d: SimDevice): Promise<void> {
	await settleWith(clock, d.runtime.stop());
	await settleWith(clock, d.restartApp());
}

async function wait(clock: VirtualClock, what: string, done: () => boolean, horizonMs = 60_000): Promise<void> {
	assert.ok(await advanceUntil(clock, done, horizonMs), what);
}

function storedKey(clock: VirtualClock, d: SimDevice, e: number): Uint8Array {
	const k = new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).load()?.keys.find((x) => x.e === e)?.k;
	if (!k) throw new Error(`no stored key for epoch ${e}`);
	return k;
}

function storedEpochs(clock: VirtualClock, d: SimDevice): number[] {
	return (new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).load()?.keys ?? []).map((x) => x.e).sort((a, b) => a - b);
}

/** Another device's genesis for the sim vault (K_1 = K(1) under RK_A). */
async function appendGenesis(clock: VirtualClock, net: SimNet): Promise<void> {
	const peer = await connectPeer(net.relay, clock, "dev-G");
	peer.session.append(frame(KEYRING_STREAM, "g-genesis", await genesisFor(SIM_VAULT_ID)));
	await clock.advance(1_000);
}

/** No relay row and no stored blob holds `needle`. */
function noPlaintext(net: SimNet, blobs: SimBlobStore | null, needle: Uint8Array, what: string): void {
	for (const s of net.relay.streams()) for (const r of net.relay.rows(s, { includeGc: true })) assert.ok(!contains(r.payload, needle), `${what}: not in ${s}`);
	for (const o of blobs?.objects.values() ?? []) assert.ok(!contains(o.bytes, needle), `${what}: not in the blob store`);
}

type Cleaned = Extract<EngineResultValue, { t: "attachmentsCleaned" }>;

async function cleanUp(clock: VirtualClock, d: SimDevice): Promise<Cleaned> {
	const r = await settleWith(clock, d.runtime.command({ t: "cleanUpAttachments" }));
	assert.equal(r.t, "attachmentsCleaned");
	return r as Cleaned;
}

test("pinSuite0 {link} is refused once k shows a record, and enableE2ee / pinSuite0 {create} off the creation path", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const u = new SimDevice({ name: "U", clock, net, pin: null });
	void u.start();
	await wait(clock, "no-pin", () => missing(u, "no-pin"));
	await appendGenesis(clock, net);
	await wait(clock, "encrypted-vault", () => missing(u, "encrypted-vault") && e2ee(u)?.keyringSeen === true);
	await assert.rejects(settleWith(clock, u.runtime.command({ t: "pinSuite0", source: "link" })), refusedError);
	assert.equal(u.pinData.e2ee, undefined, "the engine never pins");

	// Started creating, but the relay already holds data (VAULT_READY.head > 0): not creatable.
	const late = new SimDevice({ name: "L", clock, net, pin: null });
	late.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void late.start();
	await wait(clock, "late reader read k", () => last(late)?.phase === "key-missing" && e2ee(late)?.keyringSeen === true);
	assert.equal(e2ee(late)?.creatable, false);
	await assert.rejects(settleWith(clock, late.runtime.command({ t: "enableE2ee", rk: RK_A.slice() })), refusedError);
	await assert.rejects(settleWith(clock, late.runtime.command({ t: "pinSuite0", source: "create" })), refusedError);
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1, "no second record");
	assert.equal(late.secrets.writes, 0);
});

test("an unverified QR key persists nothing; once k shows its record main stores it and pins suite 1, and the restart is live", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const u = new SimDevice({ name: "U", clock, net, pin: null });
	void u.start();
	await wait(clock, "no-pin", () => missing(u, "no-pin"));
	assert.deepEqual(await settleWith(clock, u.runtime.command({ t: "installKey", source: "qr", e: 1, k: K(1) })), { t: "ok" });
	await clock.advance(2_000);
	assert.equal(u.secrets.writes, 0, "pending: nothing reached SecretStorage");
	assert.equal(u.pinData.e2ee, undefined);
	assert.equal(e2ee(u)?.keyMissing, "no-pin");
	await appendGenesis(clock, net);
	await wait(clock, "main pinned suite 1", () => u.pinData.e2ee?.suite === 1);
	assert.deepEqual(storedEpochs(clock, u), [1], "K_1 in SecretStorage");
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1);
	await restart(clock, u);
	await wait(clock, "live after the restart", () => isLive(u) && e2ee(u)?.sealEpoch === 1);
	assert.equal(e2ee(u)?.suite, 1);
});

test("suite 1 end to end: genesis on the creation path, joins by RK and QR, sealed text and attachment, revoke and re-key", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const blobs = new SimBlobStore({ now: () => clock.now() });
	const dev = (name: string) => new SimDevice({ name, clock, net, pin: null, settings: ATTACHMENTS, blob: () => blobs });

	// X created the vault on the server (§15.1 step 1): creatable, then enableE2ee.
	const x = dev("X");
	x.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void x.start();
	await wait(clock, "creatable", () => e2ee(x)?.creatable === true);
	assert.deepEqual(await settleWith(clock, x.runtime.command({ t: "enableE2ee", rk: RK_A.slice() })), { t: "ok" });
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1);
	assert.equal(net.relay.head(), 1, "the genesis and nothing else");
	await wait(clock, "main pinned suite 1", () => x.pinData.e2ee?.suite === 1);
	assert.equal(x.pinData.creating, undefined, "the marker goes with the pin");
	assert.deepEqual(storedEpochs(clock, x), [1]);
	await assert.rejects(settleWith(clock, x.runtime.command({ t: "enableE2ee", rk: RK_A.slice() })), refusedError, "k is no longer empty");
	await restart(clock, x);
	await wait(clock, "X live, sealing under K_1", () => isLive(x) && e2ee(x)?.sealEpoch === 1);
	x.vault.userWrite("notes/secret.md", `${SECRET_TEXT}\n`);
	x.vault.externalWrite("img.png", SECRET_BYTES);
	await wait(clock, "X uploaded the attachment", () => blobs.objects.size > 0 && x.engineText("notes/secret.md") !== null);
	await clock.advance(10_000);

	// Y joins by recovery key, Z by QR (K_1 read from X's SecretStorage, as the pairing screen would).
	const y = dev("Y");
	void y.start();
	await wait(clock, "Y sees an encrypted vault", () => missing(y, "encrypted-vault"));
	assert.deepEqual(await settleWith(clock, y.runtime.command({ t: "installKey", source: "rk", rk: RK_A.slice() })), { t: "ok" });
	await wait(clock, "Y pinned suite 1", () => y.pinData.e2ee?.suite === 1);
	await restart(clock, y);
	const z = dev("Z");
	void z.start();
	await wait(clock, "Z sees an encrypted vault", () => missing(z, "encrypted-vault"));
	assert.deepEqual(await settleWith(clock, z.runtime.command({ t: "installKey", source: "qr", e: 1, k: storedKey(clock, x, 1) })), { t: "ok" });
	await wait(clock, "Z pinned suite 1", () => z.pinData.e2ee?.suite === 1);
	await restart(clock, z);
	for (const d of [y, z]) {
		await wait(clock, `${d.name} converged`, () => d.vault.textOf("notes/secret.md") === `${SECRET_TEXT}\n` && d.vault.bytesOf("img.png") !== null);
		assert.deepEqual(d.vault.bytesOf("img.png"), SECRET_BYTES);
	}
	y.vault.userWrite("notes/from-y.md", "y writes too\n");
	await wait(clock, "X has Y's note", () => x.vault.textOf("notes/from-y.md") === "y writes too\n");
	assert.ok(contains(enc.encode(y.vault.textOf("notes/secret.md") ?? ""), enc.encode(SECRET_TEXT)), "the needle is what the scan looks for");
	noPlaintext(net, blobs, enc.encode(SECRET_TEXT), "note text");
	noPlaintext(net, blobs, SECRET_BYTES, "attachment");

	// X revokes with a new recovery key (§14.2): Y and Z hold only K_1 and stop writing; Y follows by QR with K_2.
	assert.deepEqual(await settleWith(clock, x.runtime.command({ t: "revokeRekey", rk: RK_B.slice() })), { t: "ok" });
	await wait(clock, "X seals under K_2", () => e2ee(x)?.sealEpoch === 2 && isLive(x));
	assert.deepEqual(storedEpochs(clock, x), [1, 2], "K_2 stored by main before use");
	for (const d of [y, z]) await wait(clock, `${d.name} revoked`, () => missing(d, "revoked-epoch"));
	const head = net.relay.head();
	const stored = new Set(blobs.objects.keys());
	z.vault.userWrite("notes/from-z.md", "z after the revoke\n");
	z.vault.externalWrite("from-z.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
	await clock.advance(10_000);
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 2);
	assert.ok(!net.relay.streams().some((s) => net.relay.rows(s).some((r) => r.seq > head && r.deviceId === z.deviceId)), "Z wrote nothing after the revoke");
	assert.deepEqual([...blobs.objects.keys()].filter((a) => !stored.has(a)), [], "nor uploaded an attachment");
	assert.deepEqual(await settleWith(clock, y.runtime.command({ t: "installKey", source: "qr", e: 2, k: storedKey(clock, x, 2) })), { t: "ok" });
	await wait(clock, "Y live under K_2", () => isLive(y) && e2ee(y)?.sealEpoch === 2);
	assert.deepEqual(storedEpochs(clock, y), [1, 2]);
	y.vault.userWrite("notes/after.md", "after the re-key\n");
	await wait(clock, "X has Y's post-revoke note", () => x.vault.textOf("notes/after.md") === "after the re-key\n");
	assert.equal(z.vault.textOf("notes/after.md"), null, "Z cannot read past the revoke");
});

test("suite 1 without the key: installKey by RK starts the VaultRuntime in-process, no restart", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	await appendGenesis(clock, net);
	await clock.advance(1_000);
	// Pinned suite 1, but SecretStorage lost its contents (another device's sync, a wiped keychain).
	const d = new SimDevice({ name: "D", clock, net, pin: { suite: 1 } });
	void d.start();
	await wait(clock, "no-key", () => missing(d, "no-key"));
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1);
	d.vault.userWrite("notes/local.md", "typed while the key was missing\n");
	await clock.advance(5_000);
	assert.equal(net.relay.head(), 1, "nothing written without the key");
	const gc = await cleanUp(clock, d);
	assert.equal(gc.refused, "keys-unverified", "a closed device refuses the blob GC outright");
	assert.equal(gc.deleted, 0);
	assert.deepEqual(await settleWith(clock, d.runtime.command({ t: "installKey", source: "rk", rk: RK_A.slice() })), { t: "ok" });
	await wait(clock, "live under K_1", () => isLive(d) && e2ee(d)?.sealEpoch === 1);
	assert.equal(d.engineStarts, 1, "the same engine: the gate opened in-process");
	assert.deepEqual(storedEpochs(clock, d), [1], "stored by main before the gate opened");
	await wait(clock, "the local note reached the relay", () => net.relay.head() > 1);
	noPlaintext(net, null, enc.encode("typed while the key was missing"), "local note");
});

test("joins after a roll (QR at epoch 2) and after a revoke (RK at epoch 3) verify K_1 down the prevWrap chain, so the blob GC runs there", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const blobs = new SimBlobStore({ now: () => clock.now() });
	const dev = (name: string, tuning?: Partial<EngineTuning>) => new SimDevice({ name, clock, net, pin: null, settings: ATTACHMENTS, blob: () => blobs, tuning });
	const GC = { blobGcGraceMs: 1_000 };

	// X creates the vault, uploads an attachment under K_1, then rolls past the seq span (§4.2).
	const x = dev("X", { rollSeqSpan: 8 });
	x.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void x.start();
	await wait(clock, "creatable", () => e2ee(x)?.creatable === true);
	assert.deepEqual(await settleWith(clock, x.runtime.command({ t: "enableE2ee", rk: RK_A.slice() })), { t: "ok" });
	await wait(clock, "main pinned suite 1", () => x.pinData.e2ee?.suite === 1);
	await restart(clock, x);
	await wait(clock, "X live under K_1", () => isLive(x) && e2ee(x)?.sealEpoch === 1);
	x.vault.externalWrite("img.png", SECRET_BYTES);
	await wait(clock, "the attachment uploaded", () => blobs.objects.size === 1);
	for (let i = 0; i < 12 && e2ee(x)?.sealEpoch === 1; i++) {
		x.vault.userWrite(`notes/n${i}.md`, `note ${i}\n`);
		await clock.advance(1_000);
	}
	await wait(clock, "X rolled", () => isLive(x) && (e2ee(x)?.sealEpoch ?? 0) >= 2);
	const rolled = e2ee(x)!.sealEpoch;
	assert.ok(net.relay.rows(KEYRING_STREAM).length >= 2, "the genesis and a roll");
	// An object nothing references (an upload whose frame never committed), older than the grace.
	const orphan = "ab".repeat(32) as BlobAddress;
	await blobs.put(orphan, new Uint8Array(64));
	await clock.advance(10_000);

	// J joins by QR with only the post-roll key: K_1 comes from the roll's prevWrap, verified against the genesis.
	const j = dev("J", GC);
	void j.start();
	await wait(clock, "J sees an encrypted vault", () => missing(j, "encrypted-vault"));
	assert.deepEqual(await settleWith(clock, j.runtime.command({ t: "installKey", source: "qr", e: rolled, k: storedKey(clock, x, rolled) })), { t: "ok" });
	await wait(clock, "J pinned suite 1", () => j.pinData.e2ee?.suite === 1);
	assert.ok(storedEpochs(clock, j).includes(1), "K_1 reached main with the QR key");
	await restart(clock, j);
	await wait(clock, "J live, converged", () => isLive(j) && e2ee(j)?.sealEpoch === rolled && j.vault.bytesOf("img.png") !== null);
	assert.deepEqual(j.vault.bytesOf("img.png"), SECRET_BYTES);
	const gcJ = await cleanUp(clock, j);
	assert.deepEqual(gcJ, { t: "attachmentsCleaned", deleted: 1, keptNewer: 0, repaired: 0, lost: 0, refused: null, detail: null }, "J's sweep ran");
	assert.equal(blobs.uploadedAt(orphan), null, "the orphan is gone");
	assert.equal(blobs.objects.size, 1, "the referenced blob stays: J found it under its own kAddr");

	// X revokes with RK_B (§14.2). R joins by RK_B alone: K_top from the revoke's recoveryWrap, the rest by prevWrap.
	assert.deepEqual(await settleWith(clock, x.runtime.command({ t: "revokeRekey", rk: RK_B.slice() })), { t: "ok" });
	await wait(clock, "X seals above the revoke", () => isLive(x) && e2ee(x)!.sealEpoch === rolled + 1);
	await wait(clock, "J revoked", () => missing(j, "revoked-epoch"));
	const gcRevoked = await cleanUp(clock, j);
	assert.deepEqual([gcRevoked.refused, gcRevoked.deleted], ["keys-unverified", 0], "a revoked device is refused before it lists");
	const r = dev("R", GC);
	void r.start();
	await wait(clock, "R sees an encrypted vault", () => missing(r, "encrypted-vault"));
	assert.deepEqual(await settleWith(clock, r.runtime.command({ t: "installKey", source: "rk", rk: RK_B.slice() })), { t: "ok" });
	await wait(clock, "R pinned suite 1", () => r.pinData.e2ee?.suite === 1);
	assert.deepEqual(storedEpochs(clock, r), Array.from({ length: rolled + 1 }, (_, i) => i + 1), "every epoch down to K_1");
	await restart(clock, r);
	await wait(clock, "R live, converged", () => isLive(r) && e2ee(r)?.sealEpoch === rolled + 1 && r.vault.bytesOf("img.png") !== null);
	assert.deepEqual(r.vault.bytesOf("img.png"), SECRET_BYTES, "the K_1-addressed blob opens on R");
	const gcR = await cleanUp(clock, r);
	assert.equal(gcR.refused, null, `R's sweep ran (${gcR.refused ?? ""})`);
	assert.equal(gcR.deleted, 0, "the referenced blob stays: R found it under its own kAddr");
	noPlaintext(net, blobs, SECRET_BYTES, "attachment");
});
