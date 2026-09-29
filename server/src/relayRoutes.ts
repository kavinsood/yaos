// Relay v2 spike (brief §5.5): compaction-lease and semantic-reset HTTP routes.
// Mounted by VaultRuntime only when `YAOS_RELAY_BODIES === "true"`.
import { base64ToBytes } from "./base64url";
import type { VaultActorContext } from "./collaboration";
import { MAX_CATCH_UP_BYTES } from "./contracts";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { RELAY_MAX_RESET_SNAPSHOT_BYTES, type RelayBodyService } from "./relayBodies";
import type { RelayBodyStore } from "./relayBodyStore";
import type { SemanticEpoch } from "./shared/semanticEpoch";

export interface RelayRouteDeps {
	relay: RelayBodyService;
	relayStore: () => RelayBodyStore;
	isActiveBody: (bodyId: string) => boolean;
	/** Drops a resident base-path document after the lineage changed. */
	discardResident: (bodyId: string) => void;
	fenceSockets: (bodyId: string, previousEpoch: SemanticEpoch, currentEpoch: SemanticEpoch) => number;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function readJsonObject(request: Request, limit: number): Promise<Record<string, unknown> | Response> {
	let bytes: Uint8Array;
	try { bytes = await readBoundedBytes(request, limit, { allowEmpty: true }); }
	catch (error) { return json({ ok: false, reason: error instanceof BoundedBodyError ? error.kind : "invalid_request" }, 413); }
	let value: unknown;
	try { value = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes)); }
	catch { return json({ ok: false, reason: "invalid_request" }, 400); }
	if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, reason: "invalid_request" }, 400);
	return value as Record<string, unknown>;
}

export async function handleCompactionLease(deps: RelayRouteDeps, bodyId: string, request: Request,
	actor: VaultActorContext): Promise<Response> {
	const input = await readJsonObject(request, 16 * 1024);
	if (input instanceof Response) return input;
	if (typeof input.release === "string") {
		const released = deps.relayStore().releaseLease(bodyId, input.release, actor);
		return json({ released }, released ? 200 : 404);
	}
	if (!Number.isSafeInteger(input.expectedEpoch) || (input.expectedEpoch as number) < 1
		|| (input.ttlMs !== undefined && (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs)))) {
		return json({ granted: false, reason: "invalid_request" }, 400);
	}
	if (!deps.isActiveBody(bodyId)) {
		return json({ granted: false, reason: "not_found", epoch: null, headSequence: null }, 404);
	}
	const result = deps.relay.acquireLease(bodyId, actor, input.expectedEpoch as number,
		input.ttlMs as number | undefined);
	if (result.granted) return json(result);
	if (result.reason === "cooldown") {
		const response = json(result, 429);
		response.headers.set("retry-after", String(Math.ceil((result.policy?.cooldownRemainingMs ?? 0) / 1000)));
		return response;
	}
	return json(result, result.reason === "not_found" ? 404 : 409);
}


interface ResetInput {
	leaseId: string; expectedEpoch: number; coveredSequence: number; contentHash: string; contentBytes: number;
	snapshot: Uint8Array;
}

function intField(value: unknown): number | null {
	const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return Number.isSafeInteger(parsed) && (parsed as number) >= 0 ? parsed as number : null;
}

function resetMeta(source: (name: string) => unknown): Omit<ResetInput, "snapshot"> | null {
	const leaseId = source("leaseId");
	const expectedEpoch = intField(source("expectedEpoch"));
	const coveredSequence = intField(source("coveredSequence"));
	const contentHash = source("contentHash");
	const contentBytes = intField(source("contentBytes"));
	if (typeof leaseId !== "string" || leaseId.length === 0 || leaseId.length > 128 || expectedEpoch === null
		|| expectedEpoch < 1 || coveredSequence === null || typeof contentHash !== "string"
		|| !/^[a-f0-9]{64}$/.test(contentHash) || contentBytes === null) return null;
	return { leaseId, expectedEpoch, coveredSequence, contentHash, contentBytes };
}

const RESET_HEADERS: Record<string, string> = {
	leaseId: "x-yaos-lease-id", expectedEpoch: "x-yaos-expected-epoch", coveredSequence: "x-yaos-covered-sequence",
	contentHash: "x-yaos-content-hash", contentBytes: "x-yaos-content-bytes",
};

/**
 * Two request shapes (docs/relay2-protocol.md §5.2):
 * - `application/octet-stream`: body = raw snapshot bytes; metadata in
 *   `x-yaos-*` headers (query parameters of the same camelCase names are accepted too).
 * - `application/json` (legacy): `{ leaseId, expectedEpoch, coveredSequence, contentHash,
 *   contentBytes, snapshot: base64 }`. Base64 inflates 4/3, so it tops out near 6 MB of snapshot.
 */
async function readResetInput(request: Request): Promise<ResetInput | Response> {
	const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	if (type === "application/octet-stream") {
		const url = new URL(request.url);
		const meta = resetMeta((name) => request.headers.get(RESET_HEADERS[name]!) ?? url.searchParams.get(name) ?? undefined);
		if (!meta) return json({ ok: false, reason: "invalid_request" }, 400);
		let snapshot: Uint8Array;
		try { snapshot = await readBoundedBytes(request, RELAY_MAX_RESET_SNAPSHOT_BYTES, { allowEmpty: true }); }
		catch (error) { return json({ ok: false, reason: error instanceof BoundedBodyError ? error.kind : "invalid_request" }, 413); }
		return { ...meta, snapshot };
	}
	const input = await readJsonObject(request, MAX_CATCH_UP_BYTES);
	if (input instanceof Response) return input;
	const meta = resetMeta((name) => input[name]);
	if (!meta || typeof input.snapshot !== "string" || input.snapshot.length === 0) {
		return json({ ok: false, reason: "invalid_request" }, 400);
	}
	let snapshot: Uint8Array;
	try { snapshot = base64ToBytes(input.snapshot); } catch { return json({ ok: false, reason: "invalid_snapshot" }, 400); }
	return { ...meta, snapshot };
}

export async function handleSemanticReset(deps: RelayRouteDeps, bodyId: string, request: Request,
	actor: VaultActorContext): Promise<Response> {
	const input = await readResetInput(request);
	if (input instanceof Response) return input;
	if (!deps.isActiveBody(bodyId)) return json({ ok: false, reason: "not_found" }, 404);
	// Structural sanity only (round 2). Currency is proven by the lease + epoch
	// CAS + exact coveredSequence == head in RelayBodyStore.semanticReset; the
	// server cannot check lineage freshness or content without a document.
	if (!deps.relay.snapshotStructurallyValid(input.snapshot, input.contentBytes)) {
		return json({ ok: false, reason: "invalid_snapshot" }, 400);
	}
	const outcome = deps.relay.semanticReset(bodyId, actor, input);
	if (!outcome.ok) return json(outcome, 409);
	deps.discardResident(bodyId);
	const fencedSockets = deps.fenceSockets(bodyId, outcome.result.previousSemanticEpoch, outcome.result.semanticEpoch);
	return json({ ok: true, epoch: outcome.result.semanticEpoch, previousEpoch: outcome.result.previousSemanticEpoch,
		sequence: outcome.result.vaultSequence, generation: outcome.result.generation, fencedSockets,
		policy: deps.relay.resetPolicy(bodyId) });
}
