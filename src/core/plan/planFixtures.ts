/** Test fixtures for planner tests (pure; not imported by production code). */

import type {
	BodyVersion, ContentHash, DiskFingerprint, DocId, LocalEntry, PathKey, PlannerInput, RemoteEntry, StreamName, SyncedEntry,
} from "../types";
import { kindOfPath } from "../types";
import { DEFAULT_BRAKE } from "./brake";
import { standInPathKey } from "./pathRules";

export const pk = standInPathKey;
export const h = (s: string): ContentHash => `h-${s}` as ContentHash;
export const fp = (s: string): DiskFingerprint => `f-${s}` as DiskFingerprint;
export const id = (s: string): DocId => s as DocId;
export const V = (remoteSeq: number, localOrder = 0): BodyVersion => ({ remoteSeq, localOrder });

export function R(docId: string, path: string, over: Partial<RemoteEntry> = {}): RemoteEntry {
	const kind = over.kind ?? kindOfPath(path);
	return {
		docId: id(docId), kind, path, pathKey: pk(path), state: "live", lastTouchSeq: 5, deletedSeq: 0, deleteBaseBodySeq: 0,
		createHash: h("create"),
		blob: kind === "blob" ? { hash: h("b0"), size: 10_000, rev: 50 } : null,
		aliasOf: null, pendingLocal: false,
		body: kind === "blob" ? null : { stream: `b:${docId}` as StreamName, version: V(10), caughtUp: true, hasContent: true, frozen: false },
		...over,
	};
}

export function S(docId: string, path: string, over: Partial<SyncedEntry> = {}): SyncedEntry {
	const kind = over.kind ?? kindOfPath(path);
	return {
		docId: id(docId), path, pathKey: pk(path), kind,
		contentHash: kind === "blob" ? h("b0") : h("c0"), fingerprint: fp("c0"), size: 10_000, mtimeMs: 1000,
		bodyVersion: kind === "blob" ? null : V(10), blobRev: kind === "blob" ? 50 : 0, nsTouchSeq: 5, hasBase: kind !== "blob",
		...over,
	};
}

export function L(path: string, hash: ContentHash | null, over: Partial<LocalEntry> = {}): LocalEntry {
	return {
		diskPath: path, path, pathKey: pk(path), kind: kindOfPath(path), size: 10_000, mtimeMs: 1000,
		hash, fingerprint: hash === null ? null : fp(String(hash).slice(2)), hashedAtMs: 100_000, excluded: false, bound: false,
		...over,
	};
}

export interface Scenario {
	remote?: RemoteEntry[];
	synced?: SyncedEntry[];
	local?: LocalEntry[];
	over?: Partial<PlannerInput>;
}

export function input(sc: Scenario): PlannerInput {
	const remote = new Map<DocId, RemoteEntry>();
	const byKey = new Map<PathKey, DocId>();
	for (const r of sc.remote ?? []) {
		remote.set(r.docId, r);
		if (r.state === "live") byKey.set(r.pathKey, r.docId);
	}
	return {
		scope: { t: "full" },
		remote,
		remoteByPathKey: byKey,
		local: new Map((sc.local ?? []).map((l) => [l.pathKey, l])),
		localComplete: true,
		synced: new Map((sc.synced ?? []).map((s) => [s.docId, s])),
		renames: [],
		docsWithPendingBody: new Set(),
		nsCoversSeq: 100,
		brake: DEFAULT_BRAKE,
		brakeApproval: null,
		freshDocIds: ["fresh1", "fresh2", "fresh3", "fresh4"].map(id),
		deviceLabel: "B",
		nowMs: 1_791_209_520_000, // 2026-10-05 14:12 UTC
		...sc.over,
	};
}
