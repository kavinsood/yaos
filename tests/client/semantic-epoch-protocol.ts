import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	INITIAL_SEMANTIC_EPOCH,
	SEMANTIC_EPOCH_MISMATCH_CODE,
	SemanticEpochMismatchError,
	assertSemanticEpoch,
	nextSemanticEpoch,
	parseSemanticEpochHeader,
	parseSemanticEpoch,
	parseSemanticEpochMismatchPayload,
	parseSemanticEpochResetFrame,
	semanticEpochHeaders,
} from "../../server/src/shared/semanticEpoch";
import { BodyCoordinator } from "../../src/sync/bodyCoordinator";
import { parseVaultControlFrame } from "../../src/sync/vaultSync";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import {
	prepareRootSemanticEpochTransition,
	prepareSemanticEpochTransition,
} from "../../src/sync/semanticEpochTransition";
import { suite } from "../harness.ts";

const s = suite("semantic-epoch-protocol");

function encodedBody(content: string): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, content);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

s.test("body and root epochs are distinct monotonic CRDT identity fences", () => {
	assert.equal(parseSemanticEpoch(INITIAL_SEMANTIC_EPOCH), 1);
	assert.equal(nextSemanticEpoch(41), 42);
	assert.throws(() => parseSemanticEpoch(0), /invalid semantic epoch/);
	assert.throws(() => nextSemanticEpoch(Number.MAX_SAFE_INTEGER), /exhausted/);
	assert.doesNotThrow(() => assertSemanticEpoch(
		{ purpose: "root", documentId: "root", rootEpoch: 3 },
		{ purpose: "root", documentId: "root", rootEpoch: 3 },
	));
	assert.throws(() => assertSemanticEpoch(
		{ purpose: "body", documentId: "body-a", bodyEpoch: 9 },
		{ purpose: "body", documentId: "body-a", bodyEpoch: 8 },
	), (error: unknown) => error instanceof SemanticEpochMismatchError
		&& error.status === 409
		&& error.code === SEMANTIC_EPOCH_MISMATCH_CODE);
	assert.throws(() => assertSemanticEpoch(
		{ purpose: "body", documentId: "body-a", bodyEpoch: 9 },
		{ purpose: "body", documentId: "body-b", bodyEpoch: 9 },
	), /scope identity mismatch/);
});

s.test("HTTP payloads and socket reset frames use one strict mismatch contract", () => {
	const error = new SemanticEpochMismatchError({
		purpose: "body",
		documentId: "body-a",
		expectedBodyEpoch: 12,
		receivedBodyEpoch: 11,
	});
	assert.deepEqual(parseSemanticEpochMismatchPayload(error.toPayload()), error.toPayload());
	assert.deepEqual(parseSemanticEpochResetFrame(error.toSocketFrame()), error.toSocketFrame());
	assert.deepEqual(parseVaultControlFrame(JSON.stringify(error.toSocketFrame())), error.toSocketFrame(),
		"the live client control parser must surface reset frames to recovery");
	assert.equal(parseSemanticEpochMismatchPayload({
		...error.toPayload(),
		documentId: "root",
	}), null, "a body fence cannot masquerade as the root fence");
	assert.equal(parseSemanticEpochResetFrame({
		...error.toSocketFrame(),
		expectedEpoch: 0,
	}), null);
	assert.deepEqual(
		semanticEpochHeaders({ purpose: "body", documentId: "body-a", bodyEpoch: 12 }),
		{ "x-yaos-body-epoch": "12" },
	);
	assert.equal(parseSemanticEpochHeader({ "X-Yaos-Root-Epoch": "4" }, "root"), 4);
	assert.throws(() => parseSemanticEpochHeader({}, "body"), /body epoch header/);
});

s.test("epoch transition rebases only Markdown intent onto the fresh Yjs lineage", () => {
	const authoritativeEncodedState = encodedBody("title\nserver line\nshared\n");
	const result = prepareSemanticEpochTransition({
		bodyId: "body-a",
		previousBodyEpoch: 4,
		nextBodyEpoch: 5,
		previousBaseline: "title\nold line\nshared\n",
		pendingMarkdown: "local title\nold line\nshared\n",
		authoritativeEncodedState,
	});
	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	try {
		assert.equal(result.bodyEpoch, 5);
		assert.equal(result.rebasedContent, "local title\nserver line\nshared\n");
		assert.ok(result.rebasedUpdate && result.rebasedUpdate.byteLength > 0);

		const independentlyFetchedFreshDoc = new Y.Doc();
		try {
			Y.applyUpdate(independentlyFetchedFreshDoc, authoritativeEncodedState);
			Y.applyUpdate(independentlyFetchedFreshDoc, result.rebasedUpdate!);
			assert.equal(
				independentlyFetchedFreshDoc.getText("body").toJSON(),
				"local title\nserver line\nshared\n",
			);
		} finally {
			independentlyFetchedFreshDoc.destroy();
		}
	} finally {
		result.document.destroy();
	}
});

s.test("epoch transition refuses ambiguous and non-monotonic rebases", () => {
	const conflict = prepareSemanticEpochTransition({
		bodyId: "body-a",
		previousBodyEpoch: 2,
		nextBodyEpoch: 3,
		previousBaseline: "same\n",
		pendingMarkdown: "local\n",
		authoritativeEncodedState: encodedBody("server\n"),
	});
	assert.equal(conflict.kind, "conflict");
	if (conflict.kind === "conflict") {
		assert.equal(conflict.pendingMarkdown, "local\n");
		assert.equal(conflict.authoritativeContent, "server\n");
		assert.equal(conflict.conflicts.length, 1);
	}
	assert.throws(() => prepareSemanticEpochTransition({
		bodyId: "body-a",
		previousBodyEpoch: 3,
		nextBodyEpoch: 3,
		previousBaseline: "",
		pendingMarkdown: "",
		authoritativeEncodedState: encodedBody(""),
	}), /advance monotonically/);
});

s.test("pathological old struct history cannot leak into the rebased update", () => {
	const old = new Y.Doc({ guid: "body-pathological-old", gc: false });
	const oldText = old.getText("body");
	oldText.insert(0, "base\n");
	for (let index = 0; index < 2_000; index++) {
		oldText.insert(oldText.length, `dead-${index}\n`);
		oldText.delete(oldText.length - `dead-${index}\n`.length, `dead-${index}\n`.length);
	}
	oldText.insert(0, "local ");
	const oldClientIds = new Set(old.store.clients.keys());

	const authoritativeEncodedState = encodedBody("base\nserver\n");
	const transition = prepareSemanticEpochTransition({
		bodyId: "body-pathological",
		previousBodyEpoch: 20,
		nextBodyEpoch: 21,
		previousBaseline: "base\n",
		pendingMarkdown: oldText.toJSON(),
		authoritativeEncodedState,
	});
	assert.equal(transition.kind, "ready");
	if (transition.kind !== "ready") {
		old.destroy();
		return;
	}
	try {
		for (const clientId of transition.document.store.clients.keys()) {
			assert.equal(oldClientIds.has(clientId), false, "fresh document retained an old client struct identity");
		}
		assert.ok(transition.rebasedUpdate);
		const oldBytes = Y.encodeStateAsUpdate(old).byteLength;
		assert.ok(
			transition.rebasedUpdate!.byteLength < oldBytes,
			`fresh ${transition.rebasedUpdate!.byteLength} bytes should not carry ${oldBytes} bytes of old history`,
		);
	} finally {
		transition.document.destroy();
		old.destroy();
	}
});

s.test("coordinator invalidates every old identity proof when body epoch advances", () => {
	let identity = 0;
	const coordinator = new BodyCoordinator(undefined, () => `doc-${++identity}`);
	const old = coordinator.capture("body-a");
	assert.equal(old.bodyEpoch, 1);
	const fresh = coordinator.installSemanticEpoch("body-a", 2);
	assert.equal(fresh.bodyEpoch, 2);
	assert.notEqual(fresh.docIdentity, old.docIdentity);
	assert.equal(coordinator.isCurrent(old), false);
	assert.equal(coordinator.snapshot("body-a")?.bodyEpoch, 2);
	assert.throws(() => coordinator.installSemanticEpoch("body-a", 2), /advance monotonically/);
});

s.test("root transition replaces the replication-only root without merging old structs", () => {
	const oldRoot = new Y.Doc({ guid: "old-root" });
	oldRoot.getMap<string>("pathToId").set("dead.md", "dead-body");
	const freshRoot = new Y.Doc({ guid: "fresh-root" });
	freshRoot.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	freshRoot.getMap<string>("pathToId").set("live.md", "live-body");
	const transition = prepareRootSemanticEpochTransition({
		previousRootEpoch: 7,
		nextRootEpoch: 8,
		authoritativeEncodedState: Y.encodeStateAsUpdate(freshRoot),
	});
	try {
		assert.equal(transition.rootEpoch, 8);
		assert.equal(transition.document.getMap("pathToId").has("dead.md"), false);
		assert.equal(transition.document.getMap("pathToId").get("live.md"), "live-body");
	} finally {
		transition.document.destroy();
		oldRoot.destroy();
		freshRoot.destroy();
	}
});

await s.done();
