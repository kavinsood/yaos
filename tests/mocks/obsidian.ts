/**
 * Minimal runtime mock for the "obsidian" package.
 *
 * The real obsidian package ships only TypeScript declaration files with no
 * runtime JavaScript. Tests that import code which depends on obsidian
 * (e.g. DiskMirror) need a runtime stand-in for the symbols they actually call.
 *
 * Only the symbols that DiskMirror uses at runtime are provided here.
 * Type-only imports (App, etc.) compile away and need no runtime value.
 *
 * Use via JITI_ALIAS: { "obsidian": "<path-to-this-file>" }
 */
/** Identity normalization — adequate for test paths that don't need slash fixup. */
export function normalizePath(path: string): string {
	return path;
}

/** Stub class. Passed as an argument to app.workspace.getActiveViewOfType(). */
export class MarkdownView {}

/** Stub class. Used in instanceof checks inside DiskMirror's vault event handlers. */
export class TFile {}

/** Notice constructor used by runtime controllers. */
export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

/** Stub class. Type-only in DiskMirror but exported for completeness. */
export class App {}
/** Base classes needed by declarative settings tests. */
export class Plugin {}

export const Platform = {
	isAndroidApp: false,
	isIosApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
	isLinux: true,
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
	isSafari: false,
	resourcePathPrefix: "",
};

export class PluginSettingTab {
	readonly app: App;
	readonly plugin: Plugin;
	updateCount = 0;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	update(): void {
		this.updateCount++;
	}
}


/** Stub class. ConfirmModal extends Modal — needs to exist as a constructor. */
export class Modal {
	constructor(_app?: unknown) {}
	open(): void {}
	close(): void {}
}

/** Not called in observer/scheduling paths — stub for completeness. */
export function arrayBufferToHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}
