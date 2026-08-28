/**
 * ObsidianInternalsPort — the undocumented Obsidian surfaces the QA harness reads.
 *
 * obsidian.d.ts declares the public plugin API. Three things the harness cannot
 * do without are absent from it:
 *
 *   - app.plugins.plugins  — the loaded-plugin registry, how the harness reaches
 *     the product plugin instance it drives (qa/obsidian-harness/main.ts) and how
 *     it reports installed versions (qa/obsidian-harness/api.ts).
 *   - app.commands         — command execution by id and the command-id list,
 *     used to drive real command-palette paths (qa/obsidian-harness/editor-ops.ts).
 *   - MarkdownView._filePath — the last path a view was bound to, which survives
 *     the file being deleted (at which point `view.file` is null).
 *
 * These exist at runtime; only the declaration is missing. So this module
 * declares the shape once, checks it once at the boundary, and hands callers
 * ordinary typed values. That keeps the reads at the call sites cast-free, and
 * — because each accessor validates before it returns — an Obsidian release that
 * moves one of these surfaces to a new name becomes a named error instead of a
 * `TypeError: undefined is not an object` in the middle of a scenario.
 *
 * Nothing here mutates. Scenario control and unsafe mutation live in
 * ./yaosUnsafeQaPort.ts; the product plugin's own private surface lives behind
 * the ProductInternals shape in qa/obsidian-harness/main.ts.
 */

import type { App, MarkdownView, PluginManifest } from "obsidian";

/**
 * A loaded plugin instance as Obsidian stores it in app.plugins.plugins.
 *
 * The index signature is what makes the harness's startup probe of the product
 * plugin's private members expressible: it reads members by name and gets
 * `unknown` back, which is the truth — nothing about a foreign plugin instance
 * is known beyond its manifest.
 */
export interface ObsidianPluginInstance {
	readonly manifest: PluginManifest;
	readonly [member: string]: unknown;
}

/** app.plugins — Obsidian's plugin manager. Only the registry map is declared. */
export interface ObsidianPluginRegistry {
	/**
	 * Enabled plugins by manifest id. Reads through an id go via
	 * noUncheckedIndexedAccess, so callers must handle "not loaded".
	 */
	readonly plugins: Readonly<Record<string, ObsidianPluginInstance>>;
}

/** app.commands — Obsidian's command registry. */
export interface ObsidianCommandRegistry {
	/** Every registered command, keyed by id. The values themselves are not read. */
	readonly commands: Readonly<Record<string, unknown>>;
	/** Runs a command by id; false when no such command is registered. */
	executeCommandById(id: string): boolean | Promise<boolean>;
}

function isPluginRegistry(value: unknown): value is ObsidianPluginRegistry {
	if (
		typeof value !== "object"
		|| value === null
		|| !("plugins" in value)
		|| typeof value.plugins !== "object"
		|| value.plugins === null
		|| Array.isArray(value.plugins)
	) {
		return false;
	}
	return Object.values(value.plugins).every((plugin) =>
		typeof plugin === "object"
		&& plugin !== null
		&& "manifest" in plugin
		&& typeof plugin.manifest === "object"
		&& plugin.manifest !== null);
}

function isCommandRegistry(value: unknown): value is ObsidianCommandRegistry {
	return typeof value === "object"
		&& value !== null
		&& "commands" in value
		&& typeof value.commands === "object"
		&& value.commands !== null
		&& !Array.isArray(value.commands)
		&& "executeCommandById" in value
		&& typeof value.executeCommandById === "function";
}

/**
 * The plugin registry, or null when Obsidian does not expose one.
 *
 * Null rather than throw: the harness's first guard reports a missing registry
 * as a load-order/build problem with a fix-it hint, and that message is far more
 * useful to whoever is running QA than a stack trace out of onload().
 */
export function getPluginRegistry(app: App): ObsidianPluginRegistry | null {
	const registry: unknown = app.plugins;
	return isPluginRegistry(registry) ? registry : null;
}

/**
 * The command registry.
 *
 * Throws, unlike getPluginRegistry: every caller is a scenario step with nothing
 * to fall back to, so an unrunnable command has to fail the scenario.
 */
export function getCommandRegistry(app: App): ObsidianCommandRegistry {
	const registry: unknown = Reflect.get(app, "commands");
	if (!isCommandRegistry(registry)) {
		throw new Error(
			"[YAOS QA] app.commands is not available — Obsidian's command registry " +
			"moved, or this is not an Obsidian renderer.",
		);
	}
	return registry;
}

/** MarkdownView members Obsidian does not declare. */
interface MarkdownViewInternals {
	/**
	 * The path the view is bound to, retained after the file is deleted — at
	 * which point `view.file` is null but the leaf is still open.
	 */
	readonly _filePath?: string;
}

/**
 * The path a MarkdownView is, or last was, bound to.
 *
 * `view.file?.path` is the declared answer and is correct while the file
 * exists. After a delete it goes null while the leaf lives on, so a caller
 * looking for "the leaf that was showing this path" has to fall back to
 * `_filePath`; closeFile() relies on that to detach leaves for deleted files
 * rather than leaving them to fail binding-health checks.
 */
export function markdownViewPath(view: MarkdownView): string | undefined {
	const internals: MarkdownView & MarkdownViewInternals = view;
	return view.file?.path ?? internals._filePath;
}
