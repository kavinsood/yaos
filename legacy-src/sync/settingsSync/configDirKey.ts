const MAX_KEY_LENGTH = 64;

/** Sanitize basename(app.vault.configDir) without treating it as a vault-relative path. */
export function sanitizeConfigDirKey(basename: string): string | null {
	if (typeof basename !== "string") return null;
	if (basename.length === 0 || basename.length > MAX_KEY_LENGTH) return null;
	if (basename === "." || basename === "..") return null;
	if (basename.includes("/") || basename.includes("\\") || basename.includes("\0")) return null;
	return basename;
}
