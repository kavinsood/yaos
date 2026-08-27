#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const useTestAliases = args[0] === "--test-aliases";
if (useTestAliases) args.shift();
const entry = args.shift();
if (!entry) {
	console.error("Usage: node tests/run-typescript.mjs [--test-aliases] <entry.ts> [...args]");
	process.exit(2);
}

const aliases = useTestAliases
	? {
		yjs: fileURLToPath(new URL("../node_modules/yjs/dist/yjs.mjs", import.meta.url)),
		"y-protocols": fileURLToPath(new URL("../node_modules/y-protocols", import.meta.url)),
		obsidian: fileURLToPath(new URL("./mocks/obsidian.ts", import.meta.url)),
		partyserver: fileURLToPath(new URL("./mocks/partyserver.ts", import.meta.url)),
		"@shared": fileURLToPath(new URL("../server/src/shared", import.meta.url)),
	}
	: {};
const target = resolve(ROOT, entry);
process.argv = [process.execPath, target, ...args];
const jiti = createJiti(import.meta.url, {
	alias: aliases,
	interopDefault: true,
	sourceMaps: true,
});

await jiti.import(target);
