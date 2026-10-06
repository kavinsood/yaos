const MAGIC = new Uint8Array([0x59, 0x41, 0x4f, 0x53, 0x42, 0x49, 0x4e, 0x31]); // YAOSBIN1
const HEADER_BYTES = MAGIC.byteLength + 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const MAX_SEGMENTS = 10_000;
const MAX_VALUE_NODES = 100_000;
const MAX_VALUE_DEPTH = 64;

export const YAOS_BINARY_CONTENT_TYPE = "application/vnd.yaos.binary-envelope";

type EncodedMarker = { $yaosBinary: number };

function transform(value: unknown, segments: Uint8Array[], ancestors: Set<object>): unknown {
	if (value instanceof Uint8Array) {
		if (segments.length >= MAX_SEGMENTS) throw new Error("binary envelope has too many segments");
		const copy = value.slice();
		const index = segments.push(copy) - 1;
		return { $yaosBinary: index } satisfies EncodedMarker;
	}
	if (value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isSafeInteger(value))) return value;
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("cyclic binary envelope value");
		ancestors.add(value);
		const result = value.map((entry) => transform(entry, segments, ancestors));
		ancestors.delete(value);
		return result;
	}
	if (value && typeof value === "object") {
		if (Object.prototype.hasOwnProperty.call(value, "$yaosBinary")) {
			throw new Error("binary envelope value uses a reserved key");
		}
		if (ancestors.has(value)) throw new Error("cyclic binary envelope value");
		ancestors.add(value);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) result[key] = transform(entry, segments, ancestors);
		}
		ancestors.delete(value);
		return result;
	}
	throw new Error("unsupported binary envelope value");
}

export function encodeBinaryEnvelope(value: unknown, maximumBytes = Number.MAX_SAFE_INTEGER): Uint8Array {
	const segments: Uint8Array[] = [];
	const transformed = transform(value, segments, new Set());
	const metadata = encoder.encode(JSON.stringify({ format: "yaos-binary-envelope-v1", lengths: segments.map((segment) => segment.byteLength), value: transformed }));
	const total = HEADER_BYTES + metadata.byteLength + segments.reduce((sum, segment) => sum + segment.byteLength, 0);
	if (total > maximumBytes) throw new Error("binary envelope exceeds byte limit");
	const output = new Uint8Array(total);
	output.set(MAGIC, 0);
	new DataView(output.buffer).setUint32(MAGIC.byteLength, metadata.byteLength, false);
	output.set(metadata, HEADER_BYTES);
	let offset = HEADER_BYTES + metadata.byteLength;
	for (const segment of segments) {
		output.set(segment, offset);
		offset += segment.byteLength;
	}
	return output;
}

function restore(
	value: unknown,
	segments: readonly Uint8Array[],
	usedSegments: Set<number>,
	budget: { nodes: number },
	depth = 0,
): unknown {
	budget.nodes++;
	if (budget.nodes > MAX_VALUE_NODES) throw new Error("binary envelope value is too complex");
	if (depth > MAX_VALUE_DEPTH) throw new Error("binary envelope value is too deeply nested");
	if (Array.isArray(value)) return value.map((entry) => restore(entry, segments, usedSegments, budget, depth + 1));
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 1 && entries[0]![0] === "$yaosBinary") {
			const index = entries[0]![1];
			if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= segments.length) {
				throw new Error("invalid binary envelope segment reference");
			}
			if (usedSegments.has(index as number)) throw new Error("duplicate binary envelope segment reference");
			usedSegments.add(index as number);
			return segments[index as number]!.slice();
		}
		return Object.fromEntries(entries.map(([key, entry]) =>
			[key, restore(entry, segments, usedSegments, budget, depth + 1)]));
	}
	return value;
}

export function decodeBinaryEnvelope(bytes: Uint8Array, maximumBytes = Number.MAX_SAFE_INTEGER): unknown {
	if (bytes.byteLength > maximumBytes || bytes.byteLength < HEADER_BYTES) throw new Error("invalid binary envelope size");
	if (MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error("invalid binary envelope magic");
	const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.byteLength, false);
	const metadataEnd = HEADER_BYTES + metadataLength;
	if (metadataEnd > bytes.byteLength) throw new Error("truncated binary envelope metadata");
	const parsed = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, metadataEnd))) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid binary envelope metadata");
	const record = parsed as Record<string, unknown>;
	if (record.format !== "yaos-binary-envelope-v1" || !Array.isArray(record.lengths) || !("value" in record)) {
		throw new Error("unsupported binary envelope format");
	}
	if (record.lengths.length > MAX_SEGMENTS) throw new Error("binary envelope has too many segments");
	const segments: Uint8Array[] = [];
	let offset = metadataEnd;
	for (const length of record.lengths) {
		if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > bytes.byteLength - offset) {
			throw new Error("invalid binary envelope segment length");
		}
		segments.push(bytes.subarray(offset, offset + (length as number)));
		offset += length as number;
	}
	if (offset !== bytes.byteLength) throw new Error("binary envelope has trailing bytes");
	const usedSegments = new Set<number>();
	const restored = restore(record.value, segments, usedSegments, { nodes: 0 });
	if (usedSegments.size !== segments.length) throw new Error("unreferenced binary envelope segment");
	return restored;
}
