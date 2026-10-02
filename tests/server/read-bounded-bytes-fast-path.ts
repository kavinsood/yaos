import { BoundedBodyError, readBoundedBytes } from "../../server/src/readBoundedBytes";
import { suite } from "../harness.ts";

// b3-cpu: a body with a declared Content-Length within the cap is read with one native arrayBuffer() call,
// never through the per-chunk JS reader loop (≈12–15 ms CPU per MiB on deployed Workers).
const s = suite("read-bounded-bytes-fast-path");

function fakeRequest(declared: string | null, bytes: Uint8Array, reads: { reader: number; arrayBuffer: number }): Request {
	const headers = new Headers(declared === null ? {} : { "Content-Length": declared });
	const stream = new Request("https://example.test/", { method: "POST", body: bytes }).body!;
	return {
		headers,
		body: { getReader: () => { reads.reader++; return stream.getReader(); } },
		arrayBuffer: async () => { reads.arrayBuffer++; return bytes.slice().buffer; },
	} as unknown as Request;
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
	try { await promise; return "ok"; } catch (error) { return error instanceof BoundedBodyError ? error.kind : "other"; }
}

s.test("declared length within the cap reads natively", async () => {
	const reads = { reader: 0, arrayBuffer: 0 };
	const bytes = new Uint8Array(300_000).map((_v, i) => i & 0xff);
	const out = await readBoundedBytes(fakeRequest(String(bytes.byteLength), bytes, reads), 1_000_000);
	s.check(out.byteLength === bytes.byteLength && out[12345] === bytes[12345], "bytes are returned intact");
	s.check(reads.arrayBuffer === 1 && reads.reader === 0, "one arrayBuffer() call, no chunk reader");
});

s.test("declared length still rejects oversize before any body access", async () => {
	const reads = { reader: 0, arrayBuffer: 0 };
	s.check(await kindOf(readBoundedBytes(fakeRequest("11", new Uint8Array(11), reads), 10)) === "body_too_large", "413 kind");
	s.check(await kindOf(readBoundedBytes(fakeRequest("1x", new Uint8Array(1), reads), 10)) === "invalid_content_length", "invalid kind");
	s.check(reads.arrayBuffer === 0 && reads.reader === 0, "body untouched");
});

s.test("a body longer than its declared length is still bounded by the cap", async () => {
	const reads = { reader: 0, arrayBuffer: 0 };
	s.check(await kindOf(readBoundedBytes(fakeRequest("5", new Uint8Array(20), reads), 10)) === "body_too_large", "413 kind");
});

s.test("declared zero honours allowEmpty", async () => {
	const reads = { reader: 0, arrayBuffer: 0 };
	s.check((await readBoundedBytes(fakeRequest("0", new Uint8Array(0), reads), 10, { allowEmpty: true })).byteLength === 0, "empty ok");
	s.check(await kindOf(readBoundedBytes(fakeRequest("0", new Uint8Array(0), reads), 10)) === "missing_body", "missing without allowEmpty");
});

s.test("no declared length keeps the bounded chunk loop", async () => {
	const reads = { reader: 0, arrayBuffer: 0 };
	const out = await readBoundedBytes(fakeRequest(null, new Uint8Array(64), reads), 100);
	s.check(out.byteLength === 64 && reads.reader === 1 && reads.arrayBuffer === 0, "chunk reader used");
	s.check(await kindOf(readBoundedBytes(fakeRequest(null, new Uint8Array(101), { reader: 0, arrayBuffer: 0 }), 100)) === "body_too_large", "413 kind");
});

await s.done();
