import { strict as assert } from "node:assert";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { VaultRuntime } from "../../server/src/server";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../../server/src/shared/socketCloseCodes";
import type { VaultActorContext } from "../../server/src/collaboration";
import type { SemanticCatalogHead } from "../../server/src/vaultStore";
import {
	VaultSocketService,
	type VaultSocketAttachment,
	type VaultSocketPort,
	type VaultSocketRegistryPort,
} from "../../server/src/vaultSocketService";
import { suite } from "../harness.ts";

const s = suite("vault-socket-semantic-races");

const actor: VaultActorContext = {
	vaultId: "vault-socket-races",
	vaultGeneration: "generation-socket-races",
	principalId: "principal-socket-races",
	membershipRevision: 1,
	deviceId: "device-socket-races",
	deviceCredentialRevision: 1,
	role: "member",
	policyVersion: 1,
	capabilityDigest: "capability-socket-races",
};

const documentId = "canvas-socket-races";
const attachment: VaultSocketAttachment = {
	...actor,
	runtimeEpoch: "runtime-socket-races",
	documentId,
	kind: "semantic",
	documentEpoch: 1,
	socketId: "socket-semantic-races",
};

const activeHead: SemanticCatalogHead = {
	sequence: 3,
	documentId,
	fileId: documentId,
	kind: "canvas",
	format: "json-canvas",
	formatVersion: 1,
	path: "Board.canvas",
	previousPath: null,
	lifecycle: "active",
	generation: 1,
	bodyEpoch: 1,
	contentHash: "a".repeat(64),
	size: 24,
};

function registry(sockets: readonly VaultSocketPort[]): VaultSocketRegistryPort {
	return {
		sockets: () => sockets,
		createPair: () => { throw new Error("socket allocation is outside this test"); },
		accept: () => { throw new Error("socket acceptance is outside this test"); },
		upgradeResponse: () => { throw new Error("socket upgrade is outside this test"); },
	};
}

function updateFrame(update = new Uint8Array([1, 2, 3])): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	syncProtocol.writeUpdate(encoder, update);
	return encoding.toUint8Array(encoder).slice().buffer;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

s.test("revocation during asynchronous Canvas validation cannot reach the pending queue", async () => {
	const entered = deferred();
	const resume = deferred();
	let allowed = true;
	let discarded = 0;
	let queued = 0;
	let staged = 0;
	let flushes = 0;
	let close: { code: number; reason: string } | null = null;
	const sent: string[] = [];
	const socket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: (value) => { if (typeof value === "string") sent.push(value); },
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		sockets: registry([socket]),
		cache: {
			serializeDocument: async (_id: string, operation: () => Promise<void>) => operation(),
			load: () => ({ semanticEpoch: 1 }),
			validateCanvasUpdate: async () => {
				entered.resolve();
				await resume.promise;
				return { changesState: true, requiresDurableCommit: true,
					contentBytes: new TextEncoder().encode("canvas"), encodedStateBytes: 12, exactEncodedStateBytes: true };
			},
			discardValidatedBodyUpdate: () => { discarded++; },
			stageValidatedBodyUpdate: () => { staged++; },
			queue: () => { queued++; return { ok: true }; },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => false,
		isActiveSemantic: () => true,
		currentSemanticHead: () => activeHead,
		currentSemanticEpoch: () => 1,
		currentBodyHead: () => null,
		currentSequence: () => 3,
		validateActor: () => allowed,
		principalPresence: () => null,
		scheduleFlush: () => { flushes++; },
	} as never);
	const pending = service.message(socket, updateFrame());
	await entered.promise;
	allowed = false;
	resume.resolve();
	await pending;
	assert.equal(discarded, 1);
	assert.equal(queued, 0);
	assert.equal(staged, 0);
	assert.equal(flushes, 0);
	assert.deepEqual(close, { code: AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason: "socket authority superseded" });
	assert.equal(JSON.parse(sent[0]!.slice(6)).code, "authority_superseded");
});

s.test("semantic deletion during asynchronous Canvas validation cannot reach the pending queue", async () => {
	const entered = deferred();
	const resume = deferred();
	let head: SemanticCatalogHead = activeHead;
	let discarded = 0;
	let queued = 0;
	let close: { code: number; reason: string } | null = null;
	const sent: string[] = [];
	const socket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: (value) => { if (typeof value === "string") sent.push(value); },
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		sockets: registry([socket]),
		cache: {
			serializeDocument: async (_id: string, operation: () => Promise<void>) => operation(),
			load: () => ({ semanticEpoch: 1 }),
			validateCanvasUpdate: async () => {
				entered.resolve();
				await resume.promise;
				return { changesState: true, requiresDurableCommit: true,
					contentBytes: new TextEncoder().encode("canvas"), encodedStateBytes: 12, exactEncodedStateBytes: true };
			},
			discardValidatedBodyUpdate: () => { discarded++; },
			queue: () => { queued++; return { ok: true }; },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => false,
		isActiveSemantic: () => head.lifecycle === "active",
		currentSemanticHead: () => head,
		currentSemanticEpoch: () => 1,
		currentBodyHead: () => null,
		currentSequence: () => head.sequence,
		validateActor: () => true,
		principalPresence: () => null,
		scheduleFlush: () => {},
	} as never);
	const pending = service.message(socket, updateFrame());
	await entered.promise;
	head = { ...activeHead, sequence: 4, lifecycle: "tombstoned" };
	resume.resolve();
	await pending;
	assert.equal(discarded, 1);
	assert.equal(queued, 0);
	assert.deepEqual(close, { code: 1008, reason: "semantic document is not active" });
	assert.equal(JSON.parse(sent[0]!.slice(6)).code, "semantic_document_not_active");
});

interface FlushProbe {
	flushDocument(documentId: string): Promise<boolean>;
}

function flushRuntime(input: {
	currentSemanticHead: () => SemanticCatalogHead;
	semanticCatalogForUpdate?: () => Promise<unknown>;
	validateActor?: () => "allowed" | "authority_superseded";
	onCommit: (value: Record<string, unknown>) => never;
}): { runtime: FlushProbe; events: string[] } {
	const events: string[] = [];
	let taken = false;
	const runtime = Object.create(VaultRuntime.prototype) as FlushProbe;
	Object.defineProperties(runtime, {
		cache: { value: {
			serializeDocument: async (_id: string, operation: () => Promise<void>) => operation(),
			takePending: () => {
				if (taken) return [];
				taken = true;
				return [{ bytes: new Uint8Array([1, 2, 3]), digest: "b".repeat(64), socketId: attachment.socketId,
					actor, kind: "semantic", documentEpoch: 1, semanticHead: activeHead,
					contentHash: "c".repeat(64), contentSize: 24 }];
			},
			reloadFromDurable: () => { events.push("reload"); },
			clear: () => { events.push("clear"); },
		} },
		store: { value: {
			validateActor: () => input.validateActor?.() ?? "allowed",
			currentSequence: () => input.currentSemanticHead().sequence,
			documentHead: () => ({ generation: 1, semanticEpoch: 1, latestSequence: 2 }),
			semanticHeadAt: () => input.currentSemanticHead(),
			commitUpdate: input.onCommit,
		} },
		sockets: { value: {
			closeUndurableOrigins: (_id: string, entries: Array<{ socketId: string }>) => {
				events.push(`close:${entries.map((entry) => entry.socketId).join(",")}`);
			},
			closeAll: () => { events.push("close-all"); },
		} },
		lifecycle: { value: { activeBodyHead: () => { throw new Error("semantic queue was reclassified as body"); } } },
		semanticCompaction: { value: { recordCommit: async () => {} } },
		options: { value: { execution: { waitUntil: () => {} }, alarms: { setAlarm: async () => { events.push("alarm"); } } } },
		persistence: { value: new Map() },
		flushChain: { value: Promise.resolve(), writable: true },
		...(input.semanticCatalogForUpdate ? { semanticCatalogForUpdate: { value: input.semanticCatalogForUpdate } } : {}),
	});
	return { runtime, events };
}

s.test("a queued semantic frame is rejected after lifecycle deletion instead of becoming a body commit", async () => {
	let commits = 0;
	const tombstoned = { ...activeHead, sequence: 4, lifecycle: "tombstoned" as const };
	const harness = flushRuntime({
		currentSemanticHead: () => tombstoned,
		onCommit: () => { commits++; throw new Error("must not commit"); },
	});
	assert.equal(await harness.runtime.flushDocument(documentId), false);
	assert.equal(commits, 0);
	assert.ok(harness.events.includes(`close:${attachment.socketId}`));
	assert.equal(harness.events.includes("alarm"), false);
});

s.test("lifecycle change during semantic flush is fenced by the frozen catalog head CAS", async () => {
	const entered = deferred();
	const resume = deferred();
	let head: SemanticCatalogHead = activeHead;
	let commitInput: Record<string, unknown> | null = null;
	const harness = flushRuntime({
		currentSemanticHead: () => head,
		semanticCatalogForUpdate: async () => {
			entered.resolve();
			await resume.promise;
			return { documentId, fileId: documentId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path: activeHead.path, previousPath: null, lifecycle: "active", documentGeneration: 2,
				contentHash: "c".repeat(64), size: 24 };
		},
		onCommit: (value) => {
			commitInput = value;
			if (head.sequence !== activeHead.sequence) throw new Error("semantic_catalog_head_changed");
			throw new Error("test expected the catalog CAS to reject");
		},
	});
	const pending = harness.runtime.flushDocument(documentId);
	await entered.promise;
	head = { ...activeHead, sequence: 4, lifecycle: "tombstoned" };
	resume.resolve();
	assert.equal(await pending, false);
	assert.equal((commitInput as Record<string, unknown> | null)?.kind, "semantic");
	assert.deepEqual((commitInput as Record<string, unknown> | null)?.expectedSemanticHead, activeHead);
	assert.ok(harness.events.includes(`close:${attachment.socketId}`));
	assert.equal(harness.events.includes("alarm"), false);
});

s.test("revocation during semantic flush is rejected by transactional actor attribution", async () => {
	const entered = deferred();
	const resume = deferred();
	let allowed = true;
	let commitInput: Record<string, unknown> | null = null;
	const harness = flushRuntime({
		currentSemanticHead: () => activeHead,
		validateActor: () => allowed ? "allowed" : "authority_superseded",
		semanticCatalogForUpdate: async () => {
			entered.resolve();
			await resume.promise;
			return { documentId, fileId: documentId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path: activeHead.path, previousPath: null, lifecycle: "active", documentGeneration: 2,
				contentHash: "c".repeat(64), size: 24 };
		},
		onCommit: (value) => {
			commitInput = value;
			if (!allowed) throw new Error("authority_superseded");
			throw new Error("test expected transactional authority rejection");
		},
	});
	const pending = harness.runtime.flushDocument(documentId);
	await entered.promise;
	allowed = false;
	resume.resolve();
	assert.equal(await pending, false);
	const observedCommit = commitInput as unknown as { actorAttributions: Array<{ actor: VaultActorContext }> };
	assert.deepEqual(observedCommit.actorAttributions[0]?.actor, actor);
	assert.ok(harness.events.includes("close-all"));
	assert.ok(harness.events.includes("clear"));
	assert.equal(harness.events.includes("alarm"), false);
});

await s.done();
