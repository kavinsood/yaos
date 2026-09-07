import { strict as assert } from "node:assert";
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "../../server/src/base64url";
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

s.test("standard and URL codecs accept only their canonical spelling", () => {
	assert.deepEqual(base64ToBytes(""), bytes());
	assert.deepEqual(base64ToBytes("Zg=="), bytes(102));
	assert.deepEqual(base64ToBytes("Zm8="), bytes(102, 111));
	assert.deepEqual(base64ToBytes("Zm9v"), bytes(102, 111, 111));
	assert.deepEqual(base64UrlToBytes(""), bytes());
	assert.deepEqual(base64UrlToBytes("_w"), bytes(255));
	assert.deepEqual(base64UrlToBytes("_-4"), bytes(255, 238));

	for (const value of ["Zg", "Zg=", "Zg===", "=Zg=", "Z=g=", "Zh==", "Zm9=", "_w==", "éA==", "ＡA==", "AA==\n"]) {
		assert.throws(() => base64ToBytes(value), /base64/iu, `standard decoder accepted ${JSON.stringify(value)}`);
	}
	for (const value of ["A", "_x", "_-9", "_w=", "+w", "/w", "éA", "ＡA", "AA\n", "AA "]) {
		assert.throws(() => base64UrlToBytes(value), /base64url/iu, `URL decoder accepted ${JSON.stringify(value)}`);
	}
});

s.test("native codecs receive explicit alphabets and preserve exact bytes", () => {
	const originalEncode = (Uint8Array.prototype as NativeBase64Array).toBase64!;
	const originalDecode = (Uint8Array as NativeBase64Constructor).fromBase64!;
	const encodeOptions: unknown[] = [];
	const decodeOptions: unknown[] = [];
	try {
		Object.defineProperty(Uint8Array.prototype, "toBase64", {
			configurable: true,
			writable: true,
			value(this: Uint8Array, options?: NativeOptions) {
				encodeOptions.push(options);
				return originalEncode.call(this, options);
			},
		});
		Object.defineProperty(Uint8Array, "fromBase64", {
			configurable: true,
			writable: true,
			value(value: string, options?: NativeOptions) {
				decodeOptions.push(options);
				return originalDecode.call(Uint8Array, value, options);
			},
		});
		const input = bytes(0, 1, 2, 127, 128, 254, 255);
		assert.deepEqual(base64ToBytes(bytesToBase64(input)), input);
		assert.deepEqual(base64UrlToBytes(bytesToBase64Url(input)), input);
		assert.deepEqual(encodeOptions, [
			{ alphabet: "base64", omitPadding: false },
			{ alphabet: "base64url", omitPadding: true },
		]);
		assert.deepEqual(decodeOptions, [
			{ alphabet: "base64url" },
			{ alphabet: "base64url" },
		]);
	} finally {
		Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, writable: true, value: originalEncode });
		Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, writable: true, value: originalDecode });
	}
});

s.test("fallback codecs round-trip large input without argument or padding shortcuts", () => {
	const originalEncode = (Uint8Array.prototype as NativeBase64Array).toBase64!;
	const originalDecode = (Uint8Array as NativeBase64Constructor).fromBase64!;
	try {
		Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, writable: true, value: undefined });
		Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, writable: true, value: undefined });
		const input = new Uint8Array(150_003);
		for (let index = 0; index < input.byteLength; index++) input[index] = index % 251;
		const standard = bytesToBase64(input);
		const url = bytesToBase64Url(input);
		assert.equal(standard.length % 4, 0);
		assert.equal(url.includes("="), false);
		assert.deepEqual(base64ToBytes(standard), input);
		assert.deepEqual(base64UrlToBytes(url), input);
	} finally {
		Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, writable: true, value: originalEncode });
		Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, writable: true, value: originalDecode });
	}
});

await s.done();
