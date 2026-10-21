/**
 * Winner selection (e2ee-design §11.3) as a fixpoint over epochs. Each pass either installs a key for a decided
 * epoch, decides an epoch (its first valid row in seq order), or marks a row invalid; any change restarts the
 * pass, so a key learnt late (QR, RK, a prevWrap further up) re-opens rows that were pending.
 *
 * How a row R for epoch e gets K_e:
 * - a held key: verified (decided), oob (QR), prev (a valid record's prevWrap) or own (generated here);
 * - roll: R.nextWrap under the winner(e − 1) key, unless a revoke for an epoch ≥ e exists (pending or valid);
 * - genesis / revoke: R.recoveryWrap with the RK in hand.
 * A blocked roll can still win through an authoritative key (oob or prev): that is how a device re-keyed above a
 * revoke walks the backward chain through the rolls before it. An own key never unblocks a roll.
 *
 * A pending genesis or revoke holds back the later rows of its epoch: it may be the first valid record, so nothing
 * later wins past it. A genesis has one creator (§15.1), and a second one would otherwise adopt its own K_1 and fork
 * the vault. A revoke can have several (kept devices re-keying at once, §14.2), each under a recovery key of its own
 * when it generated a new one: a device holding another RK cannot open the earlier record, cannot tell it from
 * garbage, and adopted its own later record or one its RK opens, while every other device followed the first (suite-1
 * seed 89423454: devices sealing under two different K_2, each side's rows failing auth on the other). The device
 * waits instead (key-missing, revoked-epoch) until an out-of-band key judges the row (§11.3: a hostile server's
 * garbage record is denial of service only; a QR key marks it invalid). Only an authoritative key passes over a
 * record, and it never finds one pending: it judges every record of its epoch. A pending roll holds nothing back
 * (revoke outranks roll; a roll for e is blocked while a revoke for e or above exists).
 */

import { bytesEqual } from "../../core/codec/lib0";
import type { CryptoPort, KeyringCrypto, WrapRole } from "../../ports/crypto";
import type { KeyBook, KeySource } from "./book";
import { KeyRecordKind, wrapAad, type KeyRecord } from "./record";

type Fields = Record<string, string | number | boolean | null>;

export interface EvalCtx {
	readonly kc: KeyringCrypto & Pick<CryptoPort, "keyState">;
	readonly vaultId: string;
	/** The RK, while the user's entry is in hand (§13.2). */
	readonly rk: Uint8Array | null;
	readonly diag: (code: string, fields: Fields) => void;
}

type Verdict = "valid" | "invalid" | "pending";

const AUTHORITATIVE: ReadonlySet<KeySource | undefined> = new Set(["verified", "oob", "prev"]);

export async function evaluate(b: KeyBook, x: EvalCtx): Promise<boolean> {
	let any = false;
	while ((await fillKeys(b, x)) || (await step(b, x))) any = true;
	return any;
}

/** One decision: the lowest undecided epoch whose rows change state. */
async function step(b: KeyBook, x: EvalCtx): Promise<boolean> {
	const open = b.rows.filter((r) => r.state === "pending" && !b.winners.has(r.rec!.e));
	for (const e of [...new Set(open.map((r) => r.rec!.e))].sort((p, q) => p - q)) {
		for (const row of open.filter((r) => r.rec!.e === e)) {
			const v = await tryRow(b, x, row.rec!);
			if (v === "pending") {
				// A stored open revoke (no `k` seq this vaultEpoch, book.ts addStoredOpen) only keeps the gate shut.
				if (row.rec!.kind !== KeyRecordKind.roll && row.seq !== null) break;
				continue;
			}
			if (v === "valid") {
				b.decide(e, row);
				x.kc.markVerified(e);
				x.diag("keyring/adopted", { e, kind: row.rec!.kind, seq: row.seq });
				return true;
			}
			row.state = "invalid";
			x.diag("keyring/invalid", { e, kind: row.rec!.kind, seq: row.seq });
			return true;
		}
	}
	return false;
}

const kcvOk = async (x: EvalCtx, e: number, want: Uint8Array): Promise<boolean> => bytesEqual(await x.kc.kcv(e), want);
const open = (x: EvalCtx, r: KeyRecord, role: WrapRole, wrapped: Uint8Array): Promise<boolean> =>
	x.kc.unwrap(role, r.e, wrapAad(x.vaultId, r, role), wrapped, role === "recovery" ? (x.rk ?? undefined) : undefined);

async function tryRow(b: KeyBook, x: EvalCtx, r: KeyRecord): Promise<Verdict> {
	const e = r.e;
	const roll = r.kind === KeyRecordKind.roll;
	const blocked = roll && b.blocksRoll(e);
	const alt = roll ? !blocked && b.source.get(e - 1) === "verified" && b.winners.has(e - 1) : x.rk !== null;
	let src = srcOf(b, x, e);
	let fresh = false;
	if (src !== undefined) {
		if (!(await kcvOk(x, e, r.kcv))) {
			if (AUTHORITATIVE.has(src)) {
				if (src === "oob") x.diag("keyring/conflict", { e });
				return "invalid";
			}
			if (!alt) return "pending"; // keep an own key while the row cannot be judged without it
			drop(b, x, e);
			src = undefined;
		} else if (blocked && src === "own") return "pending";
	}
	if (src === undefined) {
		if (!alt) return "pending";
		if (roll ? !(await open(x, r, "next", r.nextWrap)) : !(await open(x, r, "recovery", r.recoveryWrap))) {
			return roll ? "invalid" : "pending"; // a wrong or older RK cannot be told from a forged recoveryWrap
		}
		fresh = true;
		if (!(await kcvOk(x, e, r.kcv))) {
			drop(b, x, e);
			if (!roll) x.diag("keyring/conflict", { e });
			return "invalid";
		}
	}
	if (r.kind === KeyRecordKind.genesis) return "valid";
	if (await prevOpens(b, x, r)) return "valid";
	if (fresh) drop(b, x, e);
	return "invalid";
}

/**
 * prevWrap must open to the key held for e − 1, or install it when none is held; an installed key must match
 * the winner for e − 1 if there is one (§11.3). An own key that differs yields.
 */
async function prevOpens(b: KeyBook, x: EvalCtx, r: KeyRecord): Promise<boolean> {
	const p = r.e - 1;
	const had = srcOf(b, x, p);
	let ok = await open(x, r, "prev", r.prevWrap);
	if (!ok && had === "own") {
		drop(b, x, p);
		ok = await open(x, r, "prev", r.prevWrap);
	}
	if (!ok) return false;
	if (had !== undefined && had !== "own") return true;
	const w = b.winners.get(p);
	if (!w) {
		b.source.set(p, "prev");
		return true;
	}
	if (await kcvOk(x, p, w.row.rec!.kcv)) return verify(b, x, p);
	drop(b, x, p);
	return false;
}

/** A key the adapter holds that the book does not know (a host key without a stored record) counts as own. */
function srcOf(b: KeyBook, x: EvalCtx, e: number): KeySource | undefined {
	const s = b.source.get(e);
	if (s !== undefined || e < 1 || !x.kc.keyState(e).held) return s;
	b.source.set(e, "own");
	return "own";
}

function drop(b: KeyBook, x: EvalCtx, e: number): void {
	x.kc.drop(e);
	b.source.delete(e);
}

/** Keys for decided epochs: check a held key against the winner, else reach it down or up the chain (§11.1). */
async function fillKeys(b: KeyBook, x: EvalCtx): Promise<boolean> {
	for (const e of [...b.winners.keys()].sort((p, q) => q - p)) {
		const src = srcOf(b, x, e);
		if (src === "verified") continue;
		const r = b.winners.get(e)!.row.rec!;
		if (src !== undefined) {
			if (await kcvOk(x, e, r.kcv)) return verify(b, x, e);
			if (src === "oob") x.diag("keyring/conflict", { e });
			drop(b, x, e);
			return true;
		}
		const tries: (() => Promise<boolean>)[] = [];
		const up = b.winners.get(e + 1)?.row.rec;
		if (up && up.kind !== KeyRecordKind.genesis && b.source.get(e + 1) === "verified") tries.push(() => open(x, up, "prev", up.prevWrap));
		if (r.kind === KeyRecordKind.roll && b.source.get(e - 1) === "verified") tries.push(() => open(x, r, "next", r.nextWrap));
		if (r.kind !== KeyRecordKind.roll && x.rk) tries.push(() => open(x, r, "recovery", r.recoveryWrap));
		for (const t of tries) {
			if (!(await t())) continue;
			if (await kcvOk(x, e, r.kcv)) return verify(b, x, e);
			x.kc.drop(e);
		}
	}
	// An undecided epoch right below a verified non-genesis winner: that winner's prevWrap holds its key, as
	// prevOpens installs it. The "prev" label lives in this book only, so a Keyring opened again on the adapter (or
	// after a restart) reaches the key from the records here rather than take a held key for an own one, which never
	// unblocks a roll: the roll stayed pending and the keys below it, K_1 included, out of reach (suite-1 seeds 74, 184).
	const undecided = new Set<number>();
	for (const row of b.rows) if (row.state === "pending" && row.rec && !b.winners.has(row.rec.e)) undecided.add(row.rec.e);
	for (const e of [...undecided].sort((p, q) => q - p)) {
		if (AUTHORITATIVE.has(b.source.get(e))) continue;
		const up = b.winners.get(e + 1)?.row.rec;
		if (!up || up.kind === KeyRecordKind.genesis || b.source.get(e + 1) !== "verified") continue;
		const had = srcOf(b, x, e);
		let ok = await open(x, up, "prev", up.prevWrap);
		if (!ok && had === "own") {
			drop(b, x, e);
			ok = await open(x, up, "prev", up.prevWrap);
		}
		if (!ok) continue;
		b.source.set(e, "prev");
		return true;
	}
	return false;
}

function verify(b: KeyBook, x: EvalCtx, e: number): true {
	x.kc.markVerified(e);
	b.source.set(e, "verified");
	return true;
}

