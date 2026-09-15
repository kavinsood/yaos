import { strict as assert } from "node:assert";
import { canonicalExcalidrawJson, excalidrawRequestDigestInput } from "../../server/src/shared/excalidrawProtocol";
import { ExcalidrawLifecycleCoordinator } from "../../src/sync/excalidraw/lifecycle";
import { MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";
import type { ExcalidrawLifecycleTransportPort } from "../../src/sync/excalidraw/transport";
import type { ExcalidrawLifecycleRequest } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-lifecycle");

class LostResponseTransport implements ExcalidrawLifecycleTransportPort {
	readonly requests: ExcalidrawLifecycleRequest[] = [];
	private loseResponse = true;
	async lifecycle(request: ExcalidrawLifecycleRequest) {
		this.requests.push(structuredClone(request));
		if (this.loseResponse) { this.loseResponse = false; throw new Error("lifecycle response lost"); }
		return { protocolVersion: 1 as const, operationId: request.operationId, requestDigest: request.requestDigest,
			drawingId: request.drawingId, drawingEpoch: request.drawingEpoch, kind: request.kind,
			resultPath: request.kind === "rename" ? request.toPath : request.path,
			resultLifecycle: request.kind === "delete" ? "tombstoned" as const : "active" as const,
			vaultSequence: 10, rootGeneration: 4, replayed: true };
	}
}

s.test("rename is durable before publication and response-loss retry preserves exact identity", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new LostResponseTransport();
	const coordinator = new ExcalidrawLifecycleCoordinator(persistence, transport, () => 100);
	await assert.rejects(coordinator.rename("drawing1", 1, "Board.excalidraw", "Moved.excalidraw"), /response lost/);
	const pending = await persistence.listLifecycleIntents();
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.attempts, 1);
	assert.equal(pending[0]?.request.requestDigest.length, 64);
	await coordinator.resumeAll();
	assert.equal(transport.requests.length, 2);
	assert.deepEqual(transport.requests[0], transport.requests[1]);
	assert.deepEqual(await persistence.listLifecycleIntents(), []);
	const request = transport.requests[0]!;
	const bytes = new TextEncoder().encode(canonicalExcalidrawJson(excalidrawRequestDigestInput(request)));
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((byte) => byte.toString(16).padStart(2, "0")).join("");
	assert.equal(request.requestDigest, digest);
});

s.test("delete persists the exact drawing epoch and path until its receipt", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new LostResponseTransport();
	const coordinator = new ExcalidrawLifecycleCoordinator(persistence, transport, () => 200);
	await assert.rejects(coordinator.delete("drawing2", 7, "Board.excalidraw.md"), /response lost/);
	const pending = (await persistence.listLifecycleIntents())[0]!;
	assert.equal(pending.request.kind, "delete");
	assert.equal(pending.request.drawingEpoch, 7);
	assert.equal(pending.request.path, "Board.excalidraw.md");
	await coordinator.resumeAll();
	assert.deepEqual(await persistence.listLifecycleIntents(), []);
});

await s.done();
