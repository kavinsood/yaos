import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCloudflareVerifiedObjectStream } from "../../server/src/cloudflareVerifiedObjectStream";
import { ObjectStreamValidationError } from "../../server/src/verifiedObjectStream";
import { suite } from "../harness";

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(length: number) {
		let seen = 0;
		super({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > length) throw new Error("FixedLengthStream length exceeded");
				controller.enqueue(chunk);
			},
			flush() { if (seen !== length) throw new Error("FixedLengthStream length mismatch"); },
		});
	}
}

Object.assign(globalThis, { FixedLengthStream: TestFixedLengthStream });
const integrity = suite("cloudflare-blob-integrity");
const data = new TextEncoder().encode("verified attachment".repeat(100));
const hash = createHash("sha256").update(data).digest("hex");
const key = `vault/generation/blobs/${hash}`;

function input(bytes = data) {
	let consumed = 0;
	let canceled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (consumed === bytes.byteLength) return controller.close();
			const end = Math.min(consumed + 17, bytes.byteLength);
			controller.enqueue(bytes.subarray(consumed, end));
			consumed = end;
		},
		cancel() { canceled = true; },
	});
	return { body, consumed: () => consumed, canceled: () => canceled };
}

function store(mode: "normal" | "early-null" | "locked-null" | "fail" = "normal") {
	const objects = new Map<string, Uint8Array>();
	let writes = 0;
	let puts = 0;
	const bucket = {
		async head(objectKey: string) { return mode === "early-null" ? null : objects.has(objectKey) ? {
			etag: "stored-etag", checksums: { sha256: Uint8Array.from(Buffer.from(createHash("sha256").update(objects.get(objectKey)!).digest("hex"), "hex")).buffer },
		} : null; },
		async put(objectKey: string, body: ReadableStream<Uint8Array>, options: R2PutOptions) {
			puts++;
			assert.equal(objectKey, key);
			assert.equal(options.sha256, hash);
			assert.deepEqual(options.onlyIf, objects.has(objectKey) ? { etagMatches: "stored-etag" } : { etagDoesNotMatch: "*" });
			if (mode === "early-null") return null;
			if (mode === "locked-null") {
				void body.pipeTo(new WritableStream<Uint8Array>()).catch(() => undefined);
				return null;
			}
			if (mode === "fail") throw new Error("storage unavailable");
			const chunks: Uint8Array[] = [];
			const digest = createHash("sha256");
			const reader = body.getReader();
			try {
				for (;;) {
					const result = await reader.read();
					if (result.done) break;
					chunks.push(result.value);
					digest.update(result.value);
				}
			} finally { reader.releaseLock(); }
			if (digest.digest("hex") !== options.sha256) throw new Error("checksum mismatch (10037)");
			if (objects.has(objectKey) && !((options.onlyIf as R2Conditional).etagMatches)) return null;
			objects.set(objectKey, Buffer.concat(chunks));
			writes++;
			return {};
		},
	};
	return { bucket: bucket as unknown as R2Bucket, objects, writes: () => writes, puts: () => puts };
}

async function bounded<Result>(task: Promise<Result>): Promise<Result> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([task, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("pipeline did not settle")), 2000);
		})]);
	} finally { clearTimeout(timer); }
}

function upload(storage: ReturnType<typeof store>, body = input().body, length = data.byteLength) {
	return bounded(createCloudflareVerifiedObjectStream(storage.bucket, key, body, { length, sha256: hash }));
}

integrity.test("R2 verifies fresh bytes, publishes once and acknowledges existing objects without hashing", async () => {
	const storage = store();
	assert.equal(await upload(storage), "created");
	assert.deepEqual(storage.objects.get(key), Buffer.from(data));
	const corrupt = data.slice();
	corrupt[0] = corrupt[0]! ^ 1;
	assert.equal(await upload(storage, input(corrupt).body), "exists");
	assert.equal(storage.puts(), 1);
	assert.equal(storage.writes(), 1);
	assert.deepEqual(storage.objects.get(key), Buffer.from(data));
});

integrity.test("suspect checksum-matching objects allow explicit ETag replacement only", async () => {
	const storage = store();
	assert.equal(await upload(storage), "created");
	assert.equal(await upload(storage), "exists");
	assert.equal(storage.puts(), 1);
	assert.equal(await bounded(createCloudflareVerifiedObjectStream(storage.bucket, key, input().body,
		{ length: data.length, sha256: hash, replaceEtag: "stored-etag" })), "created");
	assert.equal(storage.puts(), 2);
	assert.deepEqual(storage.objects.get(key), Buffer.from(data));
	assert.equal(await bounded(createCloudflareVerifiedObjectStream(storage.bucket, key, input().body,
		{ length: data.length, sha256: hash, replaceEtag: "stale-etag" })), "exists");
	assert.equal(storage.puts(), 2);
});

integrity.test("a legacy checksum-free object is replaced only with its matching ETag", async () => {
	const storage = store();
	storage.objects.set(key, new TextEncoder().encode("legacy-invalid"));
	assert.equal(await upload(storage), "exists");
	assert.equal(storage.puts(), 0);
	assert.equal(await bounded(createCloudflareVerifiedObjectStream(storage.bucket, key, input().body,
		{ length: data.length, sha256: hash, replaceEtag: "stored-etag" })), "created");
	assert.deepEqual(storage.objects.get(key), Buffer.from(data));
});

integrity.test("corrupt fresh bytes return hash_mismatch and leave no object", async () => {
	const storage = store();
	const corrupt = data.slice();
	corrupt[0] = corrupt[0]! ^ 1;
	await assert.rejects(upload(storage, input(corrupt).body), (error: unknown) =>
		error instanceof ObjectStreamValidationError && error.kind === "hash_mismatch");
	assert.equal(storage.objects.size, 0);
});

integrity.test("early conditional loser drains exact-length input, including corrupt bytes", async () => {
	const storage = store("early-null");
	const corrupt = data.slice();
	corrupt[0] = corrupt[0]! ^ 1;
	const source = input(corrupt);
	assert.equal(await upload(storage, source.body), "exists");
	assert.equal(source.consumed(), data.byteLength);
	assert.equal(storage.writes(), 0);
});

integrity.test("conditional loser can leave R2's native reader locked while it drains", async () => {
	assert.equal(await upload(store("locked-null")), "exists");
});

for (const mode of ["normal", "existing", "early-null", "locked-null"] as const) {
	integrity.test(`${mode} rejects both under-length and over-length inputs`, async () => {
		for (const length of [data.byteLength - 1, data.byteLength + 1]) {
			const storage = store(mode === "existing" ? "normal" : mode);
			if (mode === "existing") storage.objects.set(key, data);
			await assert.rejects(upload(storage, input().body, length), (error: unknown) =>
				error instanceof ObjectStreamValidationError && error.kind === "length_mismatch");
			assert.equal(storage.writes(), 0);
		}
	});
}

integrity.test("concurrent identical uploads publish exactly once", async () => {
	const storage = store();
	assert.deepEqual((await Promise.all([upload(storage), upload(storage)])).sort(), ["created", "exists"]);
	assert.equal(storage.writes(), 1);
});

integrity.test("storage failure cancels source and settles all pipelines", async () => {
	const source = input();
	await assert.rejects(upload(store("fail"), source.body), /storage unavailable/);
	assert.equal(source.canceled(), true);
});

integrity.test("source read failures do not publish", async () => {
	const storage = store();
	const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("broken input"); } });
	await assert.rejects(upload(storage, body), (error: unknown) =>
		error instanceof ObjectStreamValidationError && error.kind === "body_read_failed");
	assert.equal(storage.writes(), 0);
});

integrity.test("wrong key/checksum binding fails before R2 access", async () => {
	const storage = store();
	await assert.rejects(createCloudflareVerifiedObjectStream(storage.bucket, `${key}-wrong`, input().body,
		{ length: data.byteLength, sha256: hash }), (error: unknown) =>
		error instanceof ObjectStreamValidationError && error.kind === "hash_mismatch");
	assert.equal(storage.puts(), 0);
});

integrity.test("length failure does not wait for a never-settling source cancellation", async () => {
	const storage = store();
	const body = new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(data); },
		cancel() { return new Promise<void>(() => undefined); },
	});
	await assert.rejects(upload(storage, body, 1), (error: unknown) =>
		error instanceof ObjectStreamValidationError && error.kind === "length_mismatch");
});

await integrity.done();
