import { getServerByName } from "partyserver";
import * as Y from "yjs";
import {
	createSnapshot,
	getSnapshotPayload,
	listSnapshots,
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

		const snapshots = await listSnapshots(vaultId, env.YAOS_BUCKET);
		return json({ snapshots });
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

	const update = await fetchVaultDocument(env, vaultId);
	const doc = new Y.Doc();
	if (update.byteLength > 0) {
		Y.applyUpdate(doc, update);
	}

	const index = await createSnapshot(doc, vaultId, env.YAOS_BUCKET, triggeredBy);
	return {
		status: "created",
		snapshotId: index.snapshotId,
		index,
	};
}
