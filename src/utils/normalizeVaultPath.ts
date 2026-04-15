export function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(\.\/)+/, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}
