import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cloudflareRoot = new URL("../../../../excalidraw-cloudflare/", import.meta.url);

function copy(value) {
	return structuredClone(value);
}

function compareNativeRevision(left, right) {
	if (left.version !== right.version) {
		return left.version - right.version;
	}
	return (right.versionNonce ?? 0) - (left.versionNonce ?? 0);
}

function compareCloudflareRevision(left, right) {
	if (left.version !== right.version) return left.version - right.version;
	return (left.versionNonce ?? 0) - (right.versionNonce ?? 0);
}

function sortLikeCloudflare(elements) {
	return [...elements].sort((left, right) => {
		const leftIndex = left.index ?? "";
		const rightIndex = right.index ?? "";
		return leftIndex < rightIndex ? -1 : leftIndex > rightIndex ? 1 : 0;
	});
}

function sortWithCollisionFallback(elements) {
	return [...elements].sort((left, right) => {
		const byIndex = (left.index ?? "").localeCompare(right.index ?? "");
		return byIndex || left.id.localeCompare(right.id);
	});
}

function mergeLikeCloudflare(localElements, remoteElements) {
	const updated = copy(localElements);
	let changed = false;

	for (const remoteElement of remoteElements) {
		const localIndex = updated.findIndex((element) => element.id === remoteElement.id);
		if (localIndex === -1) {
			updated.push(copy(remoteElement));
			changed = true;
			continue;
		}

		if (compareCloudflareRevision(remoteElement, updated[localIndex]) > 0) {
			updated[localIndex] = copy(remoteElement);
			changed = true;
		}
	}

	return {
		changed,
		elements: changed ? sortLikeCloudflare(updated) : updated,
	};
}

class StrictVersionStore {
	rows = new Map();

	upsert(element) {
		const current = this.rows.get(element.id);
		if (current && current.version >= element.version) {
			return false;
		}
		this.rows.set(element.id, copy(element));
		return true;
	}

	removeRow(elementId) {
		this.rows.delete(elementId);
	}
}

class RevisionStore {
	rows = new Map();
	deletionFences = new Map();

	upsert(element) {
		const current = this.rows.get(element.id);
		const fence = this.deletionFences.get(element.id);
		if (current && compareNativeRevision(element, current) <= 0) {
			return false;
		}
		if (fence && compareNativeRevision(element, fence) <= 0) {
			return false;
		}
		this.rows.set(element.id, copy(element));
		if (element.isDeleted) {
			this.deletionFences.set(element.id, {
				version: element.version,
				versionNonce: element.versionNonce,
			});
		}
		return true;
	}

	compactDeletedRow(elementId) {
		assert.equal(this.rows.get(elementId)?.isDeleted, true);
		this.rows.delete(elementId);
	}
}

class ExcalidrawApiHarness {
	constructor(elements = [], appState = {}) {
		this.elements = copy(elements);
		this.appState = copy(appState);
		this.collaborators = new Map();
		this.updates = [];
	}

	getSceneElementsIncludingDeleted() {
		return copy(this.elements);
	}

	getAppState() {
		return copy(this.appState);
	}

	updateScene(update) {
		this.updates.push(copyUpdate(update));
		if (update.elements) {
			this.elements = copy(update.elements);
		}
		if (update.appState) {
			this.appState = copy(update.appState);
		}
		if (update.collaborators) {
			this.collaborators = new Map(update.collaborators);
		}
	}
}

function copyUpdate(update) {
	return {
		...(update.elements ? { elements: copy(update.elements) } : {}),
		...(update.appState ? { appState: copy(update.appState) } : {}),
		...(update.collaborators ? { collaborators: new Map(update.collaborators) } : {}),
	};
}

function applyRemote(api, remoteElements) {
	const result = mergeLikeCloudflare(
		api.getSceneElementsIncludingDeleted(),
		remoteElements,
	);
	if (result.changed) {
		api.updateScene({ elements: result.elements });
	}
	return result;
}

function captureLikeCloudflare(elements, versionById) {
	const queued = new Map();
	for (const element of elements) {
		const previousVersion = versionById.get(element.id);
		if (!previousVersion || previousVersion !== element.version) {
			queued.set(element.id, copy(element));
			versionById.set(element.id, element.version);
		}
	}
	return queued;
}

function makeRectangle(overrides = {}) {
	return {
		id: "rectangle",
		type: "rectangle",
		x: 10,
		y: 10,
		width: 100,
		height: 80,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		index: "a0",
		roundness: null,
		seed: 1,
		version: 1,
		versionNonce: 10,
		isDeleted: false,
		boundElements: [],
		updated: 1,
		link: null,
		locked: false,
		...overrides,
	};
}

function makeArrow(overrides = {}) {
	return {
		id: "arrow",
		type: "arrow",
		x: 0,
		y: 0,
		width: 10,
		height: 10,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		index: "a1",
		roundness: null,
		seed: 2,
		version: 1,
		versionNonce: 11,
		isDeleted: false,
		boundElements: null,
		updated: 1,
		link: null,
		locked: false,
		points: [[0, 0], [10, 10]],
		startBinding: {
			elementId: "rectangle",
			focus: 0,
			gap: 1,
		},
		endBinding: null,
		startArrowhead: null,
		endArrowhead: "arrow",
		elbowed: false,
		...overrides,
	};
}

function bindingErrors(elements) {
	const byId = new Map(elements.map((element) => [element.id, element]));
	const errors = [];
	for (const element of elements) {
		if (element.isDeleted) {
			continue;
		}
		for (const side of ["startBinding", "endBinding"]) {
			const binding = element[side];
			if (binding && (byId.get(binding.elementId)?.isDeleted ?? true)) {
				errors.push(`${element.id}.${side} targets missing/deleted ${binding.elementId}`);
			}
		}
		for (const bound of element.boundElements ?? []) {
			const reverse = byId.get(bound.id);
			const pointsBack = reverse && [reverse.startBinding, reverse.endBinding]
				.some((binding) => binding?.elementId === element.id);
			if (!pointsBack) {
				errors.push(`${element.id}.boundElements has non-reciprocal ${bound.id}`);
			}
		}
	}
	return errors;
}

test("complete records capture native tombstones", () => {
	const tracker = new Map([["rectangle", 1]]);
	const deleted = makeRectangle({
		version: 2,
		versionNonce: 20,
		isDeleted: true,
		updated: 2,
	});
	const queued = captureLikeCloudflare([deleted], tracker);
	assert.equal(queued.size, 1);
	assert.deepEqual(queued.get("rectangle"), deleted);
	assert.equal(queued.get("rectangle").isDeleted, true);
});

test("the imperative API seam can apply complete remote records", () => {
	const api = new ExcalidrawApiHarness([makeRectangle()]);
	const remote = makeRectangle({ version: 2, versionNonce: 20, x: 500 });
	const result = applyRemote(api, [remote]);
	assert.equal(result.changed, true);
	assert.equal(api.updates.length, 1);
	assert.equal(api.getSceneElementsIncludingDeleted()[0].x, 500);
});

test("strict server versioning splits equal-version nonce winners", () => {
	const server = new StrictVersionStore();
	const peerA = makeRectangle({ version: 7, versionNonce: 100, x: 100 });
	const peerB = makeRectangle({ version: 7, versionNonce: 200, x: 200 });

	assert.equal(server.upsert(peerA), true);
	assert.equal(server.upsert(peerB), false);

	const peerBAfterServerState = mergeLikeCloudflare([peerB], [server.rows.get("rectangle")]);
	const lateJoiner = server.rows.get("rectangle");
	assert.equal(peerBAfterServerState.elements[0].x, 200);
	assert.equal(lateJoiner.x, 100);
	assert.notDeepEqual(peerBAfterServerState.elements[0], lateJoiner);
});

test("the upstream lower-nonce comparator converges all peers", () => {
	const server = new RevisionStore();
	const peerA = makeRectangle({ version: 7, versionNonce: 100, x: 100 });
	const peerB = makeRectangle({ version: 7, versionNonce: 200, x: 200 });

	assert.equal(server.upsert(peerB), true);
	assert.equal(server.upsert(peerA), true);
	const winner = server.rows.get("rectangle");
	assert.equal(winner.x, 100);
	assert.ok(compareNativeRevision(winner, peerB) > 0);
	assert.equal(compareNativeRevision(peerB, winner) < 0, true);
});

test("version-only capture intentionally suppresses same-version nonce changes", () => {
	const tracker = new Map([["rectangle", 7]]);
	const changed = makeRectangle({ version: 7, versionNonce: 200, x: 200 });
	assert.equal(captureLikeCloudflare([changed], tracker).size, 0);
});

test("discarding a tombstone permits stale resurrection", () => {
	const server = new StrictVersionStore();
	const live = makeRectangle({ version: 1, versionNonce: 10 });
	const deleted = makeRectangle({ version: 2, versionNonce: 20, isDeleted: true });
	assert.equal(server.upsert(live), true);
	assert.equal(server.upsert(deleted), true);
	server.removeRow("rectangle");
	assert.equal(server.upsert(live), true);
	assert.equal(server.rows.get("rectangle").isDeleted, false);
});

test("a compact deletion fence prevents stale resurrection", () => {
	const server = new RevisionStore();
	const live = makeRectangle({ version: 1, versionNonce: 10 });
	const deleted = makeRectangle({ version: 2, versionNonce: 20, isDeleted: true });
	assert.equal(server.upsert(live), true);
	assert.equal(server.upsert(deleted), true);
	server.compactDeletedRow("rectangle");
	assert.equal(server.upsert(live), false);
	assert.equal(server.rows.has("rectangle"), false);
});

test("per-element delivery tears reciprocal binding invariants in either order", () => {
	const target = makeRectangle({
		boundElements: [{ id: "arrow", type: "arrow" }],
	});
	const arrow = makeArrow();
	const deletedTarget = makeRectangle({
		version: 2,
		versionNonce: 20,
		isDeleted: true,
		boundElements: [],
	});
	const detachedArrow = makeArrow({
		version: 2,
		versionNonce: 21,
		startBinding: null,
	});

	assert.deepEqual(bindingErrors([target, arrow]), []);

	const targetFirst = mergeLikeCloudflare([target, arrow], [deletedTarget]).elements;
	assert.notDeepEqual(bindingErrors(targetFirst), []);
	assert.deepEqual(
		bindingErrors(mergeLikeCloudflare(targetFirst, [detachedArrow]).elements),
		[],
	);

	const arrowFirst = mergeLikeCloudflare([target, arrow], [detachedArrow]).elements;
	assert.notDeepEqual(bindingErrors(arrowFirst), []);
	assert.deepEqual(
		bindingErrors(mergeLikeCloudflare(arrowFirst, [deletedTarget]).elements),
		[],
	);

	const atomic = mergeLikeCloudflare([target, arrow], [deletedTarget, detachedArrow]).elements;
	assert.deepEqual(bindingErrors(atomic), []);
});

test("fractional indices preserve order when unique", () => {
	const elements = [
		makeRectangle({ id: "last", index: "aV" }),
		makeRectangle({ id: "first", index: "a0" }),
		makeRectangle({ id: "middle", index: "aM" }),
	];
	assert.deepEqual(sortLikeCloudflare(elements).map(({ id }) => id), [
		"first",
		"middle",
		"last",
	]);
});

test("equal fractional indices retain divergent input order", () => {
	const alpha = makeRectangle({ id: "alpha", index: "a0" });
	const beta = makeRectangle({ id: "beta", index: "a0" });
	assert.deepEqual(sortLikeCloudflare([alpha, beta]).map(({ id }) => id), ["alpha", "beta"]);
	assert.deepEqual(sortLikeCloudflare([beta, alpha]).map(({ id }) => id), ["beta", "alpha"]);
	assert.deepEqual(sortWithCollisionFallback([alpha, beta]).map(({ id }) => id), ["alpha", "beta"]);
	assert.deepEqual(sortWithCollisionFallback([beta, alpha]).map(({ id }) => id), ["alpha", "beta"]);
});

test("native collaborator and follow seams fit an ephemeral presence adapter", () => {
	const api = new ExcalidrawApiHarness([], {
		userToFollow: { socketId: "session-b" },
		followedBy: new Set(),
	});
	const collaborators = new Map([
		["session-b", {
			id: "actor-b",
			socketId: "session-b",
			username: "Peer B",
			pointer: { x: 45, y: 90, tool: "laser", renderCursor: true },
			button: "down",
			color: { background: "#ffe3e3", stroke: "#c92a2a" },
			isCurrentUser: false,
		}],
	]);
	api.updateScene({ collaborators });
	api.updateScene({
		appState: {
			...api.getAppState(),
			scrollX: -200,
			scrollY: -100,
			zoom: { value: 1.5 },
		},
	});
	assert.equal(api.collaborators.get("session-b").pointer.tool, "laser");
	assert.equal(api.getAppState().userToFollow.socketId, "session-b");
	assert.equal(api.getAppState().zoom.value, 1.5);
});

test("presence keyed by actor identity overwrites a second device session", () => {
	const keyedByActor = new Map();
	keyedByActor.set("actor-a", { sessionId: "desktop", x: 10 });
	keyedByActor.set("actor-a", { sessionId: "tablet", x: 20 });
	assert.equal(keyedByActor.size, 1);
	assert.equal(keyedByActor.get("actor-a").sessionId, "tablet");

	const keyedBySession = new Map();
	keyedBySession.set("desktop", { actorId: "actor-a", x: 10 });
	keyedBySession.set("tablet", { actorId: "actor-a", x: 20 });
	assert.equal(keyedBySession.size, 2);
});

test("the modeled behavior remains anchored to excalidraw-cloudflare source", async () => {
	const client = await readFile(
		new URL("src/client/pages/DrawingPage.tsx", cloudflareRoot),
		"utf8",
	);
	const worker = await readFile(
		new URL("src/worker/drawing.ts", cloudflareRoot),
		"utf8",
	);

	assert.match(client, /sendElementUpdate\(\[element\]\)/);
	assert.match(client, /previousVersion !== element\.version/);
	assert.match(client, /remoteNonce > localNonce/);
	assert.match(client, /getSceneElementsIncludingDeleted\(\)/);
	assert.match(client, /excalidrawAPI\.updateScene\(\{ elements: updatedElements \}\)/);
	assert.match(client, /onPointerUpdate=\{throttledPointerUpdate\}/);
	assert.match(client, /collaborators: newCollaborators/);
	assert.match(worker, /WHERE version < excluded\.version/);
	assert.match(worker, /this\.connectedUsers\.set\(userId, connectedUser\)/);
});
