function bytesToLowerHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** Hash bytes with SHA-256 and return a lowercase hexadecimal digest. */
export async function sha256BytesHex(input: ArrayBuffer | Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", input);
	return bytesToLowerHex(new Uint8Array(digest));
}

/** Encode text as UTF-8 once, then return its lowercase SHA-256 digest. */
export function sha256TextHex(input: string): Promise<string> {
	return sha256BytesHex(new TextEncoder().encode(input));
}
