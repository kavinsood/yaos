/**
 * "Create a new vault": the creation path of e2ee-design §15.1, the only flow that may choose a vault's encryption.
 * Pure (no obsidian runtime): createVaultModal.ts drives it, and e2e/client/e2ee.ts runs it against a real relay.
 *
 *   step 1  this device makes the vault-creating call itself and reads the vaultId from the response:
 *           unclaimed server: POST /claim; claimed: /operator/login, /operator/vaults, its owner code, logout.
 *           Right after the response, main writes `creating: {vaultId}` (YaosUiHost.markCreating).
 *   step 2  it enrolls with the code from step 1, which must name that vaultId. The code stays in memory: it is not
 *           displayed, put in a link, logged or persisted (no pendingEnrollment).
 *   step 3  after enrolling, the engine reads VAULT_READY.head = 0 and an empty `k` on this session and says so
 *           (status.e2ee.creatable). Only then may the user choose "End-to-end encryption: On" (preselected) or the
 *           opt-out (decision D2). A failed check ends the flow with NOT_EMPTY_MESSAGE: the marker goes, no pin is
 *           set, and the device stays unpinned and blocked (§12.4).
 *
 * Nothing else reaches this module: not the protocol handler, parseSetupLink, a typed or scanned code, the console's
 * QR or link, a claim response's obsidianUrl or resumePendingEnrollment (createVault.test.ts scans for it). The
 * engine checks `k` itself again when enableE2ee or pinSuite0 "create" arrives (keyReader.ts), and main refuses both
 * without the marker (src/host/keys/pin.ts), so the UI cannot pin from anywhere else either.
 *
 * SECRETS: the operator recovery key (held only for step 1, never stored), the operator session, the owner code, the
 * new device token and the recovery key. None appears in an error, progress text or log.
 */

import type { StatusSnapshot } from "../../protocol/status";
import { pinnedSuite } from "../keys/pin";
import { sameIdentity, type PairedIdentity, type YaosPluginData, type YaosUiHost } from "./api";
import { keyCommandMessage, NOT_EMPTY_MESSAGE } from "./e2eeText";
import { waitFor, type WaitOptions } from "./hostWait";
import { applyPairedIdentity } from "./pairFlow";
import {
	claimServer, fetchCapabilities, normalizeHost, operatorCreateVault, operatorLogin, operatorLogout, pairingCodeVaultId,
	PairingError, prepareEnrollment, runEnrollment, type CreatedVault, type PairingDeps,
} from "./pairing";

export { NOT_EMPTY_MESSAGE } from "./e2eeText";
export type { WaitOptions } from "./hostWait";

export type CreateVaultHost = Pick<YaosUiHost, "data" | "updateData" | "status" | "onChange" | "command" | "markCreating" | "abandonCreating">;

export type CreateVaultErrorCode =
	/** A step-3 check failed (or the engine refused the choice for that reason): marker dropped, no pin. */
	| "not-empty"
	/** Step 3 did not finish in time (offline, still reading): the marker stays, so the flow can resume. */
	| "unconfirmed"
	/** The device left the new vault, got a pin, or lost its marker meanwhile: nothing more to do here. */
	| "stopped";

export class CreateVaultError extends Error {
	constructor(message: string, readonly code: CreateVaultErrorCode) {
		super(message);
		this.name = "CreateVaultError";
	}
}

export interface ProbedServer {
	/** The normalized origin. */
	readonly host: string;
	readonly claimed: boolean;
}

/** Step 0: is there a streams relay at `host`, and is it claimed? An unclaimed server is fine here (only here). */
export async function probeServer(host: string, deps: PairingDeps): Promise<ProbedServer> {
	const origin = normalizeHost(host);
	const caps = await fetchCapabilities(origin, deps, { allowUnclaimed: true });
	return { host: origin, claimed: caps.claimed };
}

export interface CreateVaultInput {
	readonly server: ProbedServer;
	/** SECRET: generated on main for an unclaimed server (generateOperatorKey), typed in for a claimed one. */
	readonly operatorKey: string;
	/** Claimed servers only; a claim names its first vault itself. */
	readonly vaultName: string;
	readonly deviceName: string;
}

export interface EnrolledInNewVault {
	readonly vaultId: string;
	/** The identity the new one replaced, to retire on its server (as PairModal does), or null. */
	readonly replaced: PairedIdentity | null;
}

/** Step 1: the vault-creating call(s). The operator session, if any, is ended before this returns. */
async function createOnServer(input: CreateVaultInput, deps: PairingDeps): Promise<CreatedVault> {
	const { server } = input;
	if (!server.claimed) {
		deps.onProgress?.("Setting up the server…");
		const { vault, session } = await claimServer(server.host, input.operatorKey, deps);
		if (session) await operatorLogout(session, deps);
		return vault;
	}
	deps.onProgress?.("Logging in to the server…");
	const session = await operatorLogin(server.host, input.operatorKey, deps);
	try {
		deps.onProgress?.("Creating the vault…");
		return await operatorCreateVault(session, input.vaultName, deps);
	} finally {
		await operatorLogout(session, deps);
	}
}

/**
 * Steps 1 and 2. On success the device is enrolled in the new vault, its identity is stored and the engine restarts
 * on the creation path; step 3 is confirmEmptyVault. Before the identity is stored, any failure drops the marker
 * (the owner code was in memory only, so nothing can resume) and leaves this device as it was.
 */
export async function createAndEnroll(input: CreateVaultInput, host: CreateVaultHost, deps: PairingDeps): Promise<EnrolledInNewVault> {
	const created = await createOnServer(input, deps);
	const vaultId = created.vaultId;
	await host.markCreating(vaultId);
	let stored = false;
	try {
		// D3: the code names its vault; one for another vault would enroll this device in a vault it did not create.
		if (pairingCodeVaultId(created.pairingCode) !== vaultId) {
			throw new PairingError("The server returned a pairing code for a different vault than the one it created.", "create_response_invalid", 200);
		}
		const attempt = prepareEnrollment({ host: created.host, pairingCode: created.pairingCode, deviceName: input.deviceName }, deps.randomBytes);
		const identity = await runEnrollment(attempt, deps);
		if (identity.vaultId !== vaultId) {
			throw new PairingError("The server enrolled this device in a different vault than the one it created. Nothing was changed on this device.", "create_response_invalid", 200);
		}
		const previous = host.data().identity;
		await host.updateData((d) => applyPairedIdentity(d, identity));
		stored = true;
		return { vaultId, replaced: previous && !sameIdentity(previous, identity) ? previous : null };
	} finally {
		if (!stored) await host.abandonCreating(vaultId).catch(() => undefined);
	}
}

/** The vault an enrolled, unpinned device may still finish creating (§15.1 crash recovery: resume at step 3). */
export function resumableCreation(data: YaosPluginData): string | null {
	const vaultId = data.identity?.vaultId ?? null;
	return vaultId !== null && data.creating?.vaultId === vaultId && pinnedSuite(data.e2ee) === null ? vaultId : null;
}

export type CreationCheck = "creatable" | "wait" | "not-empty" | "stopped";

/**
 * Step 3, from what main and the engine report. `not-empty` is definitive: the engine read a key record, or the
 * relay's VAULT_READY head of this session is above 0. Anything short of `creatable` otherwise is `wait`.
 */
export function creationCheck(data: YaosPluginData, status: StatusSnapshot | null, vaultId: string): CreationCheck {
	if (resumableCreation(data) !== vaultId) return "stopped";
	if (data.e2ee?.suite === null) return "not-empty"; // keyringSeen is sticky (pin.ts): a k genesis was read
	const e2ee = status?.e2ee;
	if (!status || !e2ee) return "wait";
	if (e2ee.creatable) return "creatable";
	if (e2ee.keyringSeen) return "not-empty";
	if (status.relay.connected && status.headSeq > 0) return "not-empty";
	return "wait";
}

/** Resolves with the first non-`wait` check, or `wait` after the timeout (default 60 s). */
async function waitForCheck(host: CreateVaultHost, vaultId: string, opts: WaitOptions): Promise<CreationCheck> {
	const c = await waitFor(host, () => {
		const check = creationCheck(host.data(), host.status(), vaultId);
		return check === "wait" ? null : check;
	}, 60_000, opts);
	return c ?? "wait";
}

/** A failed step-3 check: the marker goes, no pin is set, the device stays blocked (§15.1). */
async function abort(host: CreateVaultHost, vaultId: string): Promise<never> {
	await host.abandonCreating(vaultId);
	throw new CreateVaultError(NOT_EMPTY_MESSAGE, "not-empty");
}

/**
 * Step 3: wait until the engine reports the new vault creatable (head 0, empty `k`, read on this session). Rejects
 * with CreateVaultError: `not-empty` (aborted), `unconfirmed` (timed out; the marker stays) or `stopped`.
 */
export async function confirmEmptyVault(host: CreateVaultHost, vaultId: string, opts: WaitOptions = {}): Promise<void> {
	const c = await waitForCheck(host, vaultId, opts);
	if (c === "creatable") return;
	if (c === "not-empty") return abort(host, vaultId);
	if (c === "stopped") throw new CreateVaultError("This device is no longer on the creation path of that vault.", "stopped");
	throw new CreateVaultError(
		"YAOS could not yet confirm that the new vault is empty (it may be offline or still reading). Nothing was decided. Open YAOS settings and choose \"Finish creating this vault\" to try again.",
		"unconfirmed",
	);
}

/** A refused choice: definitive refusals and a failed re-check abort; anything else keeps the marker for a retry. */
async function choiceFailed(host: CreateVaultHost, vaultId: string, err: unknown): Promise<never> {
	const raw = err instanceof Error ? err.message : "";
	const check = creationCheck(host.data(), host.status(), vaultId);
	if (raw.startsWith("refused: another genesis won") || check === "not-empty") return abort(host, vaultId);
	if (check === "stopped") throw new CreateVaultError(keyCommandMessage(err), "stopped");
	throw new CreateVaultError(keyCommandMessage(err), "unconfirmed");
}

/**
 * The default choice (§15.1 enable steps 3-4): the engine appends the genesis under a fresh K_1, wrapped under `rk`;
 * main stores the keys, pins suite 1 and drops the marker. `rk` (35 bytes, shown and confirmed per §13.2) is
 * transferred and zero-filled.
 */
export async function enableEncryption(host: CreateVaultHost, vaultId: string, rk: Uint8Array): Promise<void> {
	if (creationCheck(host.data(), host.status(), vaultId) !== "creatable") {
		rk.fill(0);
		return choiceFailed(host, vaultId, new Error("refused: not on the creation path"));
	}
	try {
		await host.command({ t: "enableE2ee", rk });
	} catch (err) {
		return choiceFailed(host, vaultId, err);
	} finally {
		if (rk.byteLength > 0) rk.fill(0);
	}
}

/** The opt-out (decision D2): main pins suite 0 for this vault, for good. No `k` record is written. */
export async function optOutOfEncryption(host: CreateVaultHost, vaultId: string): Promise<void> {
	if (creationCheck(host.data(), host.status(), vaultId) !== "creatable") return choiceFailed(host, vaultId, new Error("refused: not on the creation path"));
	try {
		await host.command({ t: "pinSuite0", source: "create" });
	} catch (err) {
		return choiceFailed(host, vaultId, err);
	}
}
