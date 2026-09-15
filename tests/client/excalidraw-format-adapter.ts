import { strict as assert } from "node:assert";
import LZString from "lz-string";
import { ExcalidrawFormatAdapter } from "../../src/sync/excalidraw/formatAdapter";
import { suite } from "../harness.ts";

const s = suite("excalidraw-format-adapter");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function scene(text = "hello") {
	return { type: "excalidraw", version: 2, source: "https://excalidraw.com", futureSceneField: { preserve: true },
		elements: [{ id: "element1", type: "text", version: 1, versionNonce: 100, isDeleted: false,
			index: "a0", text }], appState: { viewBackgroundColor: "#ffffff" }, files: {
			resource1: { id: "resource1", dataURL: "data:image/png;base64,YQ==", mimeType: "image/png", created: 1,
				futureFileField: "preserve" },
		} };
}

function markdown(payload: string, kind: "json" | "compressed-json" = "json", header = "back of card\n") {
	return `---\nexcalidraw-plugin: parsed\n---\n${header}# Excalidraw Data\n\n%%\n## Drawing\n\`\`\`${kind}\n${payload}\n\`\`\`\n%%`;
}

s.test("round-trips official JSON with tombstones, unknown scene fields, and binary metadata", async () => {
	const adapter = new ExcalidrawFormatAdapter();
	const input = { ...scene(), elements: [...scene().elements,
		{ id: "deleted1", type: "rectangle", version: 2, versionNonce: 90, isDeleted: true, index: "b0" }] };
	const parsed = await adapter.parse(encoder.encode(`${JSON.stringify(input)}\n`));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	assert.equal(parsed.value.elements[1]?.isDeleted, true);
	assert.deepEqual(parsed.value.auxiliary.sceneFields.futureSceneField, { preserve: true });
	assert.equal(parsed.value.files[0]?.futureFileField, "preserve");
	const output = adapter.materialize(parsed.value, parsed.value.elements, parsed.value.files);
	const reparsed = await adapter.parse(output);
	assert.equal(reparsed.kind, "valid");
	if (reparsed.kind === "valid") assert.equal(reparsed.value.canonicalSceneHash, parsed.value.canonicalSceneHash);
	assert.equal(decoder.decode(output).endsWith("\n"), true);
});

s.test("preserves the Markdown auxiliary container exactly while replacing only Drawing JSON", async () => {
	const adapter = new ExcalidrawFormatAdapter();
	const header = "private back-of-card prose\n<!-- excalidraw-markdown-image:resource1 -->\n\nlocal render\n\n<!-- /excalidraw-markdown-image:resource1 -->\n";
	const input = markdown(JSON.stringify(scene()), "json", header);
	const parsed = await adapter.parse(encoder.encode(input));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const changed = parsed.value.elements.map((element) => ({ ...element, version: 2, versionNonce: 80, text: "remote" }));
	const output = decoder.decode(adapter.materialize(parsed.value, changed, parsed.value.files));
	assert.equal(output.slice(0, parsed.value.auxiliary.prefix.length), parsed.value.auxiliary.prefix);
	assert.equal(output.endsWith(parsed.value.auxiliary.suffix), true);
	const reparsed = await adapter.parse(encoder.encode(output));
	assert.equal(reparsed.kind, "valid");
	if (reparsed.kind === "valid") assert.equal(reparsed.value.elements[0]?.text, "remote");
});

s.test("reads and writes the current plugin LZ-string compressed Markdown format", async () => {
	const adapter = new ExcalidrawFormatAdapter();
	const compressed = LZString.compressToBase64(JSON.stringify(scene()));
	const chunked = compressed.match(/.{1,256}/g)?.join("\n\n") ?? compressed;
	const parsed = await adapter.parse(encoder.encode(markdown(chunked, "compressed-json")));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	assert.equal(parsed.value.auxiliary.compressed, true);
	const output = adapter.materialize(parsed.value, parsed.value.elements, parsed.value.files);
	assert.match(decoder.decode(output), /```compressed-json\n/);
	const reparsed = await adapter.parse(output);
	assert.equal(reparsed.kind, "valid");
	if (reparsed.kind === "valid") assert.equal(reparsed.value.canonicalSceneHash, parsed.value.canonicalSceneHash);
});

s.test("fails closed for executable auxiliary content, invalid elements, and oversized containers", async () => {
	const adapter = new ExcalidrawFormatAdapter();
	const executable = await adapter.parse(encoder.encode(markdown(JSON.stringify(scene()), "json",
		"excalidraw-onload-script: Scripts/run.md\n")));
	assert.equal(executable.kind, "unsupported");
	const invalid = await adapter.parse(encoder.encode(JSON.stringify({ ...scene(), elements: [
		{ id: "bad", version: 0, versionNonce: 1, isDeleted: false },
	] })));
	assert.equal(invalid.kind, "invalid");
	const oversized = await adapter.parse(new Uint8Array(16 * 1024 * 1024 + 1));
	assert.equal(oversized.kind, "oversized");
});

await s.done();
