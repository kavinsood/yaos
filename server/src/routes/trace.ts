import { getServerByName } from "partyserver";
import * as Y from "yjs";
import type { Env } from "./types";

const LOG_PREFIX = "[yaos-sync:worker]";

export async function recordVaultTrace(
	env: Env,
	vaultId: string,
	event: string,
	data: Record<string, unknown> = {},
): Promise<void> {
	try {
		const stub = await getServerByName(env.YAOS_SYNC, vaultId);
		await stub.fetch("https://internal/__yaos/trace", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ event, data }),
		});
	} catch (err) {
		console.warn(`${LOG_PREFIX} trace write failed:`, err);
	}
}

export async function fetchVaultDocument(env: Env, vaultId: string): Promise<Uint8Array> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	const res = await stub.fetch("https://internal/__yaos/document");
	if (!res.ok) {
		throw new Error(`document fetch failed (${res.status})`);
	}
	return new Uint8Array(await res.arrayBuffer());
}

async function fetchVaultRoomMeta(env: Env, vaultId: string): Promise<{
	schemaVersion: number | null;
} | null> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	const res = await stub.fetch("https://internal/__yaos/meta");
	if (!res.ok) {
		throw new Error(`room meta fetch failed (${res.status})`);
	}
	const payload: {
		meta?: { schemaVersion?: unknown } | null;
	} = await res.json();
	const schemaVersion = payload?.meta?.schemaVersion;
	if (schemaVersion === null) {
		return { schemaVersion: null };
	}
	if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 0) {
		return { schemaVersion };
	}
	return null;
}

export async function fetchVaultSchemaVersion(env: Env, vaultId: string): Promise<number | null> {
	try {
		const meta = await fetchVaultRoomMeta(env, vaultId);
		if (meta) {
			return meta.schemaVersion;
		}
		const update = await fetchVaultDocument(env, vaultId);
		const doc = new Y.Doc();
		try {
			Y.applyUpdate(doc, update);
			const stored = doc.getMap("sys").get("schemaVersion");
			if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
				return stored;
			}
			return null;
		} finally {
			doc.destroy();
		}
	} catch (err) {
		console.warn(`${LOG_PREFIX} schema probe failed:`, err);
		return null;
	}
}

export async function fetchVaultDebug(env: Env, vaultId: string): Promise<Response> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	return await stub.fetch("https://internal/__yaos/debug");
}
