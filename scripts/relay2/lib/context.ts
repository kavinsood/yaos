/**
 * Vault context for a relay2 worker: claim → enroll A → pairing → enroll B (C, D… on demand),
 * operator login. Persisted (secrets included) to logs/relay2/context-<worker>.json; never printed.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateLifecycle, requestJson, sha256Hex, vaultRoute } from "../../../tests/live/schema4Live";
import { ProductionImportSession } from "../../../tests/live/productionImport";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import type { LifecycleRequest } from "../../../server/src/contracts";
import { LOG_DIR, json, log, sleep, workerName } from "./common";

export interface Context {
	host: string;
	vaultId: string;
	vaultGeneration: string;
	operatorRecoveryKey: string;
	operatorCookie: string;
	devices: Record<string, LiveIdentity>;
	createdAt: string;
	seeded?: Record<string, unknown>;
}

export function contextPath(host: string) { return join(LOG_DIR, `context-${workerName(host)}.json`); }

export function saveContext(context: Context) {
	const path = contextPath(context.host);
	writeFileSync(path, JSON.stringify(context, null, 2));
	chmodSync(path, 0o600);
}

export function loadContext(host: string): Context {
	const path = contextPath(host);
	if (!existsSync(path)) throw new Error(`no context for ${host}; run scripts/relay2/context.ts --host ${host}`);
	return JSON.parse(readFileSync(path, "utf8")) as Context;
}

export function hasContext(host: string) { return existsSync(contextPath(host)); }

async function enroll(host: string, pairingCode: string, deviceName: string, vaultId: string) {
	const deviceId = randomBytes(16).toString("base64url");
	const deviceToken = randomBytes(32).toString("base64url");
	const response = await fetch(`${host}/enroll`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode, enrollmentRequestId: randomBytes(16).toString("base64url"), deviceId, deviceToken, deviceName }) });
	const value = await json(response);
	if (!response.ok || value?.deviceId !== deviceId || typeof value?.vaultGeneration !== "string") {
		throw new Error(`enroll failed ${response.status} ${JSON.stringify({ error: value?.error ?? null })}`);
	}
	return { identity: { host, vaultId, deviceId, deviceToken } as LiveIdentity, vaultGeneration: value.vaultGeneration };
}

export async function operatorLogin(host: string, operatorRecoveryKey: string): Promise<string> {
	const login = await fetch(`${host}/operator/login`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }) });
	const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
	await login.arrayBuffer();
	if (!login.ok || !cookie) throw new Error(`operator login failed (${login.status})`);
	return cookie;
}

function findVaultId(v: unknown): string | null {
	if (!v || typeof v !== "object") return null;
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
		if (k === "vaultId" && typeof x === "string") return x;
		const inner = findVaultId(x);
		if (inner) return inner;
	}
	return null;
}

async function recoverClaim(host: string, operatorRecoveryKey: string): Promise<{ vaultId: string; pairingCode: string } | null> {
	const cap = await json(await fetch(`${host}/api/capabilities`));
	if (cap?.claimed !== true) return null;
	let cookie: string;
	try { cookie = await operatorLogin(host, operatorRecoveryKey); } catch { return null; }
	const state = await json(await fetch(`${host}/operator/state`, { headers: { Cookie: cookie } }));
	const vaultId = findVaultId(Array.isArray(state?.vaults) && state.vaults.length === 1 ? state.vaults[0] : null);
	if (!vaultId) return null;
	// A claim that answered 503 vault_provisioning_failed leaves the vault in "provisioning" (retryable):
	// re-run provisioning through the operator route until it is active, otherwise enroll answers 409 vault_not_active.
	for (let attempt = 0; attempt < 6; attempt++) {
		const provision = await fetch(`${host}/operator/vaults/${encodeURIComponent(vaultId)}/provision`, { method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
		const value = await json(provision);
		if (provision.ok) {
			log(`vault provisioning ${attempt === 0 ? "confirmed" : "completed on retry " + attempt} (state ${String(value?.vault?.state ?? "?")})`);
			break;
		}
		log(`operator provision retry ${attempt + 1} returned ${provision.status} (${String(value?.error ?? "")}: ${String(value?.message ?? "").slice(0, 120)})`);
		await sleep(3000 * (attempt + 1));
	}
	const code = await json(await fetch(`${host}/operator/vaults/${encodeURIComponent(vaultId)}/owner-code`, { method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "owner-bootstrap" }) }));
	if (typeof code?.pairingCode !== "string") return null;
	log(`claim recovered via operator owner-bootstrap code (vault ${vaultId.slice(0, 8)}...)`);
	return { vaultId, pairingCode: code.pairingCode };
}

export async function claim(host: string, deviceNames = ["A", "B"]): Promise<Context> {
	const cap = await fetch(`${host}/api/capabilities`);
	const capValue = await json(cap);
	if (capValue?.claimed !== false) throw new Error(`worker ${host} is not fresh (claimed=${capValue?.claimed}, status ${cap.status})`);
	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claimResponse = await fetch(`${host}/claim`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }) });
	let claimed = await json(claimResponse);
	if (!claimResponse.ok || typeof claimed?.vaultId !== "string" || typeof claimed.pairingCode !== "string") {
		// A just-deployed worker has answered 503 while still committing the claim (the next capabilities probe
		// says claimed=true). If our recovery key logs in, the claim is ours: mint an owner-bootstrap code.
		log(`claim returned ${claimResponse.status} (${String(claimed?.error ?? "")}${claimed?.message ? ": " + String(claimed.message).slice(0, 160) : ""}); checking whether it committed`);
		claimed = null;
		for (let attempt = 0; attempt < 6 && !claimed; attempt++) {
			await sleep(3000 * (attempt + 1));
			const now = await json(await fetch(`${host}/api/capabilities`));
			if (now?.claimed === false) {
				// Not committed: retry the claim with the same key.
				const retry = await fetch(`${host}/claim`, { method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ operatorRecoveryKey }) });
				const body = await json(retry);
				if (retry.ok && typeof body?.vaultId === "string" && typeof body.pairingCode === "string") claimed = body;
				else log(`claim retry ${attempt + 1} returned ${retry.status}`);
			} else if (now?.claimed === true) {
				claimed = await recoverClaim(host, operatorRecoveryKey);
				if (!claimed) log(`claim recovery attempt ${attempt + 1} failed`);
			}
		}
		if (!claimed) throw new Error(`claim failed ${claimResponse.status}`);
	}
	for (let i = 0; i < 20; i++) {
		const probes = await Promise.all(Array.from({ length: 8 }, () => fetch(`${host}/api/capabilities`).then(json)));
		if (probes.every((p) => p?.claimed === true)) break;
		await sleep(1000);
	}
	const first = await enroll(host, claimed.pairingCode, `relay2-${deviceNames[0]}`, claimed.vaultId);
	const context: Context = { host, vaultId: claimed.vaultId, vaultGeneration: first.vaultGeneration, operatorRecoveryKey,
		operatorCookie: await operatorLogin(host, operatorRecoveryKey), devices: { [deviceNames[0]!]: first.identity },
		createdAt: new Date().toISOString() };
	saveContext(context);
	for (const name of deviceNames.slice(1)) await addDevice(context, name);
	log(`claimed ${workerName(host)} vault; devices ${Object.keys(context.devices).join(",")}`);
	return context;
}

/** Enroll another device via a pairing code minted by device A. */
export async function addDevice(context: Context, name: string): Promise<LiveIdentity> {
	if (context.devices[name]) return context.devices[name]!;
	const a = context.devices.A!;
	const pairingResponse = await fetch(vaultRoute(a, "auth/pairing-code"), { method: "POST",
		headers: deviceBearerHeaders(a, { "Content-Type": "application/json" }), body: JSON.stringify({ purpose: "device" }) });
	const pairing = await json(pairingResponse);
	if (!pairingResponse.ok || typeof pairing?.pairingCode !== "string") throw new Error(`pairing failed ${pairingResponse.status}`);
	const enrolled = await enroll(context.host, pairing.pairingCode, `relay2-${name}`, context.vaultId);
	if (enrolled.vaultGeneration !== context.vaultGeneration) throw new Error("vault generation mismatch");
	context.devices[name] = enrolled.identity;
	saveContext(context);
	return enrolled.identity;
}

export async function device(context: Context, name: string): Promise<LiveIdentity> {
	return context.devices[name] ?? await addDevice(context, name);
}

export async function refreshOperatorCookie(context: Context): Promise<string> {
	context.operatorCookie = await operatorLogin(context.host, context.operatorRecoveryKey);
	saveContext(context);
	return context.operatorCookie;
}

export interface SeedInput { bodyId: string; path: string; content: string }

/** Seed notes the production way (real VaultSync.commitFreshBodies over HTTP). */
export async function seedNotes(context: Context, inputs: readonly SeedInput[], batchBytes = 4 * 1024 * 1024) {
	const session = new ProductionImportSession(context.devices.A!, context.vaultGeneration);
	try {
		let batch: SeedInput[] = [];
		let bytes = 0;
		let done = 0;
		const flush = async () => {
			if (batch.length === 0) return;
			await session.commitFreshBodies(batch.map((input) => ({ ...input,
				candidateId: `candidate-relay2-${crypto.randomUUID()}`, reason: "relay2-seed" })));
			done += batch.length;
			log(`seeded ${done}/${inputs.length}`);
			batch = []; bytes = 0;
		};
		for (const input of inputs) {
			if (batch.length >= 32 || (batch.length > 0 && bytes + input.content.length > batchBytes)) await flush();
			batch.push(input); bytes += input.content.length;
		}
		await flush();
		return { requests: session.requests.length };
	} finally { await session.destroy(); }
}

/**
 * Create a body whose server state is exactly `update` (lifecycle admission → candidate → root publish).
 * Used for the frozen trace base (v1 createBodyFromUpdate).
 */
export async function createBodyFromUpdate(identity: LiveIdentity, id: string, path: string, update: Uint8Array) {
	const candidateId = `candidate-create-${crypto.randomUUID()}`;
	const candidateDigest = await sha256Hex(update);
	const lifecycle: LifecycleRequest = { operationId: `create-${crypto.randomUUID()}`, kind: "create", fileId: id, bodyId: id,
		bodyEpoch: 1, path, candidateId, candidateDigest };
	const admitted = await requestJson(identity, "lifecycle", { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify(lifecycle) });
	if (admitted.response.status !== 200) throw new Error(`admission failed ${admitted.response.status} ${JSON.stringify(admitted.body)}`);
	const candidate = await fetch(vaultRoute(identity, `body/${encodeURIComponent(id)}/candidate`), { method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/octet-stream", "x-yaos-candidate-id": candidateId,
			"x-yaos-candidate-digest": candidateDigest, "x-yaos-body-epoch": "1" }), body: update });
	if (candidate.status !== 200) throw new Error(`candidate failed ${candidate.status} ${await candidate.text()}`);
	await mutateLifecycle(identity, lifecycle);
}

// ---------------------------------------------------------------- deterministic content
export function smallId(i: number) { return `r2-small-${String(i).padStart(3, "0")}`; }
export function smallContent(i: number, bytes = 4096) {
	const prefix = `body-${i}\n`;
	return prefix + String.fromCharCode(97 + (i % 26)).repeat(Math.max(0, bytes - prefix.length));
}
export function wordsContent(seed: number, bytes: number) {
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
	const parts: string[] = [`# note ${seed}\n`];
	let length = parts[0]!.length;
	let k = seed + 1;
	while (length < bytes) {
		const w = `${words[k % 8]} ${k % 10000} `;
		parts.push(w); length += w.length;
		k = (k * 1103515245 + 12345) % 2147483647;
		if (k % 11 === 0) { parts.push("\n"); length++; }
	}
	return parts.join("").slice(0, bytes);
}
