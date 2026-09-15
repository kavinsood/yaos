import { randomId } from "../../utils/randomId";
import { sha256TextHex } from "../../utils/sha256";
import { canonicalExcalidrawJson } from "./canonical";
import type { ExcalidrawResourceManifestEntry } from "./types";
import { encodePublicShareFragment, type BrowserFetch, type PublicSharePermission } from "./browserTransport";

const defaultBrowserFetch: BrowserFetch = async (input, init) => await window.fetch(input, init);

export interface ExcalidrawSharePublicationInput {
	permission: PublicSharePermission;
	expiresAt: number;
	resources: readonly ExcalidrawResourceManifestEntry[];
}

export interface ExcalidrawShareLink {
	shareId: string;
	publicDrawingId: string;
	permission: PublicSharePermission;
	expiresAt: number;
	grantRevision: number;
	url: string;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Owner-side API. Raw link secrets exist only in the returned URL fragment. */
export class ExcalidrawShareManagementClient {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly fetcher: BrowserFetch = defaultBrowserFetch) {
		this.base = host.replace(/\/$/, "");
	}

	async create(drawingId: string, input: ExcalidrawSharePublicationInput): Promise<ExcalidrawShareLink> {
		const shareId = randomId(32);
		const publicDrawingId = randomId(32);
		const linkSecret = randomId(64);
		const unsigned = {
			protocolVersion: 1, operationId: randomId(32), shareId, publicDrawingId,
			linkSecretHash: await sha256TextHex(linkSecret), permission: input.permission,
			expiresAt: input.expiresAt, resources: input.resources,
		};
		const response = await this.fetcher(this.route(drawingId), this.request("POST", {
			...unsigned, requestDigest: await sha256TextHex(canonicalExcalidrawJson(unsigned)),
		}));
		const body = await this.require(response);
		if (typeof body.routeEnvelope !== "string" || !Number.isSafeInteger(body.grantRevision)) {
			throw new Error("share creation response malformed");
		}
		const fragment = encodePublicShareFragment({ routeEnvelope: body.routeEnvelope, linkSecret });
		return { shareId, publicDrawingId, permission: input.permission, expiresAt: input.expiresAt,
			grantRevision: body.grantRevision as number, url: `${this.base}/share#${fragment}` };
	}

	async update(drawingId: string, shareId: string, grantRevision: number,
		input: ExcalidrawSharePublicationInput): Promise<number> {
		const unsigned = {
			protocolVersion: 1, operationId: randomId(32), shareId, expectedGrantRevision: grantRevision,
			permission: input.permission, expiresAt: input.expiresAt, resources: input.resources,
		};
		const response = await this.fetcher(`${this.route(drawingId)}/${encodeURIComponent(shareId)}`, this.request("PATCH", {
			...unsigned, requestDigest: await sha256TextHex(canonicalExcalidrawJson(unsigned)),
		}));
		const body = await this.require(response);
		if (!Number.isSafeInteger(body.grantRevision)) throw new Error("share update response malformed");
		return body.grantRevision as number;
	}

	async revoke(drawingId: string, shareId: string, grantRevision: number): Promise<number> {
		const unsigned = {
			protocolVersion: 1, operationId: randomId(32), shareId, expectedGrantRevision: grantRevision,
		};
		const response = await this.fetcher(`${this.route(drawingId)}/${encodeURIComponent(shareId)}`, this.request("DELETE", {
			...unsigned, requestDigest: await sha256TextHex(canonicalExcalidrawJson(unsigned)),
		}));
		const body = await this.require(response);
		if (!Number.isSafeInteger(body.grantRevision)) throw new Error("share revocation response malformed");
		return body.grantRevision as number;
	}

	private route(drawingId: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/excalidraw/${encodeURIComponent(drawingId)}/shares`;
	}
	private request(method: string, body: unknown): RequestInit {
		return { method, credentials: "omit", headers: { authorization: `Bearer ${this.token}`,
			"content-type": "application/json" }, body: JSON.stringify(body) };
	}
	private async require(response: Awaited<ReturnType<BrowserFetch>>): Promise<Record<string, unknown>> {
		let body: unknown;
		try { body = await response.json(); } catch { body = null; }
		const value = object(body);
		if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `share request failed (${response.status})`);
		if (!value) throw new Error("share response malformed");
		return value;
	}
}
