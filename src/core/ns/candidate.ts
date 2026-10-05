/**
 * V3 (DESIGN §b.5): digests of the canonical ns fold at candidate seqs.
 * A row s is a candidate iff floor(s / 1000) > floor(prev / 1000), prev being
 * the fold's coversSeq before s. Each device keeps the newest 16
 * (seq, sha256(nsFoldV1)) pairs; checkpoints are written only at candidates.
 */

import type { NsFoldState, Seq } from "../types";
import type { HashPort } from "../../ports/crypto";
import { bytesToHex } from "../codec/lib0";
import { encodeNsFoldV1 } from "../codec/nsFoldV1";

export const NS_CANDIDATE_INTERVAL = 1000;
export const NS_DIGEST_RING = 16;

export function isCandidateSeq(prevCoversSeq: Seq, s: Seq): boolean {
	return Math.floor(s / NS_CANDIDATE_INTERVAL) > Math.floor(prevCoversSeq / NS_CANDIDATE_INTERVAL);
}

export interface NsDigest {
	readonly seq: Seq;
	/** Lowercase hex sha256 of the uncompressed nsFoldV1 bytes. */
	readonly digest: string;
}

/** Ascending seq, at most NS_DIGEST_RING entries. */
export type NsDigestRing = readonly NsDigest[];

/** sha256 hex of the canonical fold bytes (also what streams["ns"].textHash holds for the newest candidate). */
export async function nsFoldDigest(state: NsFoldState, hash: Pick<HashPort, "sha256">): Promise<string> {
	return bytesToHex(await hash.sha256(encodeNsFoldV1(state)));
}

/** Returns a new ring with (seq, digest) recorded (replacing an equal seq), trimmed to the newest 16. */
export function recordDigest(ring: NsDigestRing, seq: Seq, digest: string): NsDigestRing {
	const next = ring.filter((d) => d.seq !== seq);
	next.push({ seq, digest });
	next.sort((a, b) => a.seq - b.seq);
	return next.length > NS_DIGEST_RING ? next.slice(-NS_DIGEST_RING) : next;
}

export function checkDigest(ring: NsDigestRing, seq: Seq, digest: string): "match" | "mismatch" | "unknown" {
	const d = ring.find((x) => x.seq === seq);
	if (!d) return "unknown";
	return d.digest === digest ? "match" : "mismatch";
}
