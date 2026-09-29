/**
 * Relay v2 spike: `ResetTransport` over the deployed HTTP routes of
 * docs/relay2-protocol.md §5.1–5.3 (device bearer auth, JSON, snapshot base64).
 * Never logs request bodies or headers (bearer tokens).
 */
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { BODY_EPOCH_HEADER } from "../../../server/src/shared/semanticEpoch";
import type {
	BodyStateResponse,
	LeaseRequest,
	LeaseResponse,
	ResetTransport,
	SemanticResetRequest,
	SemanticResetResponse,
} from "./leaseClient";

export interface HttpTiming { route: string; status: number; requestBytes: number; responseBytes: number; ms: number; at: number }

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export class HttpResetTransport implements ResetTransport {
	readonly timings: HttpTiming[] = [];

	constructor(readonly identity: LiveIdentity) {}

	private async post(route: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
		const body = JSON.stringify(payload);
		const started = performance.now();
		const response = await fetch(vaultRoute(this.identity, route), {
			method: "POST", headers: deviceBearerHeaders(this.identity, { "Content-Type": "application/json" }), body,
		});
		const text = await response.text();
		this.timings.push({ route, status: response.status, requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength(text),
			ms: performance.now() - started, at: Date.now() });
		let parsed: Record<string, unknown> = {};
		try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: "non_json", status: response.status, text: text.slice(0, 200) }; }
		return { status: response.status, body: parsed };
	}

	async requestLease(bodyId: string, request: LeaseRequest): Promise<LeaseResponse> {
		const { status, body } = await this.post(`body/${encodeURIComponent(bodyId)}/compaction-lease`, request);
		if (status === 200 && body.granted === true) {
			return {
				granted: true, leaseId: String(body.leaseId), expiresAt: Number(body.expiresAt), epoch: Number(body.epoch),
				headSequence: Number(body.headSequence),
				...(typeof body.stateVector === "string" ? { stateVector: fromBase64(body.stateVector) } : {}),
			};
		}
		return {
			granted: false, reason: typeof body.reason === "string" ? body.reason : `http_${status}`,
			epoch: Number(body.epoch ?? NaN), headSequence: Number(body.headSequence ?? NaN),
			...(typeof body.holderDeviceId === "string" ? { holderDeviceId: body.holderDeviceId } : {}),
			...(typeof body.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}),
		};
	}

	async releaseLease(bodyId: string, leaseId: string): Promise<void> {
		await this.post(`body/${encodeURIComponent(bodyId)}/compaction-lease`, { release: leaseId });
	}

	async semanticReset(bodyId: string, request: SemanticResetRequest): Promise<SemanticResetResponse> {
		const { status, body } = await this.post(`body/${encodeURIComponent(bodyId)}/semantic-reset`, {
			leaseId: request.leaseId, expectedEpoch: request.expectedEpoch, coveredSequence: request.coveredSequence,
			contentHash: request.contentHash, contentBytes: request.contentBytes, snapshot: toBase64(request.snapshot),
		});
		if (status === 200 && body.ok === true) {
			return { ok: true, epoch: Number(body.epoch), previousEpoch: Number(body.previousEpoch), sequence: Number(body.sequence),
				...(typeof body.fencedSockets === "number" ? { fencedSockets: body.fencedSockets } : {}) };
		}
		return { ok: false, reason: typeof body.reason === "string" ? body.reason : `http_${status}`,
			epoch: Number(body.epoch ?? NaN), headSequence: Number(body.headSequence ?? NaN) };
	}

	async fetchBody(bodyId: string): Promise<BodyStateResponse & { contentHash: string | null; generation: number | null }> {
		const started = performance.now();
		const response = await fetch(vaultRoute(this.identity, `body/${encodeURIComponent(bodyId)}`), {
			headers: deviceBearerHeaders(this.identity),
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		this.timings.push({ route: `GET body/${bodyId}`, status: response.status, requestBytes: 0, responseBytes: bytes.byteLength,
			ms: performance.now() - started, at: Date.now() });
		if (!response.ok) throw new Error(`body read failed ${response.status}`);
		const sequenceHeader = response.headers.get("x-yaos-latest-sequence") ?? response.headers.get("x-yaos-through-sequence");
		return {
			epoch: Number(response.headers.get(BODY_EPOCH_HEADER)),
			headSequence: sequenceHeader === null ? -1 : Number(sequenceHeader),
			encodedState: bytes,
			contentHash: response.headers.get("x-yaos-content-hash") || null,
			generation: response.headers.get("x-yaos-generation") === null ? null : Number(response.headers.get("x-yaos-generation")),
		};
	}
}
