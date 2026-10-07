/**
 * At-rest leak check (e2ee-design §6.1, §6.3; WP-E4): after a device stores vault keys and handles every key
 * command, no key or recovery-key byte sequence may appear anywhere but its own SecretStorage entry: not in
 * IndexedDB, data.json, side files, local storage, the vault, logs, statuses, notices or the relay. The scan looks
 * for raw bytes and every text encoding a slip could produce (hex, base64, base64url, decimal lists, typed-array
 * JSON, latin1). The second test runs suite 1 for real (a genesis, a join by RK, a revoke) and adds the diagnostics
 * bundle a key-holding VaultRuntime exports, the blob store and the blob addresses.
 * Only hit counts are reported, never bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode } from "../../core/codec/ids";
import { toHex } from "../../core/hash/sha256";
import { advanceUntil, settleWith } from "../../engine/keyring/testkit/simWait";
import { RK_A, RK_B } from "../../engine/keyring/testkit/world";
import { SimBlobStore } from "../../sim/blobStore";
import { VirtualClock } from "../../sim/clock";
import { SIM_SETTINGS, SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import type { StatusSnapshot } from "../../protocol/status";
import { YaosController } from "../pluginController";
import { defaultPluginData, type PairedIdentity, type YaosPluginData } from "../ui/api";
import { formatDiagnostics } from "../ui/diagnostics";
import { VaultKeyStore, secretIdFor } from "./secretStore";
import { fakeEpochKey, fakeGenesisRecord } from "./testkit/kRecords";
import { testVaultId } from "./testkit/vaultIds";

const ID: PairedIdentity = { host: "https://relay.example", vaultId: testVaultId("v1"), deviceId: "dev-A", deviceToken: "device-credential", deviceName: "A", vaultGeneration: null };

function base64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

/** Every text form of `secret` (and of each 16-byte half) a careless log, JSON or toString could produce. */
function textNeedles(secret: Uint8Array): string[] {
	const parts = [secret, secret.subarray(0, 16), secret.subarray(16)];
	const out = new Set<string>();
	for (const p of parts) {
		const hex = toHex(p);
		const b64 = base64(p);
		const b64u = base64urlEncode(p);
		for (const s of [hex, hex.toUpperCase(), b64, b64.replace(/=+$/, ""), b64u, b64u.replace(/=+$/, ""), `${b64u}=`, Array.from(p).join(","), Array.from(p).join(", ")]) out.add(s);
		out.add(String.fromCharCode(...p)); // latin1
		out.add(Array.from(p, (b, i) => `"${i}":${b}`).join(",")); // JSON.stringify of a typed array
	}
	return [...out].filter((s) => s.length >= 8);
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

class LeakScanner {
	private readonly raw: Uint8Array[] = [];
	private readonly text: string[] = [];
	readonly hits = new Map<string, number>();

	constructor(secrets: readonly Uint8Array[]) {
		for (const s of secrets) {
			this.raw.push(s.slice(), s.slice(0, 16), s.slice(16));
			this.text.push(...textNeedles(s));
		}
	}

	private hit(where: string): void {
		this.hits.set(where, (this.hits.get(where) ?? 0) + 1);
	}

	private bytes(where: string, b: Uint8Array): void {
		for (const n of this.raw) if (containsBytes(b, n)) this.hit(where);
		this.string(where, new TextDecoder("utf-8", { fatal: false }).decode(b));
	}

	private string(where: string, s: string): void {
		for (const n of this.text) if (s.includes(n)) this.hit(where);
	}

	/** Walks any value: strings, byte arrays, arrays, maps, sets, plain objects (and their JSON form). */
	scan(where: string, v: unknown, seen = new Set<unknown>()): void {
		if (v === null || v === undefined) return;
		if (typeof v === "string") return this.string(where, v);
		if (typeof v !== "object") return;
		if (seen.has(v)) return;
		seen.add(v);
		if (v instanceof Uint8Array) return this.bytes(where, v);
		if (ArrayBuffer.isView(v)) return this.bytes(where, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		if (v instanceof ArrayBuffer) return this.bytes(where, new Uint8Array(v));
		if (v instanceof Map) {
			for (const [k, x] of v) {
				this.scan(where, k, seen);
				this.scan(where, x, seen);
			}
			return;
		}
		if (v instanceof Set || Array.isArray(v)) {
			for (const x of v) this.scan(where, x, seen);
			return;
		}
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			this.string(where, k);
			this.scan(where, x, seen);
		}
		try {
			this.string(where, JSON.stringify(v));
		} catch {
			// cyclic: the walk above covered it
		}
	}

	total(): number {
		let n = 0;
		for (const c of this.hits.values()) n += c;
		return n;
	}
}

test("at rest: vault keys and recovery keys appear nowhere but the vault's SecretStorage entry", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const logs: string[] = [];
	const dev = new SimDevice({ name: "A", clock, net, log: (l) => logs.push(l) });
	dev.secrets.encryption = false; // a Linux desktop without a keyring: the plaintext notice path runs too
	const peer = new SimDevice({ name: "B", clock, net }); // suite 0 (fixture): fills the relay with real traffic
	peer.vault.userWrite("notes/b.md", "hello from b\n");
	void peer.start();
	const saved: YaosPluginData[] = [];
	const notices: string[] = [];
	const local = new Map<string, unknown>();
	const statuses: StatusSnapshot[] = [];
	const ctl = new YaosController({ ...defaultPluginData("A"), identity: ID }, {
		makeRuntime: (identity, settings, ui, keys) => dev.runtimeFor(identity, settings, ui, keys),
		saveData: async (d) => {
			saved.push(structuredClone(d));
		},
		notice: (level, m) => notices.push(`${level}:${m}`),
		log: (l) => logs.push(`controller: ${l}`),
		clock,
		secrets: dev.secrets,
		localStorage: { load: (k) => local.get(k) ?? null, save: (k, v) => local.set(k, v) },
	});
	ctl.onChange(() => {
		const s = ctl.status();
		if (s) statuses.push(structuredClone(s));
	});
	const start = ctl.start();
	await clock.advance(5_000);
	await start;

	const k1 = fakeEpochKey(0x11);
	const k2 = fakeEpochKey(0x22);
	const k3 = fakeEpochKey(0x33);
	const rk1 = fakeEpochKey(0x44);
	const rk2 = fakeEpochKey(0x55);
	const rk3 = fakeEpochKey(0x66);
	const secrets = [k1, k2, k3, rk1, rk2, rk3].map((s) => s.slice());
	const settle = async (p: Promise<unknown>): Promise<void> => {
		const out = p.then(() => undefined, () => undefined);
		await clock.advance(1_000);
		await out;
	};
	// The engine stores a verified key (pins suite 1, restarts with the key in its init config), then a second epoch.
	await settle(dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: k1 }], records: [fakeGenesisRecord()], pending: null }));
	await clock.advance(5_000);
	assert.deepEqual(ctl.data().e2ee, { suite: 1 });
	assert.equal(dev.engine?.config?.crypto.suite, 1);
	await settle(dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: fakeEpochKey(0x11) }, { e: 2, k: k2 }], records: [fakeGenesisRecord()], pending: null }));
	// Every key command, accepted by main or refused on either side.
	await settle(ctl.command({ t: "installKey", source: "qr", e: 3, k: k3 }));
	await settle(ctl.command({ t: "installKey", source: "rk", rk: rk1 }));
	await settle(ctl.command({ t: "revokeRekey", rk: rk2 }));
	await settle(ctl.command({ t: "enableE2ee", rk: rk3 }));
	await settle(ctl.command({ t: "pinSuite0", source: "link" }));
	// Restart the app over the same disk, secrets and IndexedDB: the keys reach the engine again.
	await settle(ctl.restartEngine());
	await clock.advance(5_000);
	assert.equal(dev.engine?.config?.crypto.suite, 1);
	assert.ok(notices.some((n) => n.includes("no system keyring")), "the plaintext notice ran");

	const scanner = new LeakScanner(secrets);
	// Positive control: the scanner finds what SecretStorage legitimately holds.
	const own = secretIdFor(ID.vaultId);
	const control = new LeakScanner(secrets);
	control.scan("secret-storage", dev.secretBacking.get(own));
	assert.ok(control.total() > 0, "the scanner detects stored key material");
	const probe = secrets[0]!;
	const embedded = new Uint8Array(80);
	embedded.set(probe, 9);
	for (const [form, leak] of [
		["raw", embedded], ["hex", `x ${toHex(probe)} y`], ["HEX", toHex(probe).toUpperCase()], ["base64", base64(probe)],
		["base64url", base64urlEncode(probe)], ["decimal", { k: Array.from(probe) }], ["json", JSON.stringify({ k: probe })],
	] as const) {
		const c = new LeakScanner(secrets);
		c.scan("probe", leak);
		assert.ok(c.total() > 0, `the scanner detects the ${form} form`);
	}

	for (const [id, value] of dev.secretBacking) if (id !== own) scanner.scan("secret-storage:other", value);
	for (const d of [dev, peer]) {
		for (const name of await d.storage.listDatabases()) scanner.scan(`indexeddb:${d.name}`, d.storage.dump(name));
		scanner.scan(`side-files:${d.name}`, d.sideFiles.files);
		scanner.scan(`vault:${d.name}`, d.vault.snapshot());
		scanner.scan(`ui:${d.name}`, d.ui);
	}
	scanner.scan("data.json", saved);
	scanner.scan("data.json", ctl.data());
	scanner.scan("local-storage", local);
	scanner.scan("logs", logs);
	scanner.scan("statuses", statuses);
	scanner.scan("notices", notices);
	for (const s of net.relay.streams()) {
		scanner.scan("relay-rows", net.relay.rows(s, { includeGc: true }).map((r) => r.payload));
		scanner.scan("relay-checkpoints", net.relay.checkpoint(s)?.bytes);
	}
	// Counts only (never bytes).
	assert.deepEqual(Object.fromEntries(scanner.hits), {}, "no key material at rest outside SecretStorage");
	assert.ok(logs.length > 0 && saved.length > 0 && statuses.length > 0, "the scanned sources are not empty");
	assert.ok(net.relay.head() > 0, "the relay carried traffic");
});

test("at rest, suite 1 running: a key-holding VaultRuntime's diagnostics bundle, stores, logs, relay and blobs hold no key", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const blobs = new SimBlobStore({ now: () => clock.now() });
	const logs: string[] = [];
	const settings = () => ({ ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 1 << 20 });
	const dev = (name: string) => new SimDevice({ name, clock, net, pin: null, settings, blob: () => blobs, log: (l) => logs.push(`${name}: ${l}`) });
	const wait = async (what: string, done: () => boolean): Promise<void> => assert.ok(await advanceUntil(clock, done, 60_000), what);
	const restart = async (d: SimDevice): Promise<void> => {
		await settleWith(clock, d.runtime.stop());
		await settleWith(clock, d.restartApp());
	};
	const sealing = (d: SimDevice, e: number) => d.ui.statuses.at(-1)?.phase === "live" && d.ui.statuses.at(-1)?.e2ee?.sealEpoch === e;

	// X creates an encrypted vault (§15.1), Y joins by recovery key; text and an attachment sync; X revokes (K_2, RK_B).
	const x = dev("X");
	x.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void x.start();
	await wait("creatable", () => x.ui.statuses.at(-1)?.e2ee?.creatable === true);
	await settleWith(clock, x.runtime.command({ t: "enableE2ee", rk: RK_A.slice() }));
	await wait("X pinned suite 1", () => x.pinData.e2ee?.suite === 1);
	await restart(x);
	await wait("X live under K_1", () => sealing(x, 1));
	x.vault.userWrite("notes/a.md", "a sealed note\n");
	x.vault.externalWrite("img.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
	await wait("X uploaded the attachment", () => blobs.objects.size > 0);
	const y = dev("Y");
	void y.start();
	await wait("Y sees an encrypted vault", () => y.ui.statuses.at(-1)?.e2ee?.keyMissing === "encrypted-vault");
	await settleWith(clock, y.runtime.command({ t: "installKey", source: "rk", rk: RK_A.slice() }));
	await wait("Y pinned suite 1", () => y.pinData.e2ee?.suite === 1);
	await restart(y);
	await wait("Y has the attachment", () => y.vault.bytesOf("img.png") !== null);
	await settleWith(clock, x.runtime.command({ t: "revokeRekey", rk: RK_B.slice() }));
	await wait("X live under K_2", () => sealing(x, 2));
	x.vault.userWrite("notes/b.md", "sealed under the second key\n");
	await clock.advance(10_000);
	const bundles: unknown[] = [];
	for (const includePaths of [false, true]) {
		const r = await settleWith(clock, x.runtime.command({ t: "exportDiagnostics", includePaths }));
		assert.equal(r.t, "diagnostics");
		if (r.t === "diagnostics") bundles.push(r.bundle, formatDiagnostics(r.bundle));
	}

	const held = new VaultKeyStore(x.secrets, SIM_VAULT_ID, clock).load();
	assert.deepEqual(held?.keys.map((k) => k.e), [1, 2], "main stored K_1 and K_2");
	const secrets = [...(held?.keys ?? []).map((k) => k.k.slice()), RK_A.slice(), RK_B.slice()];
	const own = secretIdFor(SIM_VAULT_ID);
	const control = new LeakScanner(secrets);
	control.scan("secret-storage", x.secretBacking.get(own));
	assert.ok(control.total() > 0, "the scanner detects stored key material");

	const scanner = new LeakScanner(secrets);
	scanner.scan("diagnostics", bundles);
	for (const d of [x, y]) {
		for (const [id, value] of d.secretBacking) if (id !== own) scanner.scan("secret-storage:other", value);
		for (const name of await d.storage.listDatabases()) scanner.scan(`indexeddb:${d.name}`, d.storage.dump(name));
		scanner.scan(`side-files:${d.name}`, d.sideFiles.files);
		scanner.scan(`vault:${d.name}`, d.vault.snapshot());
		scanner.scan(`ui:${d.name}`, d.ui);
		scanner.scan(`data.json:${d.name}`, d.pinData);
	}
	scanner.scan("logs", logs);
	for (const s of net.relay.streams()) {
		scanner.scan("relay-rows", net.relay.rows(s, { includeGc: true }).map((r) => r.payload));
		scanner.scan("relay-checkpoints", net.relay.checkpoint(s)?.bytes);
	}
	scanner.scan("blob-store", [...blobs.objects.values()].map((o) => o.bytes));
	scanner.scan("blob-addresses", [...blobs.objects.keys()]);
	// Counts only (never bytes).
	assert.deepEqual(Object.fromEntries(scanner.hits), {}, "no key material outside SecretStorage while suite 1 runs");
	assert.ok(bundles.length === 4 && logs.length > 0 && blobs.objects.size > 0, "the scanned sources are not empty");
});
