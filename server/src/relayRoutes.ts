// Relay v2 spike (brief §5.5): compaction-lease and semantic-reset HTTP routes.
// Mounted by VaultRuntime only when `YAOS_RELAY_BODIES === "true"`.
import { base64ToBytes } from "./base64url";
import type { VaultActorContext } from "./collaboration";
import { MAX_CATCH_UP_BYTES } from "./contracts";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import type { RelayBodyService } from "./relayBodies";
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
	return json(result, result.reason === "not_found" ? 404 : 409);
}

export async function handleSemanticReset(deps: RelayRouteDeps, bodyId: string, request: Request,
	actor: VaultActorContext): Promise<Response> {
	const input = await readJsonObject(request, MAX_CATCH_UP_BYTES);
	if (input instanceof Response) return input;
	if (typeof input.leaseId !== "string" || !Number.isSafeInteger(input.expectedEpoch)
		|| !Number.isSafeInteger(input.coveredSequence) || (input.coveredSequence as number) < 0
		|| typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)
		|| !Number.isSafeInteger(input.contentBytes) || (input.contentBytes as number) < 0
		|| typeof input.snapshot !== "string" || input.snapshot.length === 0) {
		return json({ ok: false, reason: "invalid_request" }, 400);
	}
	if (!deps.isActiveBody(bodyId)) return json({ ok: false, reason: "not_found" }, 404);
	let snapshot: Uint8Array;
	try { snapshot = base64ToBytes(input.snapshot); } catch { return json({ ok: false, reason: "invalid_snapshot" }, 400); }
	// The snapshot must decode and cover everything durable at the head it claims.
	// (It must also be a lineage-fresh state; the server cannot check that without
	// a document and trusts the client, as with envelope hashes.)
	if (snapshot.byteLength < 2 || !deps.relay.snapshotCoversHead(bodyId, snapshot)) {
		return json({ ok: false, reason: "invalid_snapshot" }, 400);
	}
	const outcome = deps.relayStore().semanticReset({
		bodyId, actor, leaseId: input.leaseId, expectedEpoch: input.expectedEpoch as number,
		coveredSequence: input.coveredSequence as number, snapshot,
		contentHash: input.contentHash, contentBytes: input.contentBytes as number,
	});
	if (!outcome.ok) {
		deps.relay.counters.leaseDenials++;
		return json(outcome, 409);
	}
	deps.relay.counters.resets++;
	deps.relay.invalidate(bodyId);
	deps.discardResident(bodyId);
	const fencedSockets = deps.fenceSockets(bodyId, outcome.result.previousSemanticEpoch, outcome.result.semanticEpoch);
	return json({ ok: true, epoch: outcome.result.semanticEpoch, previousEpoch: outcome.result.previousSemanticEpoch,
		sequence: outcome.result.vaultSequence, generation: outcome.result.generation, fencedSockets });
}
