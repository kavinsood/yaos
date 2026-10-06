/**
 * Relay v2 spike §5.5: the client fresh-doc builder is equivalent to the
 * server's semantic reset (`prepareSemanticReset` on the real ywasm engine).
 */
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { prepareSemanticReset } from "../../server/src/semanticCompaction";
import { canonicalMarkdownHash } from "../../server/src/shared/markdownCodec";
import { buildFreshSnapshot, buildFreshSnapshotFromContent, documentCensus, lineageCoverUpdate, semanticResetOperations } from "../../scripts/relay2/reset/builder";
import { stateVectorCoveredBy, stateVectorFromUpdate } from "../../server/src/crdt/ywasmByteOps";
import { bloatedDoc } from "../../scripts/relay2/reset/bloat";
import { suite } from "../harness.ts";

const s = suite("relay2-reset-builder");

async function assertEquivalent(doc: Y.Doc, label: string) {
	const state = Y.encodeStateAsUpdate(doc);
	const client = await buildFreshSnapshot(doc);
	const serverDoc = crdtEngine.openDocument(doc.guid, state);
	const server = prepareSemanticReset(serverDoc, "body");
	const serverText = crdtEngine.readText(server.document, "body");
	const reopened = crdtEngine.openDocument(doc.guid, client.snapshot);
	// Compare wire-to-wire: both snapshots reopened by the server engine.
	const serverWire = crdtEngine.openDocument(doc.guid, crdtEngine.encodeStateAsUpdate(server.document));
	try {
		s.check(serverText === client.content, `${label}: same body text`);
		s.check((await canonicalMarkdownHash(serverText)) === client.contentHash, `${label}: same content hash`);
		s.check(isDeepStrictEqual(crdtEngine.snapshotRoots(reopened), crdtEngine.snapshotRoots(serverWire)),
			`${label}: same root snapshot (server engine reading the client snapshot)`);
		s.check(server.previous.totalStructs === client.before.totalStructs
			&& server.previous.deletedStructs === client.before.deletedStructs
			&& server.previous.encodedStateBytes === client.before.encodedStateBytes, `${label}: same before-census`);
		s.check(server.fresh.totalStructs === client.after.totalStructs && client.after.deletedStructs === 0,
			`${label}: same fresh struct count, zero deleted`);
		s.check(Math.abs(server.fresh.encodedStateBytes - client.after.encodedStateBytes) <= 16,
			`${label}: fresh size within client-id varint slack (${client.after.encodedStateBytes} vs ${server.fresh.encodedStateBytes})`);
	} finally {
		crdtEngine.destroyDocument(reopened);
		crdtEngine.destroyDocument(serverWire);
		crdtEngine.destroyDocument(server.document);
		crdtEngine.destroyDocument(serverDoc);
	}
	return client;
}

s.test("bloated body with frontmatter roots: builder == server reset", async () => {
	const doc = bloatedDoc({ guid: "builder-bloat", edits: 6_000, seed: 7 });
	const fresh = await assertEquivalent(doc, "bloat");
	s.check(fresh.after.totalStructs < fresh.before.totalStructs / 50, "fresh doc drops history structs");
	s.check(fresh.snapshot.byteLength < fresh.before.encodedStateBytes / 2, "fresh upload is much smaller than the bloated state");
	doc.destroy();
});

s.test("CRLF + BOM body is canonicalized identically", async () => {
	const doc = new Y.Doc({ guid: "builder-crlf" });
	doc.getText("body").insert(0, "﻿line one\r\nline two\r\n\r\nend");
	const fresh = await assertEquivalent(doc, "crlf");
	s.check(!fresh.content.includes("\r"), "canonical content has no CR");
	doc.destroy();
});

s.test("wire-only (never accessed) roots are resolved like the server", async () => {
	const producer = bloatedDoc({ guid: "builder-wire", edits: 500, seed: 3 });
	const wire = new Y.Doc({ guid: "builder-wire" });
	Y.applyUpdate(wire, Y.encodeStateAsUpdate(producer));
	// No getText/getMap on `wire`: every root is an undefined AbstractType.
	await assertEquivalent(wire, "wire-only");
	producer.destroy();
	wire.destroy();
});

s.test("empty body", async () => {
	const doc = new Y.Doc({ guid: "builder-empty" });
	doc.getText("body");
	await assertEquivalent(doc, "empty");
	doc.destroy();
});

s.test("invalid frontmatter root is rejected by both", async () => {
	const doc = new Y.Doc({ guid: "builder-invalid" });
	doc.getText("body").insert(0, "x");
	doc.getMap("frontmatter:bogus").set("k", 1);
	let clientError = "";
	let serverError = "";
	try { await buildFreshSnapshot(doc); } catch (error) { clientError = String(error); }
	const serverDoc = crdtEngine.openDocument(doc.guid, Y.encodeStateAsUpdate(doc));
	try { prepareSemanticReset(serverDoc, "body"); } catch (error) { serverError = String(error); }
	crdtEngine.destroyDocument(serverDoc);
	s.check(clientError !== "" && serverError !== "", `both reject (client: ${clientError.slice(0, 60)} | server: ${serverError.slice(0, 60)})`);
	doc.destroy();
});

s.test("operations and content-seeded build agree with doc build", async () => {
	const doc = bloatedDoc({ guid: "builder-content", edits: 800, seed: 11 });
	const ops = semanticResetOperations(doc);
	s.check(ops.some((op) => op.kind === "text-replace" && op.root === "body"), "body → text-replace");
	const fromDoc = await buildFreshSnapshot(doc);
	const fromContent = await buildFreshSnapshotFromContent(doc.guid, doc.getText("body").toJSON(), (scratch) => {
		scratch.getMap<number>("frontmatter:meta").set("format", 1);
		scratch.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "bloat" });
	});
	const reopened = new Y.Doc();
	Y.applyUpdate(reopened, fromContent.snapshot);
	s.check(isDeepStrictEqual(reopened.getMap("frontmatter:registers").toJSON(), doc.getMap("frontmatter:registers").toJSON()), "content path carries seeded roots");
	reopened.destroy();
	s.check(fromContent.contentHash === fromDoc.contentHash, "same hash from content path");
	const census = documentCensus(doc);
	s.check(census.encodedStateBytes === fromDoc.before.encodedStateBytes, "documentCensus matches builder before-census");
	doc.destroy();
});

s.test("lineage cover: snapshot SV covers the old head (relay snapshotCoversHead) without old content", async () => {
	const doc = bloatedDoc({ guid: "builder-cover", edits: 3_000, seed: 12 });
	const headSv = Y.encodeStateVector(doc);
	const plain = await buildFreshSnapshot(doc);
	const covered = await buildFreshSnapshot(doc, { coverStateVector: headSv });
	// Exactly the deployed server's check (ywasm stateless SV + coverage).
	s.check(!stateVectorCoveredBy(headSv, stateVectorFromUpdate(plain.snapshot)), "plain fresh snapshot fails the server's coverage check");
	s.check(stateVectorCoveredBy(headSv, stateVectorFromUpdate(covered.snapshot)), "covered snapshot passes it");
	s.check(covered.content === plain.content && covered.contentHash === plain.contentHash, "same canonical content and hash");
	const clients = Y.decodeStateVector(headSv).size;
	const overhead = covered.snapshot.byteLength - plain.snapshot.byteLength;
	s.check(overhead > 0 && overhead <= clients * 16 && lineageCoverUpdate(headSv).byteLength <= clients * 16 + 2, `overhead ${overhead} B for ${clients} old clients`);
	const reopened = crdtEngine.openDocument(doc.guid, covered.snapshot);
	s.check(crdtEngine.readText(reopened, "body") === plain.content, "ywasm reads the same body from the covered snapshot");
	crdtEngine.destroyDocument(reopened);
	// A leaked old-lineage update (made on the old doc) is a no-op on the covered lineage.
	const before = Y.encodeStateVector(doc);
	doc.getText("body").insert(10, "[LEAK]");
	const leaked = Y.encodeStateAsUpdate(doc, before);
	const target = new Y.Doc({ guid: doc.guid });
	Y.applyUpdate(target, covered.snapshot);
	Y.applyUpdate(target, leaked);
	s.check(!target.getText("body").toJSON().includes("[LEAK]") && target.getText("body").toJSON() === plain.content,
		"leaked old-epoch insert does not resurface on the covered lineage");
	target.destroy();
	doc.destroy();
});

await s.done();
