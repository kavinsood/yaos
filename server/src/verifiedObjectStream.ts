import type { VerifiedObjectStreamOptions } from "./platformPorts";

export class ObjectStreamValidationError extends Error {
	constructor(readonly kind: "length_mismatch" | "hash_mismatch" | "missing_body" | "body_read_failed") {
		super(kind);
		this.name = "ObjectStreamValidationError";
	}
}

export async function verifyObjectStream(
	body: ReadableStream<Uint8Array>,
	options: VerifiedObjectStreamOptions,
	update: (chunk: Uint8Array) => Promise<void>,
	digest: () => Promise<string>,
	consume: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
	if (!Number.isSafeInteger(options.length) || options.length < 1 || !/^[a-f0-9]{64}$/.test(options.sha256)) {
		throw new ObjectStreamValidationError("length_mismatch");
	}
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		throw new ObjectStreamValidationError("body_read_failed");
	}
	let total = 0;
	try {
		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch {
				throw new ObjectStreamValidationError("body_read_failed");
			}
			if (result.done) break;
			if (!(result.value instanceof Uint8Array)) throw new ObjectStreamValidationError("body_read_failed");
			if (result.value.byteLength > options.length - total) throw new ObjectStreamValidationError("length_mismatch");
			total += result.value.byteLength;
			if (result.value.byteLength === 0) continue;
			await update(result.value);
			await consume(result.value);
		}
		if (total === 0) throw new ObjectStreamValidationError("missing_body");
		if (total !== options.length) throw new ObjectStreamValidationError("length_mismatch");
		if (await digest() !== options.sha256) throw new ObjectStreamValidationError("hash_mismatch");
	} catch (error) {
		void reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}
