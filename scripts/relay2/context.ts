/**
 * Relay v2 harness: claim a fresh yaos-relay2-* worker and seed the shared fixture.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts --host <url> [--devices A,B,C] [--seed standard|none]
 *        [--fresh-vault <label>]   (reused, already-claimed worker: new vault + devices via the operator console)
 *
 * Context (device tokens, operator key/cookie) → logs/relay2/context-<worker>.json (mode 600, never printed).
 * Standard seed: 100 × 4 KiB notes (r2-small-000..099) + r2-lat (4 KiB). Scenario-specific bodies are
 * created by bench.ts on demand.
 */
import { flagStr, log, parseArgs } from "./lib/common";
import { claim, device, freshVault, hasContext, loadContext, saveContext, seedNotes, smallContent, smallId } from "./lib/context";

export const SMALL_COUNT = 100;

export async function standardSeed(host: string) {
	const context = loadContext(host);
	if (context.seeded?.standard) { log("standard seed already present"); return; }
	const inputs = [
		...Array.from({ length: SMALL_COUNT }, (_v, i) => ({ bodyId: smallId(i), path: `R2/small-${String(i).padStart(3, "0")}.md`, content: smallContent(i) })),
		{ bodyId: "r2-lat", path: "R2/latency.md", content: smallContent(9999) },
	];
	const started = Date.now();
	const r = await seedNotes(context, inputs);
	context.seeded = { ...(context.seeded ?? {}), standard: { bodies: inputs.length, ms: Date.now() - started, requests: r.requests } };
	saveContext(context);
}

async function main() {
	const args = parseArgs();
	const host = flagStr(args, "host")!.replace(/\/+$/, "");
	const devices = (flagStr(args, "devices", "A,B") ?? "A,B").split(",");
	const fresh = flagStr(args, "fresh-vault");
	if (!hasContext(host)) {
		const claimed = await claim(host, devices.slice(0, 2));
		if (fresh) saveContext({ ...claimed, freshVault: { label: fresh, previousVaultId: "", createdAt: claimed.createdAt } });
	} else if (fresh) await freshVault(host, fresh, devices.slice(0, 2));
	const context = loadContext(host);
	for (const name of devices) await device(context, name);
	if ((flagStr(args, "seed", "standard")) === "standard") await standardSeed(host);
	log(`context ready: vault devices=${Object.keys(loadContext(host).devices).join(",")}`);
	process.exit(0);
}

if (process.argv[1]?.endsWith("relay2/context.ts")) main().catch((error) => { console.error(error); process.exit(1); });
