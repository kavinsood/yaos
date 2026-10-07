/**
 * Suite-1 (end-to-end encrypted) e2e (e2ee-design §12.4, §14.2, §15.1, §20.3) on a REAL local relay WITH attachment
 * storage (`start-local.sh --r2`). Every device runs the real plugin controller (src/host/pluginController.ts) over
 * a full client (fullKit.ts `runtimeFor`): main stores keys in SecretStorage, decides the pin and restarts the
 * engine, which gets the suite-1 adapter (webCryptoSuite1.ts) as in production.
 *   1 a creates the vault through the plugin's own creation flow (src/host/ui/createVault.ts, §15.1) on the fresh,
 *     unclaimed relay: POST /claim with an operator key made on main, the creation marker right after it, enroll
 *     with the owner code held in memory, then the step-3 check (head 0, empty k: status.e2ee.creatable) and
 *     "End-to-end encryption: On": the genesis, main pins suite 1 and restarts; a seals a note and an attachment
 *     under K_1. (On a relay that is already claimed, a logs in with the context file's operator key instead.)
 *   2 b joins key-less, sees an encrypted vault and writes nothing; installKey by RK pins it; c installs K_1 by QR
 *     (read from a's SecretStorage, as a's pairing screen would); every device converges, attachment bytes included
 *   3 on the relay at rest (its --persist-to dir: DO SQLite and the emulated R2 bucket): no note text, attachment
 *     bytes or file name
 *   4 revoke: the console revokes c (relay D7), a revokes and re-keys with a new RK (§14.2) and seals under K_2. b
 *     holds only K_1: its gate shuts (revoked-epoch), its blob GC is refused, a note it writes stays local until it
 *     installs K_2 by QR, then syncs
 *   5 d enrolls after the revoke. Before a key its blob GC is refused; installKey by the new RK pins it, K_1 verifies
 *     down the prevWrap chain, so d reads the old attachment and its GC runs: it deletes a planted orphan older than
 *     the grace and nothing else
 *   6 on the now-claimed relay, e creates a second vault with the operator key typed in (operator login, create,
 *     owner code, logout) and takes the opt-out (D2): suite 0 for good, enableE2ee refused afterwards
 *   7 a lying server: f's POST /operator/vaults answer names the encrypted vault instead of the new one; the step-3
 *     check finds it not empty, so the flow ends with "The server returned a vault that is not empty", the marker
 *     goes and no pin is set (f stays blocked)
 *   8 leaks: no key, RK, operator key or owner code (raw, hex, base64, base64url, decimal) in the diagnostics
 *     bundles, data.json, IndexedDB, logs, statuses, notices, the relay's state dir and log, or this run's results file
 *
 *   node --import jiti/register e2e/client/e2ee.ts --host http://127.0.0.1:8800 [--label local] [--state-dir DIR]
 *
 * --state-dir: the relay's --persist-to dir (default experiments/logs/client-e2e-local-<port>-state). Writes
 * LOG_DIR/client-e2e-e2ee-<label>-<stamp>.json (no secrets: counts only) and exits 1 on any failed check.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecoveryKey } from "../../src/core/codec/recoveryKey";
import { YaosController } from "../../src/host/pluginController";
import { VaultKeyStore, secretIdFor } from "../../src/host/keys/secretStore";
import { defaultPluginData, type YaosPluginData } from "../../src/host/ui/api";
import {
	confirmEmptyVault, createAndEnroll, CreateVaultError, enableEncryption, NOT_EMPTY_MESSAGE, optOutOfEncryption, probeServer,
	type CreateVaultHost,
} from "../../src/host/ui/createVault";
import { formatDiagnostics } from "../../src/host/ui/diagnostics";
import { generateOperatorKey, type PairingDeps, type RequestFn } from "../../src/host/ui/pairing";
import type { EngineResultValue, UserCommand } from "../../src/protocol/messages";
import type { E2eeStatus } from "../../src/protocol/status";
import type { BlobPort } from "../../src/ports/blob";
import type { BlobAddress } from "../../src/ports/crypto";
import { Report } from "./engineKit";
import { bytesOf, converge, randomBytes, sameBytes, sleep, waitFor } from "./fullCheck";
import { FullClient } from "./fullKit";
import {
	DEFAULT_LOG_DIR, loadOperatorKey, pairDevice, recordVault, redact, revokeDevice, saveOperatorKey, type OnboardDevice, type OnboardedVault,
} from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8800").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const PORT = new URL(HOST).port || "80";
const LOGS = `${new URL("../../..", import.meta.url).pathname}logs`;
const STATE_DIR = arg("state-dir", `${LOGS}/client-e2e-local-${PORT}-state`);
const R = new Report();
const GC_GRACE_MS = 8_000;
const enc = new TextEncoder();
const NOTE_PATH = "notes/e2ee-secret-plan.md";
const IMG_PATH = "img/e2ee-photo.png";
const NOTE_TEXT = `the plaintext body of a sealed note ${nodeRandomBytes(6).toString("hex")}`;
const IMG = randomBytes(48 * 1024, 4242);

interface Device {
	readonly client: FullClient;
	readonly ctl: YaosController;
	readonly saved: YaosPluginData[];
	readonly notices: string[];
	readonly logs: string[];
}
const devices: Device[] = [];
let vault: OnboardedVault | null = null;
/** SECRET: the recovery keys this run generated (copies; the commands get their own, which they zero-fill). */
const recoveryKeys: Uint8Array[] = [];
/** SECRET: the operator key (32 random bytes, hex) and the secret halves of the owner codes the creation flows saw. */
const operatorSecrets: string[] = [];

/**
 * A device. With `od` it is already enrolled in `vault` (data.json without e2ee: unpinned). Without, it is a fresh
 * install that creates a vault itself: its FullClient gets a throwaway identity for its own runtime, which never
 * starts (the controller's runtimeFor replaces it once the creation flow has stored the real identity).
 */
function device(name: string, od: OnboardDevice | null): Device {
	const throwaway: OnboardDevice = { name, deviceId: nodeRandomBytes(16).toString("base64url"), deviceToken: nodeRandomBytes(32).toString("base64url") };
	const client = new FullClient({ name, host: HOST, vaultId: od ? vault!.vaultId : nodeRandomBytes(16).toString("base64url"), device: od ?? throwaway,
		watcherDelayMs: 100, tuning: { blobGcGraceMs: GC_GRACE_MS } });
	const saved: YaosPluginData[] = [];
	const notices: string[] = [];
	const logs: string[] = [];
	const identity = od
		? { host: HOST, vaultId: vault!.vaultId, deviceId: od.deviceId, deviceToken: od.deviceToken, deviceName: name, vaultGeneration: vault!.vaultGeneration }
		: null;
	const data: YaosPluginData = { ...defaultPluginData(name), identity };
	const ctl = new YaosController(data, {
		makeRuntime: (id, settings, ui, keys) => client.runtimeFor(id, settings, ui, keys),
		saveData: async (d) => {
			saved.push(structuredClone(d));
		},
		notice: (level, m) => notices.push(`${level}:${m}`),
		log: (l) => logs.push(l),
		clock: client.clock,
		secrets: client.secrets,
	});
	const d = { client, ctl, saved, notices, logs };
	devices.push(d);
	return d;
}

/** The slice of YaosUiHost the creation flow uses, over the device's controller (as plugin.ts wires it). */
function uiHost(d: Device): CreateVaultHost {
	const c = d.ctl;
	return {
		data: () => c.data(), updateData: (m) => c.updateData(m), status: () => c.status(), onChange: (l) => c.onChange(l),
		command: (x) => c.command(x), markCreating: (v) => c.markCreating(v), abandonCreating: (v) => c.abandonCreating(v),
	};
}

/** "METHOD /path [origin]" of every request the creation flows sent (no bodies, no headers but whether Origin matched). */
const flowRequests: string[] = [];

/**
 * The creation flow's RequestFn over Node's fetch, shaped as obsidianEnv.ts's obsidianRequest (lower-cased headers,
 * set-cookie as an array). It keeps the secret half of every owner code it sees, for the leak scan only.
 */
const nodeRequest: RequestFn = async (req) => {
	const url = new URL(req.url);
	flowRequests.push(`${req.method} ${url.pathname.replace(/\/vaults\/[^/]+\//, "/vaults/:id/")}${req.headers?.Origin === url.origin ? " origin" : ""}`);
	const res = await fetch(req.url, { method: req.method, headers: req.headers ? { ...req.headers } : undefined, body: req.body });
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch { /* not JSON */ }
	const headers: Record<string, string | readonly string[]> = {};
	res.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
	const cookies = res.headers.getSetCookie();
	if (cookies.length > 0) headers["set-cookie"] = cookies;
	const code = (json as { pairingCode?: unknown } | null)?.pairingCode;
	if (typeof code === "string" && code.includes(".")) operatorSecrets.push(code.slice(code.indexOf(".") + 1));
	return { status: res.status, json, headers };
};
const flowDeps: PairingDeps = { request: nodeRequest, randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)) };

/** True when some save wrote `creating: {vaultId}` before any save stored an identity for it (§15.1 step 1). */
function markerBeforeIdentity(saved: readonly YaosPluginData[], vaultId: string): boolean {
	const enrolled = saved.findIndex((s) => s.identity?.vaultId === vaultId);
	return enrolled > 0 && saved.slice(0, enrolled).some((s) => s.creating?.vaultId === vaultId && s.identity === null);
}

const e2ee = (d: Device): E2eeStatus | undefined => d.client.ui.statuses.at(-1)?.e2ee;
const phase = (d: Device): string | undefined => d.client.ui.statuses.at(-1)?.phase;
const sealing = (d: Device, e: number) => phase(d) === "live" && e2ee(d)?.suite === 1 && e2ee(d)?.sealEpoch === e;
const missing = (d: Device, why: string) => phase(d) === "key-missing" && e2ee(d)?.keyMissing === why;

async function cmd<T extends EngineResultValue["t"]>(d: Device, command: UserCommand, t: T): Promise<Extract<EngineResultValue, { t: T }>> {
	const r = await d.ctl.command(command);
	if (r.t !== t) throw new Error(`${command.t} on ${d.client.name}: expected ${t}, got ${r.t}`);
	return r as Extract<EngineResultValue, { t: T }>;
}

/** SECRET: the vault key for epoch `e` from `d`'s SecretStorage (what a pairing / re-key QR carries). */
function storedKey(d: Device, e: number): Uint8Array {
	const k = new VaultKeyStore(d.client.secrets, vault!.vaultId, d.client.clock).load()?.keys.find((x) => x.e === e)?.k;
	if (!k) throw new Error(`${d.client.name} stores no key for epoch ${e}`);
	return k;
}
function storedEpochs(d: Device): number[] {
	return (new VaultKeyStore(d.client.secrets, vault!.vaultId, d.client.clock).load()?.keys ?? []).map((x) => x.e).sort((a, b) => a - b);
}
function newRk(): Uint8Array {
	const rk = makeRecoveryKey(new Uint8Array(nodeRandomBytes(32)));
	recoveryKeys.push(rk.slice());
	return rk;
}

function blobOf(d: Device): BlobPort {
	const s = d.client.vrt?.log.c.ports.blob;
	if (!s) throw new Error(`${d.client.name} has no blob store (relay started without --r2?)`);
	return s;
}
async function storedAddresses(d: Device): Promise<Set<string>> {
	const out = new Set<string>();
	let cursor: BlobAddress | null = null;
	do {
		const page = await blobOf(d).list(cursor);
		for (const it of page.items) out.add(it.address);
		cursor = page.next;
	} while (cursor !== null);
	return out;
}

/** Live, suite 1, sealing under epoch `e` (after a pin the controller restarts the engine itself). */
async function waitLive(d: Device, e: number, what: string, timeoutMs = 60_000): Promise<void> {
	await waitFor(() => sealing(d, e), what, timeoutMs, performance.now(), 50);
}

// ---- leak scan (counts only) -------------------------------------------------------

function textForms(b: Uint8Array): string[] {
	const buf = Buffer.from(b);
	const b64 = buf.toString("base64");
	const hex = buf.toString("hex");
	return [hex, hex.toUpperCase(), b64, b64.replace(/=+$/, ""), buf.toString("base64url"), Array.from(b).join(","), Array.from(b).join(", "),
		Array.from(b, (x, i) => `"${i}":${x}`).join(",")];
}

class LeakScan {
	private readonly needles: Buffer[] = [];
	readonly hits: Record<string, number> = {};
	/** `secrets`: key material (raw and text forms, halves too); `texts`: secret strings (operator key, owner codes). */
	constructor(secrets: readonly Uint8Array[], texts: readonly string[] = []) {
		for (const s of secrets) {
			for (const part of [s, s.subarray(0, 16), s.subarray(16)]) {
				this.needles.push(Buffer.from(part));
				for (const t of textForms(part)) this.needles.push(Buffer.from(t, "utf8"));
			}
		}
		for (const t of texts) {
			this.needles.push(Buffer.from(t, "utf8"));
			if (/^[0-9a-f]{64}$/.test(t)) for (const part of [Buffer.from(t, "hex")]) this.needles.push(part, Buffer.from(part.toString("base64url")));
		}
	}
	bytes(where: string, b: Uint8Array): void {
		const hay = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
		for (const n of this.needles) if (hay.includes(n)) this.hits[where] = (this.hits[where] ?? 0) + 1;
	}
	value(where: string, v: unknown, seen = new Set<unknown>()): void {
		if (v === null || v === undefined) return;
		if (typeof v === "string") return this.bytes(where, enc.encode(v));
		if (typeof v !== "object" || seen.has(v)) return;
		seen.add(v);
		if (ArrayBuffer.isView(v)) return this.bytes(where, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		if (v instanceof ArrayBuffer) return this.bytes(where, new Uint8Array(v));
		const items = v instanceof Map ? [...v.entries()].flat() : v instanceof Set || Array.isArray(v) ? [...v] : Object.entries(v).flat();
		for (const x of items) this.value(where, x, seen);
		try {
			this.bytes(where, enc.encode(JSON.stringify(v)));
		} catch { /* cyclic or BigInt: the walk covered it */ }
	}
	file(where: string, path: string): void {
		this.bytes(where, readFileSync(path));
	}
	get total(): number {
		return Object.values(this.hits).reduce((a, b) => a + b, 0);
	}
}

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else out.push(p);
		}
	};
	walk(dir);
	return out;
}

/** Every database, store, key and row of a client's fake-indexeddb. */
async function dumpIdb(c: FullClient): Promise<unknown[]> {
	const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => {
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const out: unknown[] = [];
	for (const info of await c.factory.databases()) {
		if (!info.name) continue;
		const db = await req(c.factory.open(info.name));
		for (const name of Array.from(db.objectStoreNames)) {
			const store = db.transaction(name, "readonly").objectStore(name);
			out.push(await req(store.getAllKeys()), await req(store.getAll()));
		}
		db.close();
	}
	return out;
}

/** Plaintext the relay must never hold under suite 1: the note text, slices of the attachment, the file names. */
function plaintextHits(files: readonly string[]): Record<string, number> {
	const needles: [string, Buffer][] = [
		["note text", Buffer.from(NOTE_TEXT)], ["attachment head", Buffer.from(IMG.subarray(0, 32))], ["attachment tail", Buffer.from(IMG.subarray(IMG.length - 32))],
		["note path", Buffer.from(NOTE_PATH)], ["attachment path", Buffer.from(IMG_PATH)],
	];
	const hits: Record<string, number> = {};
	for (const f of files) {
		const b = readFileSync(f);
		for (const [what, n] of needles) if (b.includes(n)) hits[what] = (hits[what] ?? 0) + 1;
	}
	return hits;
}

// ---- the run ---------------------------------------------------------------------

const bundles: unknown[] = [];
let k1: Uint8Array | null = null;
let k2: Uint8Array | null = null;

async function main(): Promise<void> {
	R.step("a creates the vault (§15.1): claim, marker, enroll with the in-memory owner code, head 0 + empty k, encryption On");
	const a = device("a", null);
	await a.ctl.start();
	const server = await probeServer(HOST, flowDeps);
	// Unclaimed (the fresh relay): main makes the operator key, as createVaultModal.ts does. The run keeps it in the
	// 0600 context file only, for the console revoke in step 4 (a user copies it to a password manager).
	const operatorKey = server.claimed ? loadOperatorKey(HOST) : generateOperatorKey(flowDeps.randomBytes);
	if (!operatorKey) throw new Error(`${HOST} is claimed and the context file holds no operator key`);
	operatorSecrets.push(operatorKey);
	if (!server.claimed) saveOperatorKey(HOST, operatorKey);
	const aHost = uiHost(a);
	const created = await createAndEnroll({ server, operatorKey, vaultName: `client-e2e-e2ee-${LABEL}`, deviceName: "client-e2e-a" }, aHost, flowDeps);
	const aId = a.ctl.data().identity;
	if (!aId || aId.vaultId !== created.vaultId || !aId.vaultGeneration) throw new Error("a is not enrolled in the vault it created");
	const v: OnboardedVault = { baseUrl: HOST, vaultId: aId.vaultId, vaultGeneration: aId.vaultGeneration, via: server.claimed ? "operator" : "claim",
		devices: [{ name: "a", deviceId: aId.deviceId, deviceToken: aId.deviceToken }] };
	vault = v;
	recordVault(HOST, `e2ee-${LABEL}`, v);
	const expected = server.claimed
		? ["GET /api/capabilities", "POST /operator/login origin", "POST /operator/vaults origin", "POST /operator/vaults/:id/owner-code origin", "POST /operator/logout origin"]
		: ["GET /api/capabilities", "POST /claim origin", "POST /operator/logout origin"];
	const sent = flowRequests.filter((r) => r !== "POST /enroll");
	R.check(`step 1 is ${server.claimed ? "operator login + create + owner code" : "the claim"}, with the server's Origin, then logout; step 2 is /enroll only`,
		sent.join() === expected.join() && flowRequests.includes("POST /enroll"), flowRequests);
	R.check("main wrote the creation marker right after step 1, before the identity; no pendingEnrollment was ever saved",
		markerBeforeIdentity(a.saved, v.vaultId) && a.saved.every((s) => s.pendingEnrollment === undefined), a.saved.length);
	await confirmEmptyVault(aHost, v.vaultId, { timeoutMs: 30_000 });
	R.check("step 3: a is unpinned and creatable (head 0, empty k, read on this session)", e2ee(a)?.creatable === true && e2ee(a)?.suite === null && a.ctl.data().e2ee === undefined, e2ee(a));
	const rkA = newRk();
	await enableEncryption(aHost, v.vaultId, rkA);
	// Transferred (detached: byteLength 0) or zero-filled: main keeps no copy (§6.3).
	R.check("main kept no copy of the recovery key it handed to the engine", rkA.buffer.byteLength === 0 || rkA.every((x) => x === 0));
	await waitLive(a, 1, "a live under K_1");
	R.check("main pinned a to suite 1, dropped the creation marker, stored K_1", a.ctl.data().e2ee?.suite === 1 && a.ctl.data().creating === undefined && storedEpochs(a).join() === "1",
		{ pin: a.ctl.data().e2ee, epochs: storedEpochs(a) });
	k1 = storedKey(a, 1);
	a.client.vault.userWrite(NOTE_PATH, `${NOTE_TEXT}\n`);
	a.client.vault.externalWrite(IMG_PATH, IMG);
	await a.client.runtime.command({ t: "reconcileNow" });
	await waitFor(async () => (await storedAddresses(a)).size > 0, "a uploaded the attachment", 30_000, performance.now(), 100);
	R.check("one sealed attachment in the blob store", (await storedAddresses(a)).size === 1);

	R.step("b joins key-less (blocked, writes nothing), installs by RK; c installs K_1 by QR; all converge");
	const b = device("b", await pairDevice(v, "b"));
	const c = device("c", await pairDevice(v, "c"));
	await b.ctl.start();
	await waitFor(() => missing(b, "encrypted-vault"), "b sees an encrypted vault", 30_000, performance.now(), 50);
	b.client.vault.userWrite("notes/b-before-key.md", "typed before the key\n");
	await sleep(2_000);
	R.check("b, unpinned, stays blocked with keyringSeen and pins nothing", missing(b, "encrypted-vault") && e2ee(b)?.keyringSeen === true && b.ctl.data().e2ee?.suite === null,
		{ status: e2ee(b), pin: b.ctl.data().e2ee });
	const gcBlocked = await cmd(b, { t: "cleanUpAttachments" }, "attachmentsCleaned");
	R.check("b's blob GC before a key: refused keys-unverified, nothing deleted", gcBlocked.refused === "keys-unverified" && gcBlocked.deleted === 0, gcBlocked);
	await cmd(b, { t: "installKey", source: "rk", rk: recoveryKeys[0]!.slice() }, "ok");
	await waitLive(b, 1, "b live under K_1");
	R.check("main pinned b to suite 1 and stored K_1", b.ctl.data().e2ee?.suite === 1 && storedEpochs(b).join() === "1", { pin: b.ctl.data().e2ee, epochs: storedEpochs(b) });
	await c.ctl.start();
	await waitFor(() => missing(c, "encrypted-vault"), "c sees an encrypted vault", 30_000, performance.now(), 50);
	await cmd(c, { t: "installKey", source: "qr", e: 1, k: storedKey(a, 1) }, "ok");
	await waitLive(c, 1, "c live under K_1");
	c.client.vault.userWrite("notes/from-c.md", "c writes under K_1\n");
	await converge([a.client, b.client, c.client], 120_000);
	R.check("b and c read a's note and attachment; a reads b's pre-key note and c's note",
		[b, c].every((d) => d.client.vault.textOf(NOTE_PATH) === `${NOTE_TEXT}\n`) && a.client.vault.textOf("notes/b-before-key.md") === "typed before the key\n"
		&& a.client.vault.textOf("notes/from-c.md") === "c writes under K_1\n");
	R.check("attachment bytes are equal on b and c", sameBytes(await bytesOf(b.client, IMG_PATH), IMG) && sameBytes(await bytesOf(c.client, IMG_PATH), IMG));

	R.step("at rest on the relay: no note text, attachment bytes or file names");
	const relayFiles = filesUnder(STATE_DIR);
	const leaked = plaintextHits(relayFiles);
	R.check("the relay's state dir (DO SQLite, emulated R2) holds no plaintext", Object.keys(leaked).length === 0, { files: relayFiles.length, hits: leaked });
	const probeDir = mkdtempSync(join(tmpdir(), "yaos-e2ee-probe-"));
	writeFileSync(join(probeDir, "probe"), Buffer.concat([Buffer.from("x"), Buffer.from(NOTE_TEXT), Buffer.from(IMG.subarray(0, 64)), Buffer.from(NOTE_PATH)]));
	const control = plaintextHits(filesUnder(probeDir));
	rmSync(probeDir, { recursive: true, force: true });
	R.check("positive control: the same scan finds the plaintext in a probe file", control["note text"] === 1 && control["attachment head"] === 1 && control["note path"] === 1, control);

	R.step("revoke: console revokes c; a revokes and re-keys (K_2, new RK); b's gate shuts until it installs K_2 by QR");
	const before = await storedAddresses(a);
	await revokeDevice(v, c.client.o.device.deviceId);
	const rkB = newRk();
	await cmd(a, { t: "revokeRekey", rk: rkB }, "ok");
	await waitLive(a, 2, "a live under K_2");
	R.check("a stored K_2 before sealing under it", storedEpochs(a).join() === "1,2", storedEpochs(a));
	k2 = storedKey(a, 2);
	await waitFor(() => missing(b, "revoked-epoch"), "b's gate shut (revoked-epoch)", 30_000, performance.now(), 50);
	R.check("b holds only K_1: phase key-missing, revoked-epoch", missing(b, "revoked-epoch"), e2ee(b));
	b.client.vault.userWrite("notes/b-held.md", "written while the gate was shut\n");
	b.client.vault.externalWrite("img/b-held.png", randomBytes(4 * 1024, 77));
	await b.client.runtime.command({ t: "reconcileNow" });
	await sleep(4_000);
	R.check("nothing b wrote while revoked reached a, and b uploaded no attachment", a.client.vault.textOf("notes/b-held.md") === null && (await storedAddresses(a)).size === before.size,
		{ stored: (await storedAddresses(a)).size, before: before.size });
	const gcRevoked = await cmd(b, { t: "cleanUpAttachments" }, "attachmentsCleaned");
	R.check("b's blob GC while revoked: refused keys-unverified, nothing deleted", gcRevoked.refused === "keys-unverified" && gcRevoked.deleted === 0, gcRevoked);
	await cmd(b, { t: "installKey", source: "qr", e: 2, k: storedKey(a, 2) }, "ok");
	await waitLive(b, 2, "b live under K_2");
	await waitFor(() => a.client.vault.textOf("notes/b-held.md") === "written while the gate was shut\n", "b's held note reached a", 60_000, performance.now(), 100);
	R.check("after the re-key b's held note and attachment sync, sealed under K_2", storedEpochs(b).join() === "1,2" && sameBytes(await bytesOf(a.client, "img/b-held.png"), randomBytes(4 * 1024, 77)),
		storedEpochs(b));
	a.client.vault.userWrite("notes/after-revoke.md", "c must never read this\n");
	await sleep(3_000);
	R.check("c (revoked at the relay) never reads past the revoke", c.client.vault.textOf("notes/after-revoke.md") === null,
		{ phase: phase(c), fatals: c.client.ui.fatals.map((f) => f.code) });

	R.step("d enrolls after the revoke: GC refused before a key; installKey by the new RK; K_1 via prevWrap; GC runs");
	const od = await pairDevice(v, "d");
	const d = device("d", od);
	await d.ctl.start();
	await waitFor(() => missing(d, "encrypted-vault"), "d sees an encrypted vault", 30_000, performance.now(), 50);
	const gcNoKey = await cmd(d, { t: "cleanUpAttachments" }, "attachmentsCleaned");
	R.check("d's blob GC before a key: refused keys-unverified", gcNoKey.refused === "keys-unverified" && gcNoKey.deleted === 0, gcNoKey);
	await cmd(d, { t: "installKey", source: "rk", rk: recoveryKeys[1]!.slice() }, "ok");
	await waitLive(d, 2, "d live under K_2");
	await converge([a.client, b.client, d.client], 120_000);
	R.check("d stored K_1 and K_2 (K_1 down the prevWrap chain) and reads the K_1 attachment", storedEpochs(d).join() === "1,2" && sameBytes(await bytesOf(d.client, IMG_PATH), IMG),
		storedEpochs(d));
	const orphan = randomBytes(16 * 1024, 901);
	const orphanAddr = nodeRandomBytes(32).toString("hex") as BlobAddress;
	await blobOf(d).put(orphanAddr, orphan);
	const stored0 = await storedAddresses(d);
	await sleep(GC_GRACE_MS + 2_000);
	const gc = await cmd(d, { t: "cleanUpAttachments" }, "attachmentsCleaned");
	const stored1 = await storedAddresses(d);
	R.check("d's GC ran and deleted exactly the orphan", gc.refused === null && gc.lost === 0 && gc.deleted === 1 && !stored1.has(orphanAddr) && stored1.size === stored0.size - 1,
		{ gc, before: stored0.size, after: stored1.size });

	R.step("e creates a second vault on the now-claimed relay with the operator key typed in, and opts out (D2)");
	const encrypted = v;
	const e = device("e", null);
	await e.ctl.start();
	const eHost = uiHost(e);
	const sentBefore = flowRequests.length;
	const claimedNow = await probeServer(HOST, flowDeps);
	const eVault = await createAndEnroll({ server: claimedNow, operatorKey: ` ${operatorKey}\n`, vaultName: "  client-e2e  second\tvault ", deviceName: "client-e2e-e" }, eHost, flowDeps);
	R.check("the relay is claimed now; e used operator login, create, owner code and logout, with the server's Origin",
		claimedNow.claimed && flowRequests.slice(sentBefore).filter((r) => r !== "POST /enroll").join() === ["GET /api/capabilities", "POST /operator/login origin",
			"POST /operator/vaults origin", "POST /operator/vaults/:id/owner-code origin", "POST /operator/logout origin"].join(), flowRequests.slice(sentBefore));
	R.check("e is enrolled in a new vault, not a's", eVault.vaultId !== encrypted.vaultId && e.ctl.data().identity?.vaultId === eVault.vaultId);
	await confirmEmptyVault(eHost, eVault.vaultId, { timeoutMs: 30_000 });
	await optOutOfEncryption(eHost, eVault.vaultId);
	await waitFor(() => phase(e) === "live" && e2ee(e)?.suite === 0, "e live under suite 0", 60_000, performance.now(), 50);
	R.check("main pinned e to suite 0 and dropped the marker; e is live, unencrypted", e.ctl.data().e2ee?.suite === 0 && e.ctl.data().creating === undefined,
		{ pin: e.ctl.data().e2ee, status: e2ee(e) });
	const refusedRaise = await e.ctl.command({ t: "enableE2ee", rk: newRk() }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
	R.check("a suite-0 pin is never raised: enableE2ee is refused on e", refusedRaise !== null && e.ctl.data().e2ee?.suite === 0, refusedRaise);

	R.step("a lying server answers f's vault creation with the encrypted vault: step 3 refuses it, no pin");
	const f = device("f", null);
	await f.ctl.start();
	const fHost = uiHost(f);
	// The relay mints the owner code for whatever vault the (rewritten) create answer named: a's encrypted vault.
	const lying: RequestFn = async (req) => {
		const res = await nodeRequest(req);
		if (req.method !== "POST" || new URL(req.url).pathname !== "/operator/vaults" || res.status !== 200) return res;
		const json = structuredClone(res.json) as { vault?: { vaultId?: string } };
		if (json.vault) json.vault.vaultId = encrypted.vaultId;
		return { ...res, json };
	};
	const fVault = await createAndEnroll({ server: claimedNow, operatorKey, vaultName: "client-e2e-lied-about", deviceName: "client-e2e-f" }, fHost,
		{ ...flowDeps, request: lying });
	R.check("f enrolled in the vault the server named (the encrypted one) and holds its creation marker",
		fVault.vaultId === encrypted.vaultId && f.ctl.data().creating?.vaultId === encrypted.vaultId);
	const fRefusal = await confirmEmptyVault(fHost, fVault.vaultId, { timeoutMs: 30_000 }).then(() => null, (err: unknown) => err);
	R.check("step 3 ends the flow with \"The server returned a vault that is not empty\"",
		fRefusal instanceof CreateVaultError && fRefusal.code === "not-empty" && fRefusal.message === NOT_EMPTY_MESSAGE, String(fRefusal));
	await waitFor(() => missing(f, "encrypted-vault"), "f blocked (encrypted-vault)", 30_000, performance.now(), 50);
	R.check("f: marker dropped, no pin (keyringSeen only), blocked as an encrypted vault",
		f.ctl.data().creating === undefined && f.ctl.data().e2ee?.suite === null && missing(f, "encrypted-vault"), { pin: f.ctl.data().e2ee, status: e2ee(f) });
	const fEnable = await f.ctl.command({ t: "enableE2ee", rk: newRk() }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
	const fOptOut = await f.ctl.command({ t: "pinSuite0", source: "create" }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
	R.check("f can neither enable encryption nor opt out afterwards", fEnable !== null && fOptOut !== null && f.ctl.data().e2ee?.suite === null, { fEnable, fOptOut });

	R.step("diagnostics bundles from a key-holding runtime");
	for (const includePaths of [false, true]) {
		const r = await cmd(a, { t: "exportDiagnostics", includePaths }, "diagnostics");
		bundles.push(r.bundle, formatDiagnostics(r.bundle));
	}
	R.check("a exported both bundles", bundles.length === 4);
}

async function stopAll(): Promise<void> {
	for (const d of devices) {
		try { await d.ctl.stop(); } catch { /* best effort */ }
		try { await d.client.stop(); } catch { /* best effort */ }
	}
}

/** Every key and RK of the run against everything the run left behind; counts only. */
async function scanLeaks(): Promise<LeakScan | null> {
	if (!k1 || !k2 || recoveryKeys.length < 2 || !vault) return null;
	const secrets = [k1, k2, ...recoveryKeys];
	const own = secretIdFor(vault.vaultId);
	const control = new LeakScan(secrets);
	control.value("secret-storage", devices[0]!.client.secrets.getSecret(own));
	R.check("positive control: the scan finds the keys in a's SecretStorage entry", control.total > 0);
	const opControl = new LeakScan([], operatorSecrets);
	opControl.value("probe", { operatorRecoveryKey: operatorSecrets[0], codes: operatorSecrets.slice(1) });
	R.check("positive control: the scan finds the operator key and every owner code", operatorSecrets.length >= 4 && opControl.total >= operatorSecrets.length,
		{ secrets: operatorSecrets.length, hits: opControl.total });
	const scan = new LeakScan(secrets, operatorSecrets);
	scan.value("diagnostics", bundles);
	for (const d of devices) {
		const n = d.client.name;
		for (const [id, v] of d.client.secrets.backing) if (id !== own) scan.value("secret-storage:other", v);
		scan.value(`data.json:${n}`, d.saved);
		scan.value(`data.json:${n}`, d.ctl.data());
		scan.value(`logs:${n}`, [d.logs, d.client.logLines]);
		scan.value(`notices:${n}`, d.notices);
		scan.value(`ui:${n}`, d.client.ui);
		scan.value(`indexeddb:${n}`, await dumpIdb(d.client));
		scan.value(`vault:${n}`, d.client.vault.snapshot());
		scan.value(`side-files:${n}`, d.client.sideFiles.files);
	}
	for (const f of filesUnder(STATE_DIR)) scan.file("relay-state", f);
	for (const f of readdirSync(LOGS).filter((x) => x.startsWith(`client-e2e-local-${PORT}-`) && x.endsWith(".log"))) {
		const p = join(LOGS, f);
		if (statSync(p).mtimeMs >= R.started.getTime() - 120_000) scan.file("relay-log", p);
	}
	return scan;
}

let fatal: string | null = null;
let scan: LeakScan | null = null;
try {
	await main();
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
	for (const d of devices) R.extra[`logs ${d.client.name}`] = redact(d.client.logLines.slice(-60));
} finally {
	for (const d of devices) R.extra[`notices ${d.client.name}`] = d.client.ui.notices.map((n) => `${n.level}:${n.code}`);
	await stopAll();
}
try {
	R.step("leak scan: keys, recovery keys, the operator key and owner codes outside SecretStorage");
	scan = await scanLeaks();
	R.check("no key, recovery key, operator key or owner code anywhere but SecretStorage", scan !== null && scan.total === 0, scan?.hits ?? "the run did not get far enough to scan");
} catch (e) {
	R.check("leak scan completed", false, e instanceof Error ? e.message : String(e));
}
const [out, failedCount] = R.write(DEFAULT_LOG_DIR, "client-e2e-e2ee", LABEL, HOST, vault, fatal);
let failed = failedCount;
if (k1 && k2) {
	const results = new LeakScan([k1, k2, ...recoveryKeys], operatorSecrets);
	results.file("results", out);
	if (results.total > 0) {
		console.log("FAIL the results file holds key material");
		failed++;
	}
}
for (const s of [k1, k2, ...recoveryKeys]) s?.fill(0);
operatorSecrets.length = 0;
process.exit(failed === 0 ? 0 : 1);
