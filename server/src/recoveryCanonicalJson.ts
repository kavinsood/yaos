import { Gunzip, gzipSync } from "fflate";
import { sha256Hex } from "./hex";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const MAX_RECOVERY_NODE_BYTES = 4 * 1024 * 1024;
export const MAX_RECOVERY_COMPRESSED_NODE_BYTES = 4 * 1024 * 1024;

export type CanonicalJsonPrimitive = null | boolean | string | number;
export type CanonicalJsonValue =
	| CanonicalJsonPrimitive
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}
function quoteJsonString(value: string): string {
	const quoted = JSON.stringify(value);
	if (quoted === undefined) throw new Error("canonical JSON string could not be encoded");
	return quoted;
}


function serialize(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") {
		if (!isWellFormedUnicode(value)) throw new Error("canonical JSON contains malformed Unicode");
		return quoteJsonString(value);
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error("canonical JSON numbers must be safe integers");
		return Object.is(value, -0) ? "0" : String(value);
	}
	if (typeof value !== "object") throw new Error("canonical JSON contains an unsupported value");
	if (ancestors.has(value)) throw new Error("canonical JSON contains a cycle");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const items = new Array<string>(value.length);
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("canonical JSON arrays cannot be sparse");
				items[index] = serialize(value[index], ancestors);
			}
			if (Object.keys(value).length !== value.length) throw new Error("canonical JSON arrays cannot have named properties");
			return `[${items.join(",")}]`;
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("canonical JSON objects must be plain records");
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => {
			if (!isWellFormedUnicode(key)) throw new Error("canonical JSON key contains malformed Unicode");
			return `${quoteJsonString(key)}:${serialize(record[key], ancestors)}`;
		}).join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

/** Deterministic UTF-8 JSON with sorted object keys and integer-only numbers. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
	return encoder.encode(serialize(value, new Set<object>()));
}

export function canonicalJsonText(value: unknown): string {
	return serialize(value, new Set<object>());
}

export async function canonicalJsonHash(value: unknown): Promise<string> {
	return sha256Hex(canonicalJsonBytes(value));
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
	const result = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function gunzipRecoveryBytes(
	compressed: Uint8Array,
	compressedLimit = MAX_RECOVERY_COMPRESSED_NODE_BYTES,
	plainLimit = MAX_RECOVERY_NODE_BYTES,
): Uint8Array {
	if (compressed.byteLength === 0 || compressed.byteLength > compressedLimit) {
		throw new Error("compressed recovery object exceeds bound");
	}
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const gunzip = new Gunzip((chunk) => {
		byteLength += chunk.byteLength;
		if (byteLength > plainLimit) throw new Error("recovery object exceeds decompression bound");
		chunks.push(chunk);
	});
	for (let offset = 0; offset < compressed.byteLength; offset += 64 * 1024) {
		const end = Math.min(compressed.byteLength, offset + 64 * 1024);
		gunzip.push(compressed.subarray(offset, end), end === compressed.byteLength);
	}
	return concatenate(chunks, byteLength);
}

export function gzipRecoveryBytes(bytes: Uint8Array): Uint8Array {
	return gzipSync(bytes, { level: 6, mtime: 0 });
}

/** Parses only bytes already in canonical form; alternate JSON encodings fail closed. */
export function parseCanonicalJson(bytes: Uint8Array): unknown {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes));
	} catch {
		throw new Error("recovery object is not valid UTF-8 JSON");
	}
	const canonical = canonicalJsonBytes(value);
	if (canonical.byteLength !== bytes.byteLength) throw new Error("recovery object is not canonical JSON");
	for (let index = 0; index < bytes.byteLength; index++) {
		if (canonical[index] !== bytes[index]) throw new Error("recovery object is not canonical JSON");
	}
	return value;
}

export interface EncodedRecoveryObject<T> {
	readonly value: T;
	readonly canonicalBytes: Uint8Array;
	readonly compressedBytes: Uint8Array;
	readonly hash: string;
}

export async function encodeHashedRecoveryObject<T>(value: T): Promise<EncodedRecoveryObject<T>> {
	const canonicalBytes = canonicalJsonBytes(value);
	return {
		value,
		canonicalBytes,
		compressedBytes: gzipRecoveryBytes(canonicalBytes),
		hash: await sha256Hex(canonicalBytes),
	};
}

export async function decodeHashedRecoveryObject(
	compressed: Uint8Array,
	expectedHash: string,
	limits: { compressedBytes?: number; canonicalBytes?: number } = {},
): Promise<unknown> {
	if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("invalid expected recovery object hash");
	const canonical = gunzipRecoveryBytes(
		compressed,
		limits.compressedBytes ?? MAX_RECOVERY_COMPRESSED_NODE_BYTES,
		limits.canonicalBytes ?? MAX_RECOVERY_NODE_BYTES,
	);
	if (await sha256Hex(canonical) !== expectedHash) throw new Error("recovery object hash mismatch");
	return parseCanonicalJson(canonical);
}
