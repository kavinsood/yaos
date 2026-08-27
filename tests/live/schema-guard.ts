/**
 * Live-worker admission test for the pinned schema version.
 *
 * The server admits exactly one schema version (SERVER_MIN/MAX_SCHEMA_VERSION
 * in server/src/version.ts, equal to SCHEMA_VERSION in src/sync/schema.ts).
 * This suite proves, against a real Worker, that:
 *   - a client at the pinned version connects and syncs;
 *   - a client below the pin is rejected with update_required;
 *   - a client above the pin is rejected with update_required;
 *   - a client that declares no schema at all is rejected (no legacy default).
 *
 * The room-skew rejections (client_schema_older_than_room /
 * client_schema_newer_than_room) are deliberately not exercised here: the
 * envelope check runs before the room probe, so a room at any other version can
 * no longer be created by a client. That check is defense-in-depth for a room
 * left behind by a rolled-back server, and is covered by
 * tests/client/meta-v3-schema-gate-and-stats.ts.
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame, parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const ROOM_ID = identity.vaultId;

function wait(ms: number): Promise<void> {
	return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function buildWsUrl(
	roomId: string,
	{ includeSchema, schemaVersion }: { includeSchema: boolean; schemaVersion?: number },
): Promise<string> {
	const { ticket } = await fetchSocketTicket(identity, roomId);
	const url = new URL(`/vault/sync/${encodeURIComponent(roomId)}`, HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	if (includeSchema && schemaVersion !== undefined) {
		url.searchParams.set("schemaVersion", String(schemaVersion));
	}
	return url.toString();
}

async function safeDestroy(provider: YSyncProvider, ydoc: Y.Doc): Promise<void> {
	// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library.
	// Only the "ws" implementation can be terminated; when Node supplies a global
	// WebSocket the provider uses that one and there is nothing to force-close.
	const ws = provider.ws;
	if (ws instanceof WebSocket) {
		ws.terminate();
	}

	// Ensure Awareness interval is cleared (using public API).
	if (provider.awareness) {
		provider.awareness.destroy();
	}

	const capturedDuringTeardown = new Set<NodeJS.Timeout>();
	const originalSetTimeout = globalThis.setTimeout;
	const originalGlobalSetTimeout = global.setTimeout;
	// lib.dom and @types/node both declare setTimeout, so the global's type is
	// the union of their overloads: a replacement has to satisfy the
	// number-returning DOM signature as well as the Timeout-returning Node one,
	// and carry Node's util.promisify hook.
	function patchedSetTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): number;
	function patchedSetTimeout<TArgs extends unknown[]>(
		callback: (...cbArgs: TArgs) => void,
		ms?: number,
		...args: TArgs
	): NodeJS.Timeout;
	function patchedSetTimeout(
		callback: (...cbArgs: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	): NodeJS.Timeout | number {
		const handle = originalSetTimeout(callback, ms, ...args);
		if (ms !== undefined && ms > 0) {
			capturedDuringTeardown.add(handle);
		}
		return handle;
	}
	const patched = Object.assign(patchedSetTimeout, {
		__promisify__: originalSetTimeout.__promisify__,
	});
	globalThis.setTimeout = patched;
	global.setTimeout = patched;

	provider.destroy();
	if (ydoc) ydoc.destroy();

	// Give a few ticks for any post-close logic (like reconnect timers)
	await new Promise<void>((r) => originalSetTimeout(r, 100));

	globalThis.setTimeout = originalSetTimeout;
	global.setTimeout = originalGlobalSetTimeout;

	for (const h of capturedDuringTeardown) {
		clearTimeout(h);
	}
}

async function seedRoomSchema(roomId: string, schemaVersion: number): Promise<void> {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;
	const { ticket } = await fetchSocketTicket(identity, roomId);

	const provider = new YSyncProvider(HOST, roomId, ydoc, {
		prefix: syncPrefix,
		params: {
			ticket,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		let done = false;
		const timeout = setTimeout(() => {
			if (done) return;
			done = true;
			rejectPromise(new Error("Timed out while seeding schema version"));
		}, 10_000);

		const finish = (err?: Error): void => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		// The provider never emits "message"; the Worker's rejection frame
		// arrives on the "__YPS:" channel as "custom-message" (./fatalFrame.ts).
		onFatalFrame(provider, (frame) => {
			finish(new Error(`Seeding rejected by server: ${describeFatalFrame(frame)}`));
		});

		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			const sys = ydoc.getMap("sys");
			ydoc.transact(() => {
				sys.set("initialized", true);
				sys.set("schemaVersion", schemaVersion);
			});

			// Give the provider a moment to flush the update.
			void wait(500).then(() => finish());
		});
	});

	await safeDestroy(provider, ydoc);
}

async function expectRejected(label: string, wsUrl: string, expectedReason: string): Promise<FatalFrame> {
	let payload: FatalFrame | null = null;
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const ws = new WebSocket(wsUrl);
		let sawExpectedCode = false;
		let sawExpectedReason = false;
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			rejectPromise(new Error(`${label}: timed out waiting for update_required`));
		}, 5_000);

		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		// A raw `ws` socket really does emit "message", and it receives the
		// unprefixed copy of the same payload rejectSocket() sends twice.
		ws.on("message", (data) => {
			const text = typeof data === "string" ? data : data.toString();
			const msg = parseFatalFrame(text);
			if (msg?.code === "update_required") {
				sawExpectedCode = true;
				sawExpectedReason = msg.reason === expectedReason;
				payload = msg;
			}
		});

		ws.on("close", () => {
			if (!sawExpectedCode || !sawExpectedReason) {
				finish(new Error(
					`${label}: socket closed without update_required/${expectedReason} error` +
					(payload ? ` (got reason ${JSON.stringify(payload.reason)})` : ""),
				));
				return;
			}
			finish();
		});

		ws.on("error", (err) => {
			finish(err);
		});
	});
	if (payload === null) {
		// Unreachable: the promise only resolves once a matching frame was seen.
		throw new Error(`${label}: resolved without capturing the rejection frame`);
	}
	return payload;
}

async function expectAllowed(roomId: string, schemaVersion: number): Promise<void> {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;
	const { ticket } = await fetchSocketTicket(identity, roomId);
	const provider = new YSyncProvider(HOST, roomId, ydoc, {
		prefix: syncPrefix,
		params: {
			ticket,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPromise(new Error("Compatible schema client failed to sync in time"));
		}, 10_000);

		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		onFatalFrame(provider, (frame) => {
			finish(new Error(`Compatible schema client was rejected: ${describeFatalFrame(frame)}`));
		});

		provider.on("sync", (synced: boolean) => {
			if (synced) finish();
		});
	});

	await safeDestroy(provider, ydoc);
}

async function main() {
	const roomId = ROOM_ID;

	await seedRoomSchema(roomId, SCHEMA_VERSION);
	console.log(`Seeded ${roomId} with sys.schemaVersion=${SCHEMA_VERSION}`);

	await expectAllowed(roomId, SCHEMA_VERSION);
	console.log(`Accepted client at the pinned schema v${SCHEMA_VERSION}`);

	for (const clientSchemaVersion of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
		const payload = await expectRejected(
			`client v${clientSchemaVersion} is outside the pinned schema`,
			await buildWsUrl(roomId, { includeSchema: true, schemaVersion: clientSchemaVersion }),
			"client_schema_unsupported",
		);
		if (payload.clientSchemaVersion !== clientSchemaVersion) {
			throw new Error(`rejection did not echo client schema v${clientSchemaVersion}: ${JSON.stringify(payload)}`);
		}
		if (payload.serverSchemaVersion !== SCHEMA_VERSION) {
			throw new Error(`rejection did not publish the pinned server schema: ${JSON.stringify(payload)}`);
		}
		console.log(`Rejected client v${clientSchemaVersion} with client_schema_unsupported`);
	}

	// No legacy default: an undeclared schema is an unknown writer, not a v1 one.
	const undeclared = await expectRejected(
		"client that declares no schema",
		await buildWsUrl(roomId, { includeSchema: false }),
		"invalid_client_schema",
	);
	if (undeclared.clientSchemaVersion !== null) {
		throw new Error(`undeclared-schema rejection should report a null client schema: ${JSON.stringify(undeclared)}`);
	}
	console.log("Rejected client with no schemaVersion param (invalid_client_schema)");

	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
