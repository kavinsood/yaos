import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
	AuthorityMismatchError,
	DrawingRoomCore,
	InjectedFaultError,
	OperationEquivocationError,
	compareElements,
	type AuthorityStamp,
	type MutationBatch,
	type NativeElementRecord,
} from "./room-core.ts";

const AUTHORITY: AuthorityStamp = { vaultGeneration: "vault-gen-1", authorizationEpoch: 7, drawingEpoch: 2 };
const IDENTITY = { actorId: "actor-a", displayName: "A", color: "#123456", deviceId: "device-a" };

function room(): DrawingRoomCore {
	const value = new DrawingRoomCore(AUTHORITY);
	value.connectSession("session-a", IDENTITY, AUTHORITY);
	return value;
}

function batch(operationId: string, elements: NativeElementRecord[]): MutationBatch {
	return { operationId, sessionId: "session-a", actorId: "actor-a", authority: AUTHORITY, elements };
}

function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): NativeElementRecord {
	return { id, version, versionNonce, type: "rectangle", x: 1, y: 2, ...extra };
}

function runDeterministicContracts(): void {
	const value = room();
	const first = value.applyBatch(batch("op-1", [element("a", 1, 10), element("b", 1, 11)]));
	assert.equal(first.sequence, 1);
	assert.deepEqual(first.acceptedElementIds, ["a", "b"]);
	assert.equal(value.replayAfter(0).events.length, 1, "multi-element gesture must occupy one sequence/event");

	const mixed = value.applyBatch(batch("op-2", [element("a", 1, 11), element("b", 2, 1)]));
	assert.deepEqual(mixed.acceptedElementIds, ["b"]);
	assert.deepEqual(mixed.staleElementIds, ["a"]);
	assert.equal(mixed.sequence, 2);

	const sameVersionLowerNonce = value.applyBatch(batch("op-3", [element("a", 1, 8)]));
	assert.deepEqual(sameVersionLowerNonce.acceptedElementIds, ["a"]);

	const equalTupleDeterministicPayload = value.applyBatch(batch("op-4", [element("a", 1, 8, { x: 99 })]));
	assert.equal(equalTupleDeterministicPayload.acceptedElementIds.length, 1, "payload tie must have a total order");

	value.applyBatch(batch("op-delete", [element("gone", 8, 2, { isDeleted: true })]));
	assert.equal(value.snapshot().elements.find((candidate) => candidate.id === "gone")?.isDeleted, true);
	assert.equal(value.snapshot().elements.length, 3, "tombstones remain first-class records");

	const receipt = value.applyBatch(batch("op-idempotent", [element("c", 1, 1)]));
	assert.deepEqual(value.applyBatch(batch("op-idempotent", [element("c", 1, 1)])), receipt);
	assert.throws(() => value.applyBatch(batch("op-idempotent", [element("c", 2, 1)])), OperationEquivocationError);

	const beforeFault = room();
	assert.throws(() => beforeFault.applyBatch(batch("fault-before", [element("x", 1, 1)]), "before-commit"), InjectedFaultError);
	assert.equal(beforeFault.snapshot().sequence, 0);
	assert.equal(beforeFault.receipt("fault-before"), null);
	assert.equal(beforeFault.applyBatch(batch("fault-before", [element("x", 1, 1)])).sequence, 1);

	const afterFault = room();
	assert.throws(() => afterFault.applyBatch(batch("fault-after", [element("x", 1, 1)]), "after-commit"), InjectedFaultError);
	assert.equal(afterFault.snapshot().sequence, 1);
	assert.equal(afterFault.applyBatch(batch("fault-after", [element("x", 1, 1)])).sequence, 1, "retry observes committed receipt");

	const compacted = value.compact();
	assert.equal(value.replayAfter(compacted.sequence - 1).snapshotRequired, true);
	assert.equal(value.replayAfter(compacted.sequence).snapshotRequired, false);
	value.applyBatch(batch("post-compact", [element("z", 1, 1)]));
	assert.equal(value.replayAfter(compacted.sequence).events.length, 1);

	value.updatePresence("session-a", { pointer: { x: 3, y: 4 }, selectedElementIds: ["a", "a"] }, 1_000);
	assert.equal(value.listPresence(10_000).length, 1);
	assert.deepEqual(value.listPresence(10_000)[0]?.payload.selectedElementIds, ["a"]);
	assert.equal(value.listPresence(16_000).length, 0);

	value.setAuthority({ ...AUTHORITY, authorizationEpoch: AUTHORITY.authorizationEpoch + 1 });
	assert.throws(() => value.applyBatch(batch("stale-authority", [element("q", 1, 1)])), AuthorityMismatchError);
	assert.throws(() => value.updatePresence("session-a", { pointer: { x: 1, y: 1 } }, 20_000));
}

function runPermutationFuzz(iterations: number): void {
	const random = mulberry32(0x5eed1234);
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const candidates: NativeElementRecord[] = [];
		for (let candidate = 0; candidate < 24; candidate += 1) {
			candidates.push(element(`element-${candidate % 5}`, Math.floor(random() * 5), Math.floor(random() * 8), {
				x: Math.floor(random() * 1_000),
				isDeleted: random() < 0.2,
			}));
		}
		const expected = new Map<string, NativeElementRecord>();
		for (const candidate of candidates) {
			const prior = expected.get(candidate.id);
			if (!prior || compareElements(candidate, prior) > 0) expected.set(candidate.id, candidate);
		}

		for (let permutation = 0; permutation < 6; permutation += 1) {
			const value = room();
			const shuffled = shuffle(candidates, random);
			for (let index = 0; index < shuffled.length; index += 1) {
				value.applyBatch(batch(`fuzz-${iteration}-${permutation}-${index}`, [shuffled[index]!]));
			}
			const actual = new Map(value.snapshot().elements.map((candidate) => [candidate.id, candidate]));
			assert.deepEqual(actual, expected, `permutation ${permutation} diverged at fuzz iteration ${iteration}`);
		}
	}
}

function runLoadExperiment(elementCount: number, rounds: number): { elapsedMs: number; operationsPerSecond: number; snapshotBytes: number } {
	const value = room();
	const start = performance.now();
	let operation = 0;
	for (let round = 1; round <= rounds; round += 1) {
		for (let offset = 0; offset < elementCount; offset += 128) {
			const elements: NativeElementRecord[] = [];
			for (let index = offset; index < Math.min(offset + 128, elementCount); index += 1) {
				elements.push(element(`load-${index}`, round, (round * 100_000) + index, {
					x: index * round,
					text: `payload-${index}-${"x".repeat(48)}`,
					isDeleted: round === rounds && index % 10 === 0,
				}));
			}
			value.applyBatch(batch(`load-op-${operation}`, elements));
			operation += 1;
		}
	}
	const elapsedMs = performance.now() - start;
	const snapshotBytes = Buffer.byteLength(JSON.stringify(value.snapshot()));
	assert.equal(value.snapshot().elements.length, elementCount);
	return { elapsedMs, operationsPerSecond: operation / (elapsedMs / 1_000), snapshotBytes };
}

function shuffle<T>(input: T[], random: () => number): T[] {
	const result = [...input];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const target = Math.floor(random() * (index + 1));
		[result[index], result[target]] = [result[target]!, result[index]!];
	}
	return result;
}

function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = seed + 0x6D2B79F5 | 0;
		let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
		value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
		return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
	};
}

runDeterministicContracts();
runPermutationFuzz(250);
const load = runLoadExperiment(10_000, 3);
console.log(JSON.stringify({
	status: "ok",
	deterministicContracts: "passed",
	fuzz: { iterations: 250, permutationsPerIteration: 6, candidatesPerIteration: 24 },
	load: {
		elements: 10_000,
		rounds: 3,
		elapsedMs: Number(load.elapsedMs.toFixed(1)),
		operationsPerSecond: Number(load.operationsPerSecond.toFixed(1)),
		snapshotBytes: load.snapshotBytes,
	},
}, null, 2));
