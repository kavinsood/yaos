/** Strict base64 codecs for values whose representation is inherently text. */

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE = new Uint8Array(128).fill(0xff);
for (let index = 0; index < ALPHABET.length; index++) DECODE[ALPHABET.charCodeAt(index)] = index;

type Base64Options = { alphabet?: "base64" | "base64url"; omitPadding?: boolean };
type NativeBase64Array = Uint8Array & { toBase64?: (options?: Base64Options) => string };
type NativeBase64Constructor = Uint8ArrayConstructor & {
	fromBase64?: (value: string, options?: Base64Options) => Uint8Array;
};

function fallbackEncode(bytes: Uint8Array): string {
	const chunks: string[] = [];
	const size = 32_768;
	for (let offset = 0; offset < bytes.byteLength; offset += size) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))));
	}
	return btoa(chunks.join(""));
}

function fallbackDecode(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function assertCanonicalBase64Url(value: string): void {
	if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error("invalid base64url");
	const remainder = value.length % 4;
	if (remainder === 0 || value.length === 0) return;
	const code = value.charCodeAt(value.length - 1);
	const decoded = code < DECODE.length ? DECODE[code]! : 0xff;
	if (decoded === 0xff || (remainder === 2 ? decoded & 0x0f : decoded & 0x03) !== 0) {
		throw new Error("non-canonical base64url");
	}
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	const native = (bytes as NativeBase64Array).toBase64;
	if (native) return native.call(bytes, { alphabet: "base64url", omitPadding: true });
	return fallbackEncode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
	const native = (bytes as NativeBase64Array).toBase64;
	if (native) return native.call(bytes, { alphabet: "base64", omitPadding: false });
	return fallbackEncode(bytes);
}

export function base64UrlToBytes(value: string): Uint8Array {
	assertCanonicalBase64Url(value);
	const native = (Uint8Array as NativeBase64Constructor).fromBase64;
	if (native) return native(value, { alphabet: "base64url" });
	return fallbackDecode(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

/** Strict canonical padded standard-base64 decoder for textual protocol fields. */
export function base64ToBytes(value: string): Uint8Array {
	if (value.length % 4 !== 0 || !BASE64.test(value)) throw new Error("invalid base64");
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const unpadded = value.slice(0, value.length - padding);
	if (unpadded.includes("=") || padding !== (unpadded.length % 4 === 2 ? 2 : unpadded.length % 4 === 3 ? 1 : 0)) {
		throw new Error("invalid base64 padding");
	}
	return base64UrlToBytes(unpadded.replaceAll("+", "-").replaceAll("/", "_"));
}

export function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}
