import { getServerByName } from "partyserver";
import * as Y from "yjs";
import {
	createSnapshot,
	getSnapshotPayload,
	listSnapshots,
	applyRetention,
	getLatestSnapshotIndex,
	type SnapshotResult,
} from "../snapshot";
import type { Env, JsonResponse } from "./types";

interface SnapshotRouteOptions {
	recordVaultTrace(
		env: Env,
		vaultId: string,
		event: string,
		data?: Record<string, unknown>,
	): Promise<void>;
	fetchVaultDocument(env: Env, vaultId: string): Promise<Uint8Array>;
}

export async function handleSnapshotRoute(
	env: Env,
	vaultId: string,
	req: Request,
	rest: string[],
	json: JsonResponse,
	options: SnapshotRouteOptions,
): Promise<Response> {
	if (req.method === "POST" && rest.length === 0) {
		let body: { device?: string } = {};
		try {
			body = await req.json();
		} catch {
			body = {};
		}

		const result = await createSnapshotFromLiveDoc(
			env,
			vaultId,
			body.device,
			(targetEnv, targetVaultId) => options.fetchVaultDocument(targetEnv, targetVaultId),
		);
		if (result.status === "unavailable") {
			return json(result);
		}
		await options.recordVaultTrace(env, vaultId, "snapshot-created-manual", {
			snapshotId: result.snapshotId,
			triggeredBy: body.device,
		});
		return json(result);
	}

	if (req.method === "POST" && rest[0] === "maybe" && rest.length === 1) {
		let body: { device?: string } = {};
		try {
			body = await req.json();
		} catch {
			body = {};
		}

		const stub = await getServerByName(env.YAOS_SYNC, vaultId);
		const res = await stub.fetch("https://internal/__yaos/snapshot-maybe", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const result: SnapshotResult = await res.json();
		await options.recordVaultTrace(env, vaultId, "snapshot-created", {
			status: result.status,
			snapshotId: result.snapshotId,
			triggeredBy: body.device,
		});
		return json(result);
	}

	if (req.method === "GET" && rest.length === 0) {
		if (!env.YAOS_BUCKET) {
			return json({ error: "snapshots_unavailable" }, 503);
		}

		const url = new URL(req.url);
		const limitParam = url.searchParams.get("limit");
		const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200) : 50;
		const format = url.searchParams.get("format");

		const { snapshots, totalIndexKeys, limited } = await listSnapshots(vaultId, env.YAOS_BUCKET, limit);

		// Legacy compatibility: default response is { snapshots: [...] }
		// which old clients destructure as `result.snapshots`.
		// New clients can request ?format=v2 for richer metadata.
		if (format === "v2") {
			return json({
				snapshots,
				totalIndexKeys,
				fetchedCount: snapshots.length,
				limited,
			});
		}

		// Default: legacy-compatible shape (old clients expect { snapshots })
		return json({ snapshots });
	}

	if (req.method === "GET" && rest.length === 1 && rest[0] === "status") {
		if (!env.YAOS_BUCKET) {
			return json({ error: "snapshots_unavailable" }, 503);
		}

		const latest = await getLatestSnapshotIndex(vaultId, env.YAOS_BUCKET);
		// Use a high limit but be honest that it's a lower bound.
		const { snapshots: all, totalIndexKeys, limited } = await listSnapshots(vaultId, env.YAOS_BUCKET, 200);
		const fetchedBytes = all.reduce((sum, s) => sum + s.crdtSizeBytes, 0);

		const pinnedCount = all.filter((s) => s.pinned).length;

		return json({
			// New honest fields (prefer these in new clients)
			snapshotCountLowerBound: totalIndexKeys,
			listedSnapshotCount: all.length,
			listingLimited: limited,
			estimatedStorageBytesLowerBound: fetchedBytes,
			pinnedCountLowerBound: pinnedCount,
			// Legacy aliases (kept for old clients — same values, less honest names)
			snapshotCount: totalIndexKeys,
			estimatedStorageBytes: fetchedBytes,
			pinnedCount,
			// Common fields
			latestSnapshotId: latest?.snapshotId ?? null,
			latestCreatedAt: latest?.createdAt ?? null,
		});
	}

	if (req.method === "POST" && rest.length === 1 && rest[0] === "prune") {
		if (!env.YAOS_BUCKET) {
			return json({ error: "snapshots_unavailable" }, 503);
		}

		let body: { pruneLegacy?: boolean; confirmLegacyPrune?: string } = {};
		try {
			body = await req.json();
		} catch {
			body = {};
		}

		// Safety latch: pruneLegacy requires explicit confirmation string.
		// Legacy snapshots have unknown origin — deleting them is destructive
		// and irreversible. Make it ugly on purpose.
		const pruneLegacy = body.pruneLegacy === true &&
			body.confirmLegacyPrune === "DELETE_LEGACY_SNAPSHOTS";

		if (body.pruneLegacy === true && !pruneLegacy) {
			return json({
				error: "pruneLegacy requires confirmLegacyPrune: 'DELETE_LEGACY_SNAPSHOTS'",
			}, 400);
		}

		const result = await applyRetention(vaultId, env.YAOS_BUCKET, undefined, {
			pruneLegacy,
		});
		await options.recordVaultTrace(env, vaultId, "snapshot-retention-applied", {
			kept: result.kept,
			pruned: result.pruned,
			failed: result.failed,
			pruneLegacy: body.pruneLegacy === true,
			errors: result.errors.slice(0, 10),
		});
		return json({ kept: result.kept, pruned: result.pruned, failed: result.failed });
	}

	if (req.method === "GET" && rest.length === 1) {
		if (!env.YAOS_BUCKET) {
			return json({ error: "snapshots_unavailable" }, 503);
		}

		const snapshotId = rest[0];
		if (!snapshotId) {
			return json({ error: "missing_snapshot_id" }, 400);
		}
		const result = await getSnapshotPayload(
			vaultId,
			snapshotId,
			env.YAOS_BUCKET,
		);
		if (!result) {
			return json({ error: "not found" }, 404);
		}

		return new Response(result.payload, {
			headers: {
				"Content-Type": "application/gzip",
				"Cache-Control": "no-store",
				"X-YAOS-Snapshot-Day": result.index.day,
			},
		});
	}

	return json({ error: "not found" }, 404);
}

async function createSnapshotFromLiveDoc(
	env: Env,
	vaultId: string,
	triggeredBy: string | undefined,
	fetchVaultDocument: (env: Env, vaultId: string) => Promise<Uint8Array>,
): Promise<SnapshotResult> {
	if (!env.YAOS_BUCKET) {
		return {
			status: "unavailable",
			reason: "R2 bucket not configured",
		};
	}

	const previous = await getLatestSnapshotIndex(vaultId, env.YAOS_BUCKET);

	const update = await fetchVaultDocument(env, vaultId);
	const doc = new Y.Doc();
	if (update.byteLength > 0) {
		Y.applyUpdate(doc, update);
	}

	const index = await createSnapshot(doc, vaultId, env.YAOS_BUCKET, {
		triggeredBy,
		reason: "manual",
		pinned: true,
	});

	// Use fullUpdateHash for the "identical" check. This is meaningful:
	// it means the entire CRDT state (including content and delete set) is
	// byte-for-byte identical to the latest snapshot. Only then do we say
	// "snapshot identical to latest."
	const snapshotIdenticalToLatest = !!(
		previous?.fullUpdateHash &&
		index.fullUpdateHash &&
		previous.fullUpdateHash === index.fullUpdateHash
	);

	return {
		status: "created",
		snapshotId: index.snapshotId,
		index,
		snapshotIdenticalToLatest,
		// Legacy alias for old clients that check this field
		semanticUnchanged: snapshotIdenticalToLatest,
	};
}
