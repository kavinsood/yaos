// Worker entry (DECISIONS §2.1, §2.2): the route table, method and path match, size caps and format checks, then a
// forward to one Durable Object. Stateless except for `claimed`, cached in isolate memory once seen (D2). It does no
// crypto and no storage writes, and device routes never touch the config DO (T-HOTPATH).
import { ConfigDO, CONFIG_OBJECT_NAME } from "./config/config";
import {
	corsPreflight,
	html,
	json,
	notFound,
	notImplemented,
	rejectSocket,
	releaseUnreadBody,
	withCors,
} from "./http";
import type { UpgradeRejectPort } from "./ports";
import { BoundedBodyError, declaredBodyLength, readBoundedBytes } from "./readBoundedBytes";
import { MAX_STREAM_CHECKPOINT_BYTES, STREAMS_CAPABILITY_VERSION } from "./streams/protocol";
import { CLOUDFLARE_UPGRADE_REJECT } from "./vault/cloudflare";
import { VaultDO, type VaultEnv } from "./vault/vault";
import { isVaultId } from "./vaultId";
import { SERVER_VERSION } from "./version";

export { ConfigDO, VaultDO };

export interface WorkerEnv extends VaultEnv {
	YAOS_VAULT: DurableObjectNamespace<VaultDO>;
	YAOS_CONFIG: DurableObjectNamespace<ConfigDO>;
	YAOS_BUCKET?: R2Bucket;
}

/** Capabilities `maxBlobUploadBytes` and the blob PUT cap (relay-wire §11.3, unchanged). */
export const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * DECISIONS-GAP: §2.2 caps the claim JSON at 64 KiB but names no cap for /enroll, whose body the Worker must parse to
 * route by code. The same 64 KiB is used; a larger body is `413 body_too_large`.
 */
export const MAX_ENROLL_BODY_BYTES = 64 * 1024;
/** D3: `<vaultId>.<secret>`, base64url(16 B) + "." + base64url(24 B), checked after trim. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/;
/** §2.2 blob address (relay-wire §11.3 after §5: 64 lowercase hex, no hash check). */
export const BLOB_ADDRESS_PATTERN = /^[0-9a-f]{64}$/;
/**
 * DECISIONS-GAP: §2.2 does not give a format for the `:deviceId` path segment of the operator devices route. The
 * enroll body's deviceId format (legacy routes/enroll.ts:36) is used; anything else is 404.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The vault DO's internal origin. The Worker forwards `/vault/:id/<rest>` as `<origin>/<rest>`, `/enroll` as is. */
export const VAULT_INTERNAL_ORIGIN = "https://vault.internal";

/**
 * DECISIONS-GAP: the console (`GET /`) and `GET /mobile-setup` are P4 (§9). Until then both are static placeholders
 * with no DO call, as §2.2 requires.
 */
const CONSOLE_PLACEHOLDER = "<!doctype html><meta charset=\"utf-8\"><title>YAOS server</title><h1>YAOS server</h1>"
	+ "<p>The operator console is not available in this build.</p>";
const MOBILE_SETUP_PLACEHOLDER = "<!doctype html><meta charset=\"utf-8\"><title>YAOS mobile setup</title>"
	+ "<h1>YAOS mobile setup</h1><p>Mobile setup is not available in this build.</p>";

export interface RouterPorts {
	upgrades: UpgradeRejectPort;
}

/** streamsVersion as the legacy route read it (removed routes/vault.ts:146-151): blank or malformed → null. */
function declaredVersion(url: URL, name: string): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 413 or 400 for a Content-Length the cap refuses; null when the body may pass. */
function contentLengthRejection(request: Request, maxBytes: number): Response | null {
	try {
		declaredBodyLength(request, maxBytes);
		return null;
	} catch (error) {
		if (!(error instanceof BoundedBodyError)) throw error;
		return json({ error: error.kind }, error.kind === "body_too_large" ? 413 : 400);
	}
}

export class Router {
	/** D2: `true` once the config DO said so; never re-read in this isolate. */
	private claimedSeen = false;

	constructor(private readonly ports: RouterPorts) {}

	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		try {
			return await this.route(request, env);
		} catch (error) {
			console.error("[yaos-worker] request failed", error);
			// DECISIONS-GAP: §2.2 names no status for an unexpected Worker failure; 500 `internal_error`.
			return withCors(json({ error: "internal_error" }, 500));
		} finally {
			await releaseUnreadBody(request);
		}
	}

	private async route(request: Request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		const { method } = request;
		const path = url.pathname;
		if (method === "OPTIONS" && (path.startsWith("/api/") || path === "/enroll" || path.startsWith("/vault/"))) {
			return corsPreflight();
		}
		switch (`${method} ${path}`) {
			case "GET /":
				return html(CONSOLE_PLACEHOLDER);
			case "GET /mobile-setup":
				return html(MOBILE_SETUP_PLACEHOLDER);
			case "GET /api/capabilities":
				return withCors(json(await this.capabilities(env)));
			case "POST /enroll":
				return withCors(await this.enroll(request, env));
			case "POST /claim":
			case "POST /operator/login":
			case "POST /operator/logout":
			case "GET /operator/state":
			case "POST /operator/vaults":
				// P2 (D5): claim, login, sessions and create vault. No DO call until then.
				return notImplemented();
		}
		const parts = path.split("/").slice(1);
		if (parts[0] === "operator" && parts[1] === "vaults" && isVaultId(parts[2])) {
			return this.operatorVault(method, parts.slice(3));
		}
		if (parts[0] === "vault" && isVaultId(parts[1])) {
			return this.vault(request, env, url, parts[1], parts.slice(2));
		}
		return withCors(notFound());
	}

	/** `GET /api/capabilities`: the §5 (2.1) fields only. The config DO is asked until it says `claimed`. */
	private async capabilities(env: WorkerEnv): Promise<Record<string, unknown>> {
		if (!this.claimedSeen) {
			const config = env.YAOS_CONFIG.get(env.YAOS_CONFIG.idFromName(CONFIG_OBJECT_NAME));
			this.claimedSeen = await config.isClaimed();
		}
		return {
			claimed: this.claimedSeen,
			attachments: Boolean(env.YAOS_BUCKET),
			maxBlobUploadBytes: MAX_BLOB_UPLOAD_BYTES,
			serverVersion: SERVER_VERSION,
			streams: STREAMS_CAPABILITY_VERSION,
		};
	}

	/** `/operator/vaults/:id/...` (§2.2): P2 (D5, D7) and P3 (D8b restore). No DO call for them yet. */
	private operatorVault(method: string, rest: string[]): Response {
		const route = `${method} ${rest.join("/")}`;
		const known = route === "DELETE " || route === "POST owner-code" || route === "GET devices"
			|| route === "POST reset-streams" || route === "POST restore"
			|| (method === "DELETE" && rest.length === 2 && rest[0] === "devices" && DEVICE_ID_PATTERN.test(rest[1]!));
		return known ? notImplemented() : withCors(notFound());
	}

	/**
	 * `POST /enroll` (D3): the vault comes from the code. A malformed code is `400 invalid_code` with no DO call; the
	 * vault DO answers the rest, including `404 invalid_code` for an unknown vault.
	 */
	private async enroll(request: Request, env: WorkerEnv): Promise<Response> {
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedBytes(request, MAX_ENROLL_BODY_BYTES, { allowEmpty: true });
		} catch (error) {
			if (!(error instanceof BoundedBodyError)) throw error;
			if (error.kind === "body_too_large") return json({ error: "body_too_large" }, 413);
			bytes = new Uint8Array();
		}
		let body: unknown = null;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			// DECISIONS-GAP: a body that is not JSON carries no well-formed code, so it gets D3's `400 invalid_code`
			// (legacy answered `400 "invalid json"`, removed routes/enroll.ts:25-28; the client sends JSON only).
		}
		const raw = body && typeof body === "object" ? (body as { pairingCode?: unknown }).pairingCode : undefined;
		const code = typeof raw === "string" ? raw.trim() : "";
		if (!PAIRING_CODE_PATTERN.test(code)) return json({ error: "invalid_code" }, 400);
		const vault = env.YAOS_VAULT.get(env.YAOS_VAULT.idFromName(code.slice(0, 22)));
		return vault.fetch(new Request(`${VAULT_INTERNAL_ORIGIN}/enroll`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: bytes,
		}));
	}

	/** `/vault/:id/...` (§2.2). Every listed route reaches only the vault DO named by `:id`. */
	private async vault(
		request: Request, env: WorkerEnv, url: URL, vaultId: string, rest: string[],
	): Promise<Response> {
		const route = `${request.method} ${rest.join("/")}`;
		switch (route) {
			case "POST auth/pairing-code":
			case "POST auth/ticket":
			case "GET streams/feed":
			case "GET streams/read":
				return withCors(await this.forward(request, env, url, vaultId, rest));
			case "PUT streams/checkpoint":
				return withCors(contentLengthRejection(request, MAX_STREAM_CHECKPOINT_BYTES)
					?? await this.forward(request, env, url, vaultId, rest));
			case "GET ws/streams": {
				// DECISIONS-GAP: §2.2 puts the streamsVersion check in the Worker, so it now runs before the
				// ticket check (legacy routes/vault.ts:166-179 checked the ticket and the device first). A stale
				// client learns `update_required` without a valid ticket; the check reveals nothing about the vault.
				const version = declaredVersion(url, "streamsVersion");
				const response = version === STREAMS_CAPABILITY_VERSION
					? await this.forward(request, env, url, vaultId, rest)
					: rejectSocket(request, this.ports.upgrades, "update_required", {
						reason: "streams_version_mismatch",
						clientStreamsVersion: version,
						serverStreamsVersion: STREAMS_CAPABILITY_VERSION,
					});
				return response.status === 101 ? response : withCors(response);
			}
			case "POST debug/simulate-daily-limit":
				return withCors(env.YAOS_DEBUG_ROUTES === "1"
					? await this.forward(request, env, url, vaultId, rest)
					: notFound());
			case "POST blobs/exists":
				return withCors(this.blob(request, env, null));
		}
		if (rest.length === 2 && rest[0] === "blobs" && (request.method === "GET" || request.method === "PUT")) {
			return withCors(this.blob(request, env, rest[1]!));
		}
		return withCors(notFound());
	}

	/**
	 * Blob routes: the Worker checks, in the legacy order of the removed routes/blobs.ts:111-127 (bucket, address,
	 * size). P3 adds the vault DO bearer check and the R2 I/O under `v/<vaultId>/<address>` (D9).
	 */
	private blob(request: Request, env: WorkerEnv, address: string | null): Response {
		if (!env.YAOS_BUCKET) return json({ error: "attachments_unavailable" }, 503);
		// DECISIONS-GAP: §2.2 requires the address regex but names no error; `400 invalid_address`.
		if (address !== null && !BLOB_ADDRESS_PATTERN.test(address)) return json({ error: "invalid_address" }, 400);
		if (request.method === "PUT") {
			const rejection = contentLengthRejection(request, MAX_BLOB_UPLOAD_BYTES);
			if (rejection) return rejection;
		}
		return notImplemented();
	}

	/** Streams the request (method, headers, query, body) to the vault DO at `<internal origin>/<rest>`. */
	private forward(request: Request, env: WorkerEnv, url: URL, vaultId: string, rest: string[]): Promise<Response> {
		const vault = env.YAOS_VAULT.get(env.YAOS_VAULT.idFromName(vaultId));
		return vault.fetch(new Request(`${VAULT_INTERNAL_ORIGIN}/${rest.join("/")}${url.search}`, request));
	}
}

const router = new Router({ upgrades: CLOUDFLARE_UPGRADE_REJECT });

export default {
	fetch(request: Request, env: WorkerEnv): Promise<Response> {
		return router.fetch(request, env);
	},
} satisfies ExportedHandler<WorkerEnv>;
