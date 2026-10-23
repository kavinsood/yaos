import { strict as assert } from "node:assert";
import { base64UrlToBytes, bytesToBase64Url } from "../../server/src/base64url";
import { suite } from "../harness.ts";

const s = suite("base64-codec");
type NativeOptions = { alphabet?: "base64" | "base64url"; omitPadding?: boolean };
type NativeBase64Array = Uint8Array & { toBase64?: (options?: NativeOptions) => string };
type NativeBase64Constructor = Uint8ArrayConstructor & {
	fromBase64?: (value: string, options?: NativeOptions) => Uint8Array;
};

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

// Node 24 (CI, `engines`) has no native `toBase64`/`fromBase64`; there the native path runs on Buffer-backed stand-ins.
const nativeEncode: (this: Uint8Array, options?: NativeOptions) => string =
	(Uint8Array.prototype as NativeBase64Array).toBase64 ??
	function (this: Uint8Array, options?: NativeOptions) {
		const text = Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString(options?.alphabet ?? "base64");
		return options?.omitPadding ? text.replace(/=+$/u, "") : text;
	};
const nativeDecode: (value: string, options?: NativeOptions) => Uint8Array =
	(Uint8Array as NativeBase64Constructor).fromBase64 ??
	((value, options) => new Uint8Array(Buffer.from(value, options?.alphabet ?? "base64")));

/** Runs `body` with the native codecs replaced, then puts back exactly what was there (nothing, on Node 24). */
function withNatives(encode: unknown, decode: unknown, body: () => void): void {
	const encodeDesc = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
	const decodeDesc = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
	try {
		Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, writable: true, value: encode });
		Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, writable: true, value: decode });
		body();
	} finally {
		if (encodeDesc) Object.defineProperty(Uint8Array.prototype, "toBase64", encodeDesc);
		else delete (Uint8Array.prototype as NativeBase64Array).toBase64;
		if (decodeDesc) Object.defineProperty(Uint8Array, "fromBase64", decodeDesc);
		else delete (Uint8Array as NativeBase64Constructor).fromBase64;
	}
}

s.test("the URL codec accepts only its canonical spelling", () => {
	assert.deepEqual(base64UrlToBytes(""), bytes());
	assert.deepEqual(base64UrlToBytes("_w"), bytes(255));
	assert.deepEqual(base64UrlToBytes("_-4"), bytes(255, 238));

	for (const value of ["A", "_x", "_-9", "_w=", "+w", "/w", "éA", "ＡA", "AA\n", "AA "]) {
		assert.throws(() => base64UrlToBytes(value), /base64url/iu, `URL decoder accepted ${JSON.stringify(value)}`);
	}
});

s.test("native codecs receive explicit alphabets and preserve exact bytes", () => {
	const encodeOptions: unknown[] = [];
	const decodeOptions: unknown[] = [];
	withNatives(
		function (this: Uint8Array, options?: NativeOptions) {
			encodeOptions.push(options);
			return nativeEncode.call(this, options);
		},
		(value: string, options?: NativeOptions) => {
			decodeOptions.push(options);
			return nativeDecode(value, options);
		},
		() => {
			const input = bytes(0, 1, 2, 127, 128, 254, 255);
			assert.deepEqual(base64UrlToBytes(bytesToBase64Url(input)), input);
			assert.deepEqual(encodeOptions, [{ alphabet: "base64url", omitPadding: true }]);
			assert.deepEqual(decodeOptions, [{ alphabet: "base64url" }]);
		},
	);
});

s.test("fallback codecs round-trip large input without argument or padding shortcuts", () => {
	withNatives(undefined, undefined, () => {
		const input = new Uint8Array(150_003);
		for (let index = 0; index < input.byteLength; index++) input[index] = index % 251;
		const url = bytesToBase64Url(input);
		assert.equal(url.includes("="), false);
		assert.deepEqual(base64UrlToBytes(url), input);
	});
});

await s.done();
