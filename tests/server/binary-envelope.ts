import { strict as assert } from "node:assert";
import {
	decodeBinaryEnvelope,
	encodeBinaryEnvelope,
	YAOS_BINARY_CONTENT_TYPE,
} from "../../server/src/shared/binaryEnvelope";
import { suite } from "../harness.ts";

const s = suite("binary-envelope");
const MAGIC = new Uint8Array([0x59, 0x41, 0x4f, 0x53, 0x42, 0x49, 0x4e, 0x31]);
const encoder = new TextEncoder();

function rawEnvelope(metadata: unknown, payload = new Uint8Array()): Uint8Array {
	const encodedMetadata = typeof metadata === "string" ? encoder.encode(metadata) : encoder.encode(JSON.stringify(metadata));
	const result = new Uint8Array(12 + encodedMetadata.byteLength + payload.byteLength);
	result.set(MAGIC);
	new DataView(result.buffer).setUint32(8, encodedMetadata.byteLength, false);
	result.set(encodedMetadata, 12);
	result.set(payload, 12 + encodedMetadata.byteLength);
	return result;
}

s.test("nested metadata and binary segments round-trip without source or sibling aliasing", () => {
	assert.equal(YAOS_BINARY_CONTENT_TYPE, "application/vnd.yaos.binary-envelope");
	const source = new Uint8Array(new Uint8Array([90, 1, 2, 3, 91]).buffer, 1, 3);
	const encoded = encodeBinaryEnvelope({
		integer: Number.MAX_SAFE_INTEGER,
		truth: true,
		nothing: null,
		omitted: undefined,
		values: [source, { again: source }],
	});
	source.fill(77);
	const decoded = decodeBinaryEnvelope(encoded) as {
		integer: number;
		truth: boolean;
		nothing: null;
		omitted?: unknown;
		values: [Uint8Array, { again: Uint8Array }];
	};
	assert.equal(decoded.integer, Number.MAX_SAFE_INTEGER);
	assert.equal(decoded.truth, true);
	assert.equal(decoded.nothing, null);
	assert.equal("omitted" in decoded, false);
	assert.deepEqual(decoded.values[0], new Uint8Array([1, 2, 3]));
	assert.deepEqual(decoded.values[1].again, new Uint8Array([1, 2, 3]));
	assert.notStrictEqual(decoded.values[0], decoded.values[1].again);
	decoded.values[0][0] = 99;
	assert.equal(decoded.values[1].again[0], 1);
	assert.deepEqual((decodeBinaryEnvelope(encoded) as { values: [Uint8Array] }).values[0], new Uint8Array([1, 2, 3]));
});

s.test("encode rejects lossy JSON values, cycles, and byte-limit overflow", () => {
	for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol("x"), () => undefined]) {
		assert.throws(() => encodeBinaryEnvelope(value), /unsupported binary envelope value/u);
	}
	const cycle: unknown[] = [];
	cycle.push(cycle);
	assert.throws(() => encodeBinaryEnvelope(cycle), /cyclic binary envelope value/u);
	assert.throws(() => encodeBinaryEnvelope({ nested: { $yaosBinary: 0 } }), /reserved key/u);
	const encoded = encodeBinaryEnvelope({ bytes: new Uint8Array([1, 2, 3]) });
	assert.throws(() => encodeBinaryEnvelope({ bytes: new Uint8Array([1, 2, 3]) }, encoded.byteLength - 1), /exceeds byte limit/u);
	assert.equal(encodeBinaryEnvelope({ bytes: new Uint8Array([1, 2, 3]) }, encoded.byteLength).byteLength, encoded.byteLength);
	assert.throws(() => decodeBinaryEnvelope(encoded, encoded.byteLength - 1), /invalid binary envelope size/u);
});

s.test("decode rejects corrupt framing, metadata, lengths, references, and trailing bytes", () => {
	const valid = encodeBinaryEnvelope({ bytes: new Uint8Array([7]) });
	assert.throws(() => decodeBinaryEnvelope(new Uint8Array(11)), /invalid binary envelope size/u);
	const wrongMagic = valid.slice();
	wrongMagic[0] = wrongMagic[0]! ^ 0xff;
	assert.throws(() => decodeBinaryEnvelope(wrongMagic), /invalid binary envelope magic/u);
	const truncatedMetadata = valid.slice(0, 13);
	new DataView(truncatedMetadata.buffer).setUint32(8, 100, false);
	assert.throws(() => decodeBinaryEnvelope(truncatedMetadata), /truncated binary envelope metadata/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope("{")), SyntaxError);
	const invalidUtf8 = new Uint8Array(13);
	invalidUtf8.set(MAGIC);
	new DataView(invalidUtf8.buffer).setUint32(8, 1, false);
	invalidUtf8[12] = 0xff;
	assert.throws(() => decodeBinaryEnvelope(invalidUtf8), /encoded data was not valid/iu);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope([])), /invalid binary envelope metadata/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({ format: "future", lengths: [], value: null })), /unsupported binary envelope format/u);
	for (const length of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
		assert.throws(() => decodeBinaryEnvelope(rawEnvelope({ format: "yaos-binary-envelope-v1", lengths: [length], value: null })), /invalid binary envelope segment length/u);
	}
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({ format: "yaos-binary-envelope-v1", lengths: [], value: { $yaosBinary: 0 } })), /invalid binary envelope segment reference/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({ format: "yaos-binary-envelope-v1", lengths: [1], value: { $yaosBinary: -1 } }, new Uint8Array([1]))), /invalid binary envelope segment reference/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({
		format: "yaos-binary-envelope-v1",
		lengths: [1],
		value: [{ $yaosBinary: 0 }, { $yaosBinary: 0 }],
	}, new Uint8Array([1]))), /duplicate binary envelope segment reference/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({
		format: "yaos-binary-envelope-v1",
		lengths: [1],
		value: null,
	}, new Uint8Array([1]))), /unreferenced binary envelope segment/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({ format: "yaos-binary-envelope-v1", lengths: [], value: null }, new Uint8Array([1]))), /trailing bytes/u);
});

s.test("decode bounds hostile metadata depth and node count", () => {
	let deep: unknown = null;
	for (let index = 0; index < 65; index++) deep = [deep];
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({
		format: "yaos-binary-envelope-v1", lengths: [], value: deep,
	})), /too deeply nested/u);
	assert.throws(() => decodeBinaryEnvelope(rawEnvelope({
		format: "yaos-binary-envelope-v1", lengths: [], value: Array.from({ length: 100_000 }, () => null),
	})), /too complex/u);
});

await s.done();
