export type BoundedBodyErrorKind =
	| "invalid_content_length"
	| "body_too_large"
	| "missing_body"
	| "body_read_failed";

export class BoundedBodyError extends Error {
	constructor(readonly kind: BoundedBodyErrorKind) {
		super(kind);
		this.name = "BoundedBodyError";
	}
}

/**
 * Read a request body without retaining more than `maxBytes` of accepted chunks.
 * A chunk that crosses the limit is cancelled and rejected before it is retained.
 */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("maxBytes must be a non-negative safe integer");
	}

	const declaredHeader = request.headers.get("Content-Length");
	if (declaredHeader !== null) {
		const trimmed = declaredHeader.trim();
		if (!/^\d+$/.test(trimmed)) {
			throw new BoundedBodyError("invalid_content_length");
		}
		const declared = Number(trimmed);
		if (!Number.isSafeInteger(declared)) {
			throw new BoundedBodyError("invalid_content_length");
		}
		if (declared > maxBytes) {
			throw new BoundedBodyError("body_too_large");
		}
	}

	const body = request.body;
	if (!body) {
		throw new BoundedBodyError("missing_body");
	}

	let reader: ReadableStreamDefaultReader<unknown>;
	try {
		reader = body.getReader();
	} catch {
		throw new BoundedBodyError("body_read_failed");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let result: ReadableStreamReadResult<unknown>;
			try {
				result = await reader.read();
			} catch {
				try {
					await reader.cancel();
				} catch {
					// An errored stream commonly rejects cancellation with the read error.
				}
				throw new BoundedBodyError("body_read_failed");
			}

			if (result.done) break;
			const chunk: unknown = result.value;
			if (!(chunk instanceof Uint8Array)) {
				try {
					await reader.cancel();
				} catch {
					// The body is already being rejected; cancellation is best effort.
				}
				throw new BoundedBodyError("body_read_failed");
			}
			if (chunk.byteLength === 0) continue;
			if (chunk.byteLength > maxBytes - total) {
				try {
					await reader.cancel();
				} catch {
					// Preserve the size failure even if the source rejects cancellation.
				}
				throw new BoundedBodyError("body_too_large");
			}
			total += chunk.byteLength;
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}

	if (total === 0) {
		throw new BoundedBodyError("missing_body");
	}
	if (chunks.length === 1) {
		return chunks[0]!;
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
