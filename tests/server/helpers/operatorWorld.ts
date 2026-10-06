// The operator-side world shared by the P2/P3 operator suites (operator.ts, reset.ts, restore.ts, blobs.ts): the real
// Router, the real config host behind a recording namespace, vault hosts on Node SQLite, an in-memory R2 bucket and
// helpers for claim, enroll, owner codes and the §6.2 row counts.
import assert from "node:assert/strict";

import { Router, type WorkerEnv } from "../../../server/src/router";
import {
	FakeBucket,
	RecordingUpgrades,
	VaultCluster,
	bearer,
	recordingConfigNamespace,
	type ConfigObject,
	type DeviceSeed,
	type VaultObject,
} from "./workerHarness.ts";

export const ORIGIN = "https://yaos.test";
export const RECOVERY_KEY = `recovery-${"k".repeat(40)}`;
export const COOKIE_PATTERN = /^yaos_op=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/;

export interface World {
	cluster: VaultCluster;
	config: ConfigObject;
	accesses: string[];
	env: WorkerEnv;
	bucket: FakeBucket;
	router: Router;
	fetch(path: string, init?: RequestInit & { cookie?: string; origin?: string | null; json?: unknown }): Promise<Response>;
}

export interface WorldOptions {
	/** A fake PITR on every vault object (D8b). */
	pitr?: boolean;
	/** Bind `YAOS_BUCKET` (default true). */
	bucket?: boolean;
	debugRoutes?: boolean;
}

export async function withWorld(check: (world: World) => Promise<void>, options: WorldOptions = {}): Promise<void> {
	const cluster = new VaultCluster({ pitr: options.pitr === true });
	try {
		const config = cluster.config();
		const recording = recordingConfigNamespace(config);
		const bucket = new FakeBucket();
		const env = { YAOS_VAULT: cluster.namespace(), YAOS_CONFIG: recording.namespace,
			...(options.bucket === false ? {} : { YAOS_BUCKET: bucket.asR2() }),
			...(options.debugRoutes ? { YAOS_DEBUG_ROUTES: "1" } : {}) } as WorkerEnv;
		const world: World = {
			cluster, config, accesses: recording.accesses, env, bucket,
			router: new Router({ upgrades: new RecordingUpgrades() }),
			fetch(path, init = {}) {
				const { cookie, origin = ORIGIN, json: body, ...rest } = init;
				const headers = new Headers(rest.headers);
				if (origin !== null && (rest.method ?? "GET") !== "GET") headers.set("Origin", origin);
				if (cookie) headers.set("Cookie", `yaos_op=${cookie}`);
				if (body !== undefined) headers.set("Content-Type", "application/json");
				return world.router.fetch(new Request(`${ORIGIN}${path}`,
					{ ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
			},
		};
		await check(world);
	} finally {
		cluster.close();
	}
}

export async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

export function sessionOf(response: Response): string {
	const match = COOKIE_PATTERN.exec(response.headers.get("Set-Cookie") ?? "");
	assert.ok(match, "a D5 session cookie");
	return match[1]!;
}

export interface Claimed {
	cookie: string;
	vaultId: string;
	pairingCode: string;
	vault: VaultObject;
}

export async function claim(world: World): Promise<Claimed> {
	const response = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
	assert.equal(response.status, 200, "claim");
	const body = await json(response);
	const vaultId = body.vaultId as string;
	return { cookie: sessionOf(response), vaultId, pairingCode: body.pairingCode as string,
		vault: world.cluster.objects.get(vaultId)! };
}

export async function enrollVia(world: World, pairingCode: string, device: DeviceSeed): Promise<Record<string, unknown>> {
	const response = await world.fetch("/enroll", { method: "POST", origin: null, json: {
		pairingCode, enrollmentRequestId: `enroll-${device.deviceId}`, deviceId: device.deviceId,
		deviceToken: device.token, deviceName: device.deviceName } });
	assert.equal(response.status, 200, "enroll");
	return await json(response);
}

export async function ownerCode(world: World, cookie: string, vaultId: string, purpose?: string): Promise<Response> {
	return await world.fetch(`/operator/vaults/${vaultId}/owner-code`,
		{ method: "POST", cookie, json: purpose === undefined ? {} : { purpose } });
}

/** A device route through the Worker with the device's bearer. */
export function deviceFetch(world: World, vaultId: string, device: DeviceSeed, path: string, init: RequestInit = {}):
	Promise<Response> {
	const headers = new Headers(init.headers);
	for (const [name, value] of Object.entries(bearer(device))) headers.set(name, value);
	return world.router.fetch(new Request(`${ORIGIN}/vault/${vaultId}/${path}`, { ...init, headers }), world.env);
}

export function deviceFeed(world: World, vaultId: string, device: DeviceSeed): Promise<Response> {
	return deviceFetch(world, vaultId, device, "streams/feed");
}

export function rows(world: World, vault?: VaultObject): { config: number; vault?: number } {
	return { config: world.config.model.totals.cf, ...(vault ? { vault: vault.model.totals.cf } : {}) };
}

export function resetRows(world: World): void {
	world.config.model.reset();
	for (const object of world.cluster.objects.values()) object.model.reset();
}
