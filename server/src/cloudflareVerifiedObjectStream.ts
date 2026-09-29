import type { VerifiedObjectStreamOptions } from "./platformPorts";
import { ObjectStreamValidationError, verifyObjectStream } from "./verifiedObjectStream";

export async function createCloudflareVerifiedObjectStream(
	bucket: R2Bucket,
	key: string,
	body: ReadableStream<Uint8Array>,
	options: VerifiedObjectStreamOptions,
): Promise<"created" | "exists"> {
	const digest = new (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream("SHA-256");
	void digest.digest.catch(() => undefined);
	const hashWriter = digest.getWriter();
	const verify = (consume: (chunk: Uint8Array) => Promise<void>) => verifyObjectStream(
		body,
		options,
		async (chunk) => { await hashWriter.write(chunk); },
		async () => {
			await hashWriter.close();
			return Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		},
		consume,
	);
	try {
		if (await bucket.head(key)) {
			await verify(async () => undefined);
			return "exists";
		}
		const output = new FixedLengthStream(options.length);
		const writer = output.writable.getWriter();
		let storageSettled = false;
		let releaseOutput: (() => void) | null = null;
		const publication = Promise.resolve().then(() => bucket.put(key, output.readable, {
			sha256: options.sha256,
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
			customMetadata: options.customMetadata ? { ...options.customMetadata } : undefined,
		})).then(
			(object) => ({ result: object === null ? "exists" as const : "created" as const }),
			(error: unknown) => ({ error }),
		);
		void publication.then(() => {
			storageSettled = true;
			releaseOutput?.();
		});
		const abortOutput = (reason: unknown) => {
			void writer.abort(reason).catch(() => undefined);
			if (!output.readable.locked) void output.readable.cancel(reason).catch(() => undefined);
		};
		const awaitOutput = async (operation: () => Promise<void>) => {
			if (storageSettled) return;
			await new Promise<void>((resolve) => {
				releaseOutput = resolve;
				void operation().then(resolve, (error: unknown) => {
					abortOutput(error);
					resolve();
				});
			});
			releaseOutput = null;
		};
		let pending: Uint8Array | null = null;
		try {
			await verify(async (chunk) => {
				for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
					if (pending) {
						const previous = pending;
						await awaitOutput(() => writer.write(previous));
					}
					pending = storageSettled ? null : chunk.slice(offset, offset + 64 * 1024);
				}
			});
			if (pending) {
				const last = pending;
				await awaitOutput(() => writer.write(last));
			}
			await awaitOutput(() => writer.close());
			const outcome = await publication;
			if ("error" in outcome) {
				if (outcome.error instanceof Error && /\(10037\)$/.test(outcome.error.message)) {
					throw new ObjectStreamValidationError("hash_mismatch");
				}
				throw outcome.error;
			}
			return outcome.result;
		} catch (error) {
			abortOutput(error);
			await publication;
			throw error;
		} finally {
			abortOutput(new Error("upload finished"));
			writer.releaseLock();
		}
	} catch (error) {
		void hashWriter.abort(error).catch(() => undefined);
		throw error;
	} finally {
		hashWriter.releaseLock();
	}
}
