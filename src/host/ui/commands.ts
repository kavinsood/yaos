/**
 * Command palette entries: ids, names and when each is available. Pure; registerUi binds the
 * actions. Obsidian prefixes ids with the plugin id ("yaos:yaos-pause").
 */

import { pendingBrake, type YaosUiHost } from "./api";
import { engineAcceptsCommands, isPaused } from "./settingsModel";

export type UiCommandId =
	| "yaos-pause"
	| "yaos-resume"
	| "yaos-reconcile-now"
	| "yaos-export-diagnostics"
	| "yaos-show-brake"
	| "yaos-pair-device"
	| "yaos-pair-another-device";

export interface UiCommandSpec {
	readonly id: UiCommandId;
	readonly name: string;
	readonly available: (host: Pick<YaosUiHost, "data" | "status" | "runState" | "brake">) => boolean;
}

export const UI_COMMANDS: readonly UiCommandSpec[] = Object.freeze([
	{ id: "yaos-pause", name: "Pause sync", available: (h) => engineAcceptsCommands(h.runState()) && !isPaused(h.status()) },
	{ id: "yaos-resume", name: "Resume sync", available: (h) => engineAcceptsCommands(h.runState()) && isPaused(h.status()) },
	{ id: "yaos-reconcile-now", name: "Sync now (full rescan)", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-export-diagnostics", name: "Export diagnostics", available: (h) => engineAcceptsCommands(h.runState()) },
	{ id: "yaos-show-brake", name: "Review held changes", available: (h) => pendingBrake(h) !== null },
	{ id: "yaos-pair-device", name: "Pair this device", available: () => true },
	{ id: "yaos-pair-another-device", name: "Pair another device", available: (h) => h.data().identity !== null },
] satisfies UiCommandSpec[]);
