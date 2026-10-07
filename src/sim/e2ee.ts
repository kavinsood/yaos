/**
 * Suite 1 in the seeded sim (e2ee-design §20.2, §20.3; WP-E7): onboarding, QR re-keys, the oracle's keys and the
 * relay leak checks. Keys and recovery keys come from the run's seeded RNG or a device's SecretStorage and are
 * passed by reference only: nothing here prints, traces or hashes one (trace lines carry epochs and counts).
 *
 * Onboarding (§15.1, §12.1): A is on the creation path (the `creating` marker), sees `creatable`, runs enableE2ee
 * with a seeded recovery key, main pins suite 1 and restarts it. Every other device starts unpinned, reads the
 * genesis ("encrypted-vault"), installs K_1 by QR (read from A's SecretStorage, as the pairing screen does), is
 * pinned once `k` shows the record, and restarts. Every wait runs the VirtualClock (runUntil), so the whole thing
 * is part of the seed's trace.
 */

import { KEYRING_STREAM, type DeviceId } from "../core/types";
import { CryptoSuite } from "../core/envelope";
import { decodeOuter } from "../core/codec/envelope";
import { padmeLen } from "../core/codec/padme";
import { sha256 } from "../core/hash/sha256";
import { bytesToHex } from "../core/codec/lib0";
import type { E2eeStatus, StatusSnapshot } from "../protocol/status";
import { VaultKeyStore, type StoredKeys } from "../host/keys/secretStore";
import { TOKEN_RE, type TokenLedger } from "./actors";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import type { Violation } from "./invariants";
import { SIM_VAULT_ID, type OracleKeys, type SimNet } from "./net";
import type { SeededRandom } from "./random";

/** Rows the sim's hostile relay forged (hostileReplay / hostileDowngrade): exempt from the leak checks. */
export const HOSTILE_DEVICE_PREFIX = "hostile-";

/** AES-GCM nonce + tag around a suite-1 sealed payload (webCryptoSuite1.ts). */
const AEAD_BYTES = 12 + 16;

export function lastStatus(d: SimDevice): StatusSnapshot | null {
	return d.ui.statuses[d.ui.statuses.length - 1] ?? null;
}

export function e2eeOf(d: SimDevice): E2eeStatus | undefined {
	return lastStatus(d)?.e2ee;
}

export function isLive(d: SimDevice): boolean {
	return lastStatus(d)?.phase === "live";
}

/** The key-missing reason of a device in that phase, else null. */
export function keyMissing(d: SimDevice): string | null {
	const s = lastStatus(d);
	return s?.phase === "key-missing" ? (s.e2ee?.keyMissing ?? "unknown") : null;
}

/** Settle `p` while running the clock (deterministic: no real waits beyond the clock's own). */
export async function settleOn<T>(clock: VirtualClock, p: Promise<T>, horizonMs = 60_000): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let r: { ok: true; value: T } | { ok: false; error: string } | null = null;
	p.then((value) => (r = { ok: true, value }), (e: unknown) => (r = { ok: false, error: errorText(e) }));
	await clock.runUntil(() => r !== null, horizonMs);
	return r ?? { ok: false, error: "not settled" };
}

/** An engine error's code or message (never a payload: command errors carry fixed text). */
function errorText(e: unknown): string {
	const code = (e as { error?: { code?: unknown } } | null)?.error?.code;
	if (typeof code === "string") return code;
	return e instanceof Error ? e.message : String(e);
}

/** The device's stored keys and records (fresh buffers), or null. */
export function storedKeys(d: SimDevice): StoredKeys | null {
	return new VaultKeyStore(d.secrets, SIM_VAULT_ID, d.deviceClock).load();
}

export function storedEpochs(d: SimDevice): number[] {
	return (storedKeys(d)?.keys ?? []).map((x) => x.e).sort((a, b) => a - b);
}

/** Main restarts the engine after a pin change (pluginController.ts requestRestart). */
export async function restartDevice(clock: VirtualClock, d: SimDevice): Promise<void> {
	await settleOn(clock, d.runtime.stop());
	await settleOn(clock, d.restartApp());
}

/** A seeded 32-byte recovery key (never printed). */
export function seededRk(rng: SeededRandom): Uint8Array {
	const rk = new Uint8Array(32);
	for (let i = 0; i < rk.length; i++) rk[i] = rng.int(256);
	return rk;
}

export interface OnboardResult {
	readonly ok: boolean;
	readonly lines: readonly string[];
}

/** A creates the vault encrypted, the others join by QR (module doc). Devices must not be started yet. */
export async function onboardSuite1(clock: VirtualClock, devs: readonly SimDevice[], rng: SeededRandom): Promise<OnboardResult> {
	const lines: string[] = [];
	const fail = (why: string): OnboardResult => ({ ok: false, lines: [...lines, `e2ee onboard failed: ${why}`] });
	const a = devs[0];
	if (!a) return fail("no devices");
	a.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void a.start();
	if (!(await clock.runUntil(() => e2eeOf(a)?.creatable === true, 60_000))) return fail(`${a.name} not creatable`);
	const rk = seededRk(rng.fork("rk"));
	const enabled = await settleOn(clock, a.runtime.command({ t: "enableE2ee", rk }));
	if (rk.byteLength > 0) rk.fill(0); // the command transfers it (detached) or it is still ours
	if (!enabled.ok) return fail(`${a.name} enableE2ee ${enabled.error}`);
	if (!(await clock.runUntil(() => a.pinData.e2ee?.suite === 1, 60_000))) return fail(`${a.name} not pinned`);
	await restartDevice(clock, a);
	if (!(await clock.runUntil(() => isLive(a) && e2eeOf(a)?.sealEpoch === 1, 60_000))) return fail(`${a.name} not live`);
	lines.push(`e2ee ${a.name} genesis k=${a.pinData.e2ee?.suite}`);
	for (const d of devs.slice(1)) {
		void d.start();
		if (!(await clock.runUntil(() => keyMissing(d) === "encrypted-vault", 60_000))) return fail(`${d.name} did not see the genesis`);
		const r = await qrInstall(clock, a, d, 1);
		if (!r.ok) return fail(`${d.name} ${r.error}`);
		if (!(await clock.runUntil(() => d.pinData.e2ee?.suite === 1, 60_000))) return fail(`${d.name} not pinned`);
		await restartDevice(clock, d);
		if (!(await clock.runUntil(() => isLive(d) && e2eeOf(d)?.sealEpoch === 1, 60_000))) return fail(`${d.name} not live`);
		lines.push(`e2ee ${d.name} joined by qr e=1`);
	}
	return { ok: true, lines };
}

/** `to` installs epoch `e`'s key read from `from`'s SecretStorage (the pairing QR), or fails without one. */
export async function qrInstall(clock: VirtualClock, from: SimDevice, to: SimDevice, e: number): Promise<{ ok: true } | { ok: false; error: string }> {
	const k = storedKeys(from)?.keys.find((x) => x.e === e)?.k;
	if (!k) return { ok: false, error: `no stored key for e=${e} on ${from.name}` };
	const r = await settleOn(clock, to.runtime.command({ t: "installKey", source: "qr", e, k }));
	if (k.byteLength > 0) k.fill(0);
	return r.ok ? { ok: true } : { ok: false, error: `installKey ${r.error}` };
}

/** Highest epoch stored on any device (the newest key a QR could carry). */
export function newestEpoch(devs: readonly SimDevice[]): { dev: SimDevice; e: number } | null {
	let best: { dev: SimDevice; e: number } | null = null;
	for (const d of devs) {
		const es = storedEpochs(d);
		const e = es[es.length - 1];
		if (e !== undefined && (!best || e > best.e)) best = { dev: d, e };
	}
	return best;
}

/** The oracle's keys: every epoch any device stored (copies), and the records of the device with the newest key. */
export function oracleKeys(devs: readonly SimDevice[]): OracleKeys | null {
	const byEpoch = new Map<number, Uint8Array>();
	let records: readonly Uint8Array[] = [];
	let top = -1;
	for (const d of devs) {
		const s = storedKeys(d);
		if (!s) continue;
		for (const x of s.keys) if (!byEpoch.has(x.e)) byEpoch.set(x.e, x.k);
		const e = Math.max(-1, ...s.keys.map((x) => x.e));
		if (e > top || (e === top && s.records.length > records.length)) {
			top = e;
			records = s.records;
		}
	}
	if (byEpoch.size === 0) return null;
	return { keys: [...byEpoch].sort(([x], [y]) => x - y).map(([e, k]) => ({ e, k })), records };
}

const LATIN1 = new TextDecoder("latin1");
const enc = new TextEncoder();

/** Paths and markers no relay byte may hold in the clear (each long enough that ciphertext cannot match by chance). */
const PLAIN_NEEDLES = ["notes/", "att/a", "att/b", ".obsidian", "seed "];

/**
 * The relay's view of a suite-1 run (§20.2 "sim leak checks", §7.3, §10.1):
 *  - every envelope (rows of every stream but `k`, and checkpoints) is suite 1 and its sealed body is a Padmé size
 *    plus the AEAD bytes (the relay learns O(log log M) bits of a length);
 *  - no payload or checkpoint holds a path, a seed text or any token the run typed;
 *  - no stream name holds the SHA-256 (hex) of any plaintext file or path on any device.
 * Rows the sim's hostile relay forged are skipped (deviceId HOSTILE_DEVICE_PREFIX).
 */
export function checkE2eeLeaks(devs: readonly SimDevice[], net: SimNet, ledger: TokenLedger): { violations: Violation[]; envelopes: number; sizes: number } {
	const out: Violation[] = [];
	const bad = (detail: string) => {
		if (out.length < 8) out.push({ inv: "e2ee", detail });
	};
	const tokens = new Set(ledger.entries.keys());
	const sizes = new Set<number>();
	let envelopes = 0;
	const scan = (bytes: Uint8Array, where: string) => {
		const outer = decodeOuter(bytes);
		envelopes++;
		if (!outer.ok) return bad(`${where}: not an envelope (${outer.reason})`);
		if (outer.header.suite !== CryptoSuite.aes256gcm) return bad(`${where}: suite ${outer.header.suite}`);
		const body = outer.sealed.length - AEAD_BYTES;
		if (body < 0 || padmeLen(body) !== body) return bad(`${where}: sealed body ${body} B is not a Padmé size`);
		sizes.add(outer.sealed.length);
		const s = LATIN1.decode(bytes);
		for (const n of PLAIN_NEEDLES) if (s.includes(n)) bad(`${where}: plaintext marker in the clear`);
		for (const m of s.matchAll(TOKEN_RE)) if (tokens.has(m[0])) bad(`${where}: a typed token in the clear`);
	};
	for (const stream of net.relay.streams()) {
		if (stream === KEYRING_STREAM) continue;
		const where = (seq: number) => `${stream.slice(0, 2)}#${seq}`;
		for (const r of net.relay.rows(stream, { includeGc: true })) {
			if ((r.deviceId as string).startsWith(HOSTILE_DEVICE_PREFIX)) continue;
			scan(r.payload, where(r.seq));
		}
		const cp = net.relay.checkpoint(stream);
		if (cp) scan(cp.bytes, `${stream.slice(0, 2)} checkpoint@${cp.coversSeq}`);
	}
	// Plaintext hashes: every file's bytes and every path on every device, now (the oracle's view of the vault).
	const hashes = new Set<string>();
	for (const d of devs) {
		for (const [path, text] of d.vault.snapshot()) {
			hashes.add(bytesToHex(sha256(enc.encode(path))));
			hashes.add(bytesToHex(sha256(d.vault.bytesOf(path) ?? enc.encode(text))));
		}
	}
	for (const stream of net.relay.streams()) {
		for (const h of hashes) if (h.length >= 64 && stream.includes(h.slice(0, 32))) bad(`stream ${stream.slice(0, 2)}…: named by a plaintext hash`);
	}
	return { violations: out, envelopes, sizes: sizes.size };
}

/** Rows written after `afterSeq` by `deviceId` (zero-write checks for a closed device). */
export function rowsBy(net: SimNet, deviceId: DeviceId, afterSeq: number): number {
	let n = 0;
	for (const s of net.relay.streams()) for (const r of net.relay.rows(s, { includeGc: true })) if (r.seq > afterSeq && r.deviceId === deviceId) n++;
	return n;
}
