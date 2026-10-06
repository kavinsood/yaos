/**
 * Seal/open relay payloads through the CryptoPort (DESIGN §b.1, §d.6 stage 1,
 * e2ee-design §7, §9.2). Codec: core/codec/envelope.ts. The engine stores
 * flags without the deflate bit (content is kept inflated), so the open
 * result clears it.
 */

import { EnvelopeFlag, type EnvelopeBinding, type EnvelopeKind, type EnvelopeOpenFailure, type EnvelopeOpenResult } from "../../core/envelope";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultId } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import { openEnvelope as openCore, sealEnvelope, type SealedEnvelope } from "../../core/codec/envelope";

export interface FrameToSeal {
	readonly stream: StreamName;
	/** The sealing device (AAD-bound, e2ee-design §7.2). T_adopt seals under the adopter's own id. */
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly kind: EnvelopeKind;
	readonly authorNsSeq: Seq;
	readonly flags: number;
	/** ≥ 1 for nsOps/cfgOps (e2ee-design §8.2), 0 otherwise. */
	readonly frameNo: number;
	readonly content: Uint8Array;
}

export function sealFrame(crypto: CryptoPort, vaultId: VaultId, f: FrameToSeal): Promise<SealedEnvelope> {
	return sealEnvelope(crypto, {
		vaultId,
		binding: { t: "frame", stream: f.stream, deviceId: f.deviceId, clientFrameId: f.clientFrameId },
		inner: { kind: f.kind, authorNsSeq: f.authorNsSeq, flags: f.flags, frameNo: f.frameNo, content: f.content },
	});
}

export async function sealCheckpoint(crypto: CryptoPort, vaultId: VaultId, stream: StreamName, coversSeq: Seq, content: Uint8Array, authorNsSeq: Seq): Promise<Uint8Array> {
	const s = await sealEnvelope(crypto, {
		vaultId,
		binding: { t: "checkpoint", stream, coversSeq },
		inner: { kind: "checkpoint", authorNsSeq, flags: 0, frameNo: 0, content },
	});
	return s.sealed;
}

/**
 * Stage 1: header, CryptoPort.open with the binding AAD, unpad, inner decode,
 * kind check. The returned inner content is inflated (deflate bit cleared).
 */
export async function openEnvelope(crypto: CryptoPort, vaultId: VaultId, binding: EnvelopeBinding, payload: Uint8Array): Promise<EnvelopeOpenResult> {
	const r = await openCore(crypto, { vaultId, binding, bytes: payload });
	return r.ok ? { ...r, inner: { ...r.inner, flags: r.inner.flags & ~EnvelopeFlag.deflate } } : r;
}

/**
 * Reader-dependent failures (DESIGN §d.6, e2ee-design §9.2) halt ns/cfg folds
 * and quarantine bodies until an upgrade or new keys; every other failure is
 * deterministic (fold as empty). `keyVerified`: the kcv of the header's key
 * epoch matched (CryptoPort.keyState), so a bad tag is the sender's fault.
 */
export function isReaderDependent(reason: EnvelopeOpenFailure, keyVerified: boolean): boolean {
	switch (reason) {
		case "unsupported-version":
		case "unsupported-suite":
		case "unknown-key":
			return true;
		case "auth-failed":
			return !keyVerified;
		case "malformed":
		case "suite-downgrade":
		case "bad-padding":
		case "kind-stream-mismatch":
			return false;
	}
}
