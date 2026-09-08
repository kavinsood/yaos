import * as Y from "yjs";
import {
	MARKDOWN_CANONICAL_VERSION,
	canonicalMarkdownBytes,
	canonicalMarkdownHash,
	canonicalizeMarkdown,
	prepareCanonicalMarkdown,
	exactMarkdownDiskFingerprint,
} from "../../server/src/shared/markdownCodec";
import {
	contentBaselineHash,
	currentContentHash,
	readDiskIndex,
	updateIndex,
} from "../../src/sync/diskIndex";
import { decodeVerifiedBodyContent, type ClientCatalogEntry } from "../../src/sync/bootstrapClient";
import { suite } from "../harness.ts";

const s = suite("markdown-codec");

s.section("canonical representation");
{
	const variants = ["alpha\nbeta\n", "alpha\r\nbeta\r\n", "alpha\rbeta\r", "\uFEFFalpha\r\nbeta\r\n"];
	for (const variant of variants) {
		s.check(canonicalizeMarkdown(variant) === "alpha\nbeta\n", "BOM and line endings normalize to LF");
	}
	s.check(canonicalizeMarkdown("") === "", "empty Markdown remains empty");
	s.check(canonicalizeMarkdown("line") === "line", "missing final newline is preserved");
	s.check(canonicalizeMarkdown("line\r\n") === "line\n", "present final newline is preserved");
	s.check(canonicalizeMarkdown("line  \r\n\t\r\n") === "line  \n\t\n", "trailing whitespace is preserved");
	s.check(canonicalizeMarkdown("e\u0301") === "e\u0301", "Unicode normalization is not performed");
	s.check(canonicalMarkdownBytes("\uFEFFa\r\n").byteLength === 2, "canonical bytes encode canonical text only");
	const prepared = prepareCanonicalMarkdown("\uFEFFa\r\n");
	s.check(prepared.content === "a\n" && prepared.bytes.byteLength === 2, "canonical text and bytes are prepared together");
}

s.test("logical hashes ignore representation-only differences", async () => {
	const lf = await canonicalMarkdownHash("alpha\nbeta\n");
	const crlf = await canonicalMarkdownHash("\uFEFFalpha\r\nbeta\r\n");
	s.check(lf === crlf, "LF, CRLF, and BOM variants have one logical hash");
	s.check(await contentBaselineHash("alpha\rbeta\r") === lf, "disk baselines use the shared codec");
});

s.test("exact disk fingerprints retain byte evidence", async () => {
	const lf = await exactMarkdownDiskFingerprint("alpha\nbeta\n");
	const crlf = await exactMarkdownDiskFingerprint("alpha\r\nbeta\r\n");
	const bom = await exactMarkdownDiskFingerprint("\uFEFFalpha\nbeta\n");
	s.check(lf.hash !== crlf.hash && lf.bytes !== crlf.bytes, "CRLF remains distinct disk evidence");
	s.check(lf.hash !== bom.hash && lf.bytes !== bom.bytes, "BOM remains distinct disk evidence");
});

s.test("bootstrap verifies canonical and legacy metadata before canonicalizing", async () => {
	const rawContent = "\uFEFFalpha\r\nbeta\r\n";
	const canonicalContent = "alpha\nbeta\n";
	const doc = new Y.Doc({ guid: "body-canonical-cutover" });
	doc.getText("body").insert(0, rawContent);
	const state = {
		bodyId: doc.guid,
		bodyEpoch: 1,
		generation: 4,
		encodedState: Y.encodeStateAsUpdate(doc),
	};
	doc.destroy();
	const baseEntry: ClientCatalogEntry = {
		bodyId: state.bodyId,
		bodyEpoch: 1,
		fileId: state.bodyId,
		path: "Note.md",
		generation: 4,
		contentHash: null,
		size: null,
	};
	const canonicalBytes = canonicalMarkdownBytes(canonicalContent);
	const canonicalEntry = {
		...baseEntry,
		contentHash: await canonicalMarkdownHash(rawContent),
		size: canonicalBytes.byteLength,
	};
	const legacyFingerprint = await exactMarkdownDiskFingerprint(rawContent);
	const legacyEntry = {
		...baseEntry,
		contentHash: legacyFingerprint.hash,
		size: legacyFingerprint.bytes,
	};
	s.check(
		await decodeVerifiedBodyContent(canonicalEntry, state) === canonicalContent,
		"current canonical catalog metadata verifies",
	);
	s.check(
		await decodeVerifiedBodyContent(legacyEntry, state) === canonicalContent,
		"verified legacy exact-text metadata crosses into canonical text",
	);
});

s.section("baseline version cutover");
{
	const hash = "a".repeat(64);
	const parsed = readDiskIndex({
		legacy: { mtime: 1, size: 2, contentHash: hash },
		current: { mtime: 3, size: 4, contentHash: hash, contentHashVersion: MARKDOWN_CANONICAL_VERSION },
		future: { mtime: 5, size: 6, contentHash: hash, contentHashVersion: "markdown-v2" },
		invalid: { mtime: "bad", size: 1 },
	});
	s.check(parsed.legacy?.contentHash === undefined, "unversioned legacy baseline is invalidated");
	s.check(currentContentHash(parsed.current) === hash, "current canonical baseline remains authoritative");
	s.check(parsed.future?.contentHash === undefined, "unknown future baseline is invalidated");
	s.check(parsed.invalid === undefined, "malformed persisted entries are rejected");

	const advanced = updateIndex(parsed, new Map([["legacy", { mtime: 7, size: 8 }]]), {
		settledHashes: new Map([["legacy", hash]]),
	});
	s.check(currentContentHash(advanced.legacy) === hash, "newly settled baseline records the current version");
}

await s.done();
