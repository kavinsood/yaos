/**
 * Browser globals the sync engine assumes, installed for the Node daemon.
 *
 * The executable entry imports this module in a tiny static graph, then loads
 * the real CLI through `await import("./cli")`. That dynamic boundary ensures
 * these assignments finish before anything evaluates the provider graph.
 *
 * Two independent needs, and they pull in opposite directions:
 *
 *  1. `src/sync/vaultSync.ts` and `src/runtime/reconciliationController.ts`
 *     schedule through `window.setTimeout` / `window.clearTimeout` at roughly
 *     a dozen sites. Aliasing `window` to `globalThis` satisfies all of them.
 *     Node's timers return a `Timeout` object where the DOM types promise a
 *     number; that only ever travels back into `clearTimeout`, which accepts
 *     it, so the lie is contained.
 *
 *  2. Defining `window` flips the y-partyserver provider onto its browser
 *     branch (dist/provider/index.js, `typeof window !== "undefined"`), where
 *     it registers an unload handler via `addEventListener`. Node's
 *     `globalThis` has no such method, so every `new YSyncProvider(...)` would
 *     throw. Inert no-ops are the honest answer, not a workaround: Node has no
 *     unload event to hook, and `provider.destroy()` already releases
 *     awareness on the shutdown path the daemon actually takes.
 *
 * `tests/harness.ts` and `tests/conformance/client.ts` install the same pair
 * for the same reasons; this is that arrangement, not a new one.
 */

const globals = globalThis as unknown as Record<string, unknown>;

if (typeof globals.window === "undefined") {
	globals.window = globalThis;
}

const windowGlobals = globals.window as Record<string, unknown>;

for (const method of ["addEventListener", "removeEventListener"] as const) {
	if (typeof windowGlobals[method] !== "function") {
		windowGlobals[method] = () => {
			/* Node has no unload event; nothing to register or release. */
		};
	}
}
