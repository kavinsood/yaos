import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const hash = (value) => createHash("sha256").update(value).digest("hex");

const makeDependencyGraph = (depth, branching) => {
	const graph = new Map();
	const add = (id, level) => {
		const children = level === depth
			? []
			: Array.from({ length: branching }, (_, index) => `${id}.${index}`);
		graph.set(id, {
			id,
			kind: level % 2 === 0 ? "drawing" : "markdown-note",
			body: level === depth && id.endsWith(".2") ? "PRIVATE back-of-card: launch codes" : `resource ${id}`,
			children,
		});
		for (const child of children) add(child, level + 1);
	};
	add("root", 0);
	return graph;
};

const recursivePublication = (graph, root) => {
	const published = new Map();
	const visit = (id) => {
		if (published.has(id)) return;
		const node = graph.get(id);
		if (!node) return;
		published.set(id, node);
		for (const child of node.children) visit(child);
	};
	visit(root);
	return published;
};

const validateManifest = (manifest) => {
	if (manifest.version !== 1 || typeof manifest.shareId !== "string" || typeof manifest.drawingId !== "string") {
		throw new Error("invalid_manifest_identity");
	}
	if (!Number.isSafeInteger(manifest.grantRevision) || manifest.grantRevision < 1) throw new Error("invalid_grant_revision");
	if (!Array.isArray(manifest.entries) || manifest.entries.length > 256) throw new Error("manifest_entry_limit");
	let totalBytes = 0;
	const ids = new Set();
	for (const entry of manifest.entries) {
		if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(entry.publicResourceId) || ids.has(entry.publicResourceId)) {
			throw new Error("invalid_resource_id");
		}
		if (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
			throw new Error("invalid_resource_metadata");
		}
		if ("vaultPath" in entry || "sourceDocumentId" in entry) throw new Error("private_locator_forbidden");
		ids.add(entry.publicResourceId);
		totalBytes += entry.bytes;
	}
	if (totalBytes > 25 * 1024 * 1024) throw new Error("manifest_byte_limit");
	return { ids, totalBytes };
};

const authorizeResource = (manifest, grant, request) => {
	if (grant.revoked || grant.revision !== manifest.grantRevision) return false;
	if (request.shareId !== manifest.shareId || request.drawingId !== manifest.drawingId) return false;
	return manifest.entries.some((entry) => entry.publicResourceId === request.publicResourceId && entry.hash === request.hash);
};

const started = performance.now();
const graph = makeDependencyGraph(7, 3);
const recursive = recursivePublication(graph, "root");
const leaked = [...recursive.values()].filter((node) => node.body.includes("PRIVATE"));
assert.ok(recursive.size > 1_000);
assert.ok(leaked.length > 0);

const approvedPreview = Buffer.from("sanitized immutable PNG preview of nested content");
const approvedImage = Buffer.from("approved pasted image");
const manifest = {
	version: 1,
	shareId: "share-public-1",
	drawingId: "drawing-public-1",
	grantRevision: 4,
	entries: [
		{ publicResourceId: "res-preview", hash: hash(approvedPreview), bytes: approvedPreview.byteLength, mimeType: "image/png" },
		{ publicResourceId: "res-image", hash: hash(approvedImage), bytes: approvedImage.byteLength, mimeType: "image/png" },
	],
};
const validated = validateManifest(manifest);
assert.equal(validated.ids.size, 2);
assert.equal(JSON.stringify(manifest).includes("PRIVATE"), false);
assert.equal(JSON.stringify(manifest).includes("root."), false);

const grant = { revision: 4, revoked: false };
assert.equal(authorizeResource(manifest, grant, {
	shareId: manifest.shareId,
	drawingId: manifest.drawingId,
	publicResourceId: "res-image",
	hash: hash(approvedImage),
}), true);
assert.equal(authorizeResource(manifest, grant, {
	shareId: manifest.shareId,
	drawingId: manifest.drawingId,
	publicResourceId: "res-image",
	hash: hash(Buffer.from("substituted")),
}), false);
assert.equal(authorizeResource(manifest, grant, {
	shareId: manifest.shareId,
	drawingId: "other-drawing",
	publicResourceId: "res-image",
	hash: hash(approvedImage),
}), false);
assert.equal(authorizeResource(manifest, { revision: 5, revoked: false }, {
	shareId: manifest.shareId,
	drawingId: manifest.drawingId,
	publicResourceId: "res-image",
	hash: hash(approvedImage),
}), false);

assert.throws(() => validateManifest({
	...manifest,
	entries: [{ ...manifest.entries[0], vaultPath: "Private/secret.md" }],
}), /private_locator_forbidden/);
assert.throws(() => validateManifest({
	...manifest,
	entries: Array.from({ length: 257 }, (_, index) => ({
		publicResourceId: `resource-${index}`,
		hash: hash(String(index)),
		bytes: 1,
		mimeType: "image/png",
	})),
}), /manifest_entry_limit/);

console.log(JSON.stringify({
	graph: { depth: 7, branching: 3, nodes: graph.size },
	recursivePublication: { publishedNodes: recursive.size, privateNotesLeaked: leaked.length },
	explicitPublication: { publishedResources: manifest.entries.length, privateLocators: 0, totalBytes: validated.totalBytes },
	securityChecks: {
		hashSubstitutionRejected: true,
		crossDrawingRejected: true,
		staleGrantRejected: true,
		privateLocatorRejected: true,
		manifestBoundsEnforced: true,
	},
	durationMs: Math.round((performance.now() - started) * 100) / 100,
}, null, 2));
