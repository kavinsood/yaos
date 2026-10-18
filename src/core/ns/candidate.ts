/**
 * Checkpoint candidate seqs (DESIGN §b.5, §d.9). A row s is a candidate iff
 * floor(s / 1000) > floor(prev / 1000), prev being the fold's coversSeq
 * before s. Every device that folds s decides the same way, and ns / cfg /
 * snap checkpoints are written only at candidates (foldRuntime.ts).
 */

import type { Seq } from "../types";

export const NS_CANDIDATE_INTERVAL = 1000;

export function isCandidateSeq(prevCoversSeq: Seq, s: Seq): boolean {
	return Math.floor(s / NS_CANDIDATE_INTERVAL) > Math.floor(prevCoversSeq / NS_CANDIDATE_INTERVAL);
}
