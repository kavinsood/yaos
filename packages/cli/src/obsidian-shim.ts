/**
 * Runtime `obsidian` module for the headless daemon.
 *
 * The published `obsidian` package ships only TypeScript declarations — there
 * is no JavaScript to load. Every module under `src/` that imports a VALUE from
 * "obsidian" (`TFile`, `normalizePath`, `Notice`, ...) therefore needs a real
 * runtime module behind that specifier. The daemon supplies this one via
 * `JITI_ALIAS`, exactly as `tests/run-suites.mjs` aliases the test mock.
 *
 * This is NOT a test mock. Where a headless process has a real answer, this
 * gives the real answer: `normalizePath` implements Obsidian's rule because
 * path identity depends on it, `Platform` reports the actual OS, `requestUrl`
 * performs an actual HTTP request, and `Notice` writes to stderr because a
 * daemon's "user-visible message" surface is its log. Where a headless process
 * has no answer — a `MarkdownView`, a settings tab — the export exists only so
 * that `instanceof` checks and import bindings resolve; the daemon never
 * constructs one.
 *
 * ZERO DEPENDENCIES, DELIBERATELY. The launcher imports this file to build
 * `JITI_ALIAS` *before* the alias exists, so nothing here may import a module
 * that itself resolves "obsidian".
 */

import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Launcher support
// ---------------------------------------------------------------------------

/** Absolute path of this file — the value `JITI_ALIAS` must map "obsidian" to. */
export const OBSIDIAN_SHIM_PATH: string = fileURLToPath(import.meta.url);

/**
 * A copy of `base` with `JITI_ALIAS` extended to route "obsidian" here.
 *
 * Merges rather than replaces: the caller may already be aliasing `yjs`,
 * `@shared`, or anything else, and silently dropping those would break the
 * child in a way that is very hard to see from the outside.
 */
export function jitiAliasEnv(
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	let existing: Record<string, string> = {};
	const raw = base.JITI_ALIAS;
	if (typeof raw === "string" && raw.length > 0) {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === "string") existing[key] = value;
			}
		}
	}
	existing = { ...existing, obsidian: OBSIDIAN_SHIM_PATH };
	return { ...base, JITI_ALIAS: JSON.stringify(existing) };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Obsidian's byte-to-hex helper, imported by `src/sync/diskMirror.ts`,
 * `blobSync.ts`, `main.ts` and `frontmatterGuardCoordinator.ts` for content
 * fingerprints and baseline hashes.
 *
 * Lowercase, two digits per byte, no separators. The format is load-bearing:
 * every persisted baseline hash is one of these strings, so a change of shape
 * would invalidate all of them.
 */
export function arrayBufferToHex(data: ArrayBuffer): string {
	return Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Obsidian's path rule: backslashes and duplicate slashes collapse to a single
 * forward slash, leading and trailing slashes are stripped, the result is
 * NFC-normalized, and the empty path is the vault root `"/"`.
 *
 * This is load-bearing, not cosmetic. `VaultSync` keys CRDT entries by
 * `normalizePath` output while `canonicalizeVaultPath` keys identity by its own
 * NFC-folded form; a shim that skipped NFC here would make the two disagree for
 * every decomposed filename the daemon reads off a macOS-formatted volume, and
 * the same file would appear twice.
 */
export function normalizePath(path: string): string {
	const cleaned = path
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.normalize("NFC");
	return cleaned === "" ? "/" : cleaned;
}

// ---------------------------------------------------------------------------
// Vault entries
// ---------------------------------------------------------------------------

/** Obsidian's `FileStats`. Times are epoch milliseconds, size is bytes. */
export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

/**
 * Base class for vault entries.
 *
 * Production never constructs one; it reads `path`/`name` and discriminates
 * with `instanceof TFile`. `vault` is deliberately absent — nothing on the
 * daemon's paths reads it, and inventing a fake `Vault` back-reference would be
 * a lie a caller could act on.
 */
export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
}

/**
 * A file in the vault index.
 *
 * `stat` must be populated by whoever creates it: `DiskMirror`'s suppression
 * gate reads `file.stat.size` and compares it against an expected byte count.
 */
export class TFile extends TAbstractFile {
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
	basename = "";
	extension = "";
}

/**
 * A folder in the vault index.
 *
 * Its existence is what lets a caller tell "a directory is in the way" from
 * "nothing is there" — the classification `DiskMirror.handleRemoteRename` makes
 * before it decides whether to move a file or trash it.
 */
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === "" || this.path === "/";
	}
}

// ---------------------------------------------------------------------------
// UI surfaces that a daemon does not have
// ---------------------------------------------------------------------------

/**
 * A user-visible message.
 *
 * Headless, the user is whoever reads the journal, so a Notice is a stderr
 * line. It goes to stderr and not stdout because stdout carries the daemon's
 * readiness protocol.
 */
export class Notice {
	readonly noticeEl: unknown = null;

	constructor(message: string | DocumentFragment, _duration?: number) {
		process.stderr.write(`[yaos] ${typeof message === "string" ? message : "[DocumentFragment]"}\n`);
	}

	setMessage(message: string | DocumentFragment): this {
		process.stderr.write(`[yaos] ${typeof message === "string" ? message : "[DocumentFragment]"}\n`);
		return this;
	}

	hide(): void {
		// Nothing to hide.
	}
}

/** Present so `instanceof MarkdownView` resolves. Never constructed headless. */
export class MarkdownView {
	file: TFile | null = null;
	editor: unknown = null;
}

/** Present so `instanceof Modal` and `class X extends Modal` resolve. */
export class Modal {
	constructor(readonly app?: unknown) {}
	open(): void {
		// No window to open.
	}
	close(): void {
		// Nothing was opened.
	}
	onOpen(): void {}
	onClose(): void {}
}

/** Present so `class YaosPlugin extends Plugin` resolves at module load. */
export class Plugin {
	constructor(
		readonly app?: unknown,
		readonly manifest?: unknown,
	) {}
	onload(): void {}
	onunload(): void {}
	addCommand(_command: unknown): unknown {
		return null;
	}
	addSettingTab(_tab: unknown): void {}
	registerEvent(_event: unknown): void {}
	registerInterval(_id: number): number {
		return 0;
	}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
}

/** Present so `class VaultSyncSettingTab extends PluginSettingTab` resolves. */
export class PluginSettingTab {
	readonly containerEl: unknown = null;

	constructor(
		readonly app: unknown,
		readonly plugin: unknown,
	) {}

	display(): void {}
	hide(): void {}
}

/** Present so `class App` type/value imports resolve. Never constructed. */
export class App {}

/**
 * Obsidian's public CodeMirror field carrying the editor's file info.
 *
 * There is no CodeMirror in a daemon, so this is an opaque sentinel. The only
 * consumer, `EditorBindingManager.getCmView`, reads it inside a live editor
 * callback that headless code never reaches.
 */
export const editorInfoField: unknown = Object.freeze({
	__yaosHeadlessSentinel: "editorInfoField",
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The Obsidian app version this process is pretending to be.
 *
 * There is no Obsidian app. `0.0.0` is the honest answer and it is also the
 * safe one: the only consumers compare it against a plugin's `minAppVersion`,
 * and the correct outcome of that comparison in a daemon is "cannot install".
 */
export const apiVersion = "0.0.0";

/** The real platform, read from the process rather than guessed. */
export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: process.platform === "darwin",
	isWin: process.platform === "win32",
	isLinux: process.platform === "linux",
	isSafari: false,
	isPhone: false,
	isTablet: false,
	resourcePathPrefix: "",
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

/**
 * Obsidian's CORS-free HTTP helper, implemented over Node's `fetch`.
 *
 * A real request, because a daemon can make one. Semantics copied from the
 * documented behaviour: the response body is buffered once and exposed three
 * ways, `json` throws on a non-JSON body only when it is read (so it is
 * computed lazily via a getter), and a status >= 400 throws unless
 * `throw: false` was passed.
 */
export async function requestUrl(
	request: RequestUrlParam | string,
): Promise<RequestUrlResponse> {
	const param: RequestUrlParam =
		typeof request === "string" ? { url: request } : request;
	const headers: Record<string, string> = { ...param.headers };
	if (param.contentType !== undefined) headers["Content-Type"] = param.contentType;

	const response = await fetch(param.url, {
		method: param.method ?? "GET",
		headers,
		body: param.body as BodyInit | undefined,
	});
	const buffer = await response.arrayBuffer();
	const text = new TextDecoder().decode(buffer);
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	if (response.status >= 400 && param.throw !== false) {
		throw new Error(`Request failed, status ${response.status}`);
	}

	return {
		status: response.status,
		headers: responseHeaders,
		arrayBuffer: buffer,
		text,
		get json(): unknown {
			const parsed: unknown = JSON.parse(text);
			return parsed;
		},
	};
}
