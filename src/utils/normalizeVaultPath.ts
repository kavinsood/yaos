export function normalizeVaultPath(path: string): string {
	return path
		.normalize("NFC")
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(\.\/)+/, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}
