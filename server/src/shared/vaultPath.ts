const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const FORBIDDEN_COMPONENT_CHARS = /[<>:"|?*]/;
const DEFAULT_CONFIG_DIR = [".", "obsidian"].join("");
const MAX_BLOB_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;

type BlobPathRef = { hash: string; size: number };

function safeBasePath(path: string, configDir: string): string | null {
	if (!path || new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES
		|| path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return null;
	if (path.includes("\\")) return null;
	const parts = path.split("/");
	if (parts.some((part) =>
		!part
		|| part === "."
		|| part === ".."
		|| part.endsWith(" ")
		|| part.endsWith(".")
		|| WINDOWS_RESERVED.test(part)
		|| FORBIDDEN_COMPONENT_CHARS.test(part)
		|| [...part].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		})
	)) return null;
	const canonical = path.normalize("NFC");
	if (canonical !== path) return null;
	const first = parts[0]!.toLowerCase();
	if (
		first === ".trash"
		|| first === DEFAULT_CONFIG_DIR
		|| (configDir && first === configDir.toLowerCase())
	) return null;
	return canonical;
}

export function safeMarkdownPath(path: string, configDir = ""): string | null {
	const canonical = safeBasePath(path, configDir);
	return canonical?.endsWith(".md") ? canonical : null;
}

export function safeBlobPath(
	path: string,
	configDir = "",
	ref?: BlobPathRef,
): string | null {
	if (
		ref
		&& (
			!/^[a-f0-9]{64}$/.test(ref.hash)
			|| !Number.isSafeInteger(ref.size)
			|| ref.size < 0
			|| ref.size > MAX_BLOB_SIZE_BYTES
		)
	) return null;
	const canonical = safeBasePath(path, configDir);
	return canonical && !canonical.toLowerCase().endsWith(".md") ? canonical : null;
}
