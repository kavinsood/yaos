import type { VerifiedObjectStreamOptions } from "./platformPorts";
import { ObjectStreamValidationError } from "./verifiedObjectStream";

function inputError(error: unknown): ObjectStreamValidationError {
	if (error instanceof ObjectStreamValidationError) return error;
	return new ObjectStreamValidationError(error instanceof Error && /length|too many|too few/i.test(error.message)
		? "length_mismatch" : "body_read_failed");
}

export async function createCloudflareVerifiedObjectStream(
	bucket: R2Bucket,
	key: string,
	body: ReadableStream<Uint8Array>,
	options: VerifiedObjectStreamOptions,
): Promise<"created" | "exists"> {
	if (!Number.isSafeInteger(options.length) || options.length < 1) {
		throw new ObjectStreamValidationError("length_mismatch");
	}
	if (!/^[a-f0-9]{64}$/.test(options.sha256) || !key.endsWith(`/blobs/${options.sha256}`)) {
		throw new ObjectStreamValidationError("hash_mismatch");
	}
	let existing: R2Object | null;
	try { existing = await bucket.head(key); }
	catch (error) { void body.cancel(error).catch(() => undefined); throw error; }
	const valid = existing?.checksums?.sha256 && Array.from(new Uint8Array(existing.checksums.sha256), (byte) => byte.toString(16).padStart(2, "0")).join("") === options.sha256;
	const abort = new AbortController();
	const output = new FixedLengthStream(options.length);
	const pumping = body.pipeTo(output.writable, { signal: abort.signal, preventCancel: true });
	void pumping.catch((error: unknown) => { void body.cancel(error).catch(() => undefined); });
	const drain = () => output.readable.pipeTo(new WritableStream<Uint8Array>());
	const publication = Promise.resolve().then(async () => {
		if (existing && (options.replaceEtag !== existing.etag || (valid && !options.replaceEtag))) {
			await drain();
			return "exists" as const;
		}
		const object = await bucket.put(key, output.readable, {
			sha256: options.sha256,
			onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
			httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
			customMetadata: options.customMetadata ? { ...options.customMetadata } : undefined,
		});
		if (object === null) {
			if (!output.readable.locked) await drain();
			return "exists" as const;
		}
		return "created" as const;
	}).catch((error: unknown) => {
		const cancellation = new Error("R2 publication failed", { cause: error });
		if (!output.readable.locked) void output.readable.cancel(cancellation).catch(() => undefined);
		abort.abort(cancellation);
		throw error;
	});
	const [inputResult, publicationResult] = await Promise.allSettled([pumping, publication]);
	if (publicationResult.status === "rejected" && publicationResult.reason instanceof Error
		&& /\(10037\)$/.test(publicationResult.reason.message)) {
		throw new ObjectStreamValidationError("hash_mismatch");
	}
	if (inputResult.status === "rejected" && inputResult.reason !== abort.signal.reason) {
		throw inputError(inputResult.reason);
	}
	if (publicationResult.status === "rejected") {
		if (publicationResult.reason instanceof Error && /FixedLengthStream|too many|too few|length mismatch/i.test(publicationResult.reason.message)) {
			throw inputError(publicationResult.reason);
		}
		throw publicationResult.reason;
	}
	if (inputResult.status === "rejected") throw inputError(inputResult.reason);
	return publicationResult.value;
}
