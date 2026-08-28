const BYTE_TO_HEX: string[] = (() => {
	const table = new Array<string>(256);
	for (let i = 0; i < 256; i++) {
		table[i] = i.toString(16).padStart(2, "0");
	}
	return table;
})();

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += BYTE_TO_HEX[bytes[i] ?? 0] ?? "00";
	}
	return out;
}

export function isSha256Hex(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToHex(new Uint8Array(digest));
}
