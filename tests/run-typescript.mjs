#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER_YWASM_ENGINE = fileURLToPath(new URL("../server/src/crdt/ywasmWorkerCrdtEngine", import.meta.url));
const NODE_YWASM_ENGINE = fileURLToPath(new URL("../packages/server-node/src/ywasmNodeCrdtEngine.ts", import.meta.url));
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
		"@yaos/crdt-engine": NODE_YWASM_ENGINE,
		yjs: fileURLToPath(new URL("../node_modules/yjs/dist/yjs.mjs", import.meta.url)),
		"y-protocols": fileURLToPath(new URL("../node_modules/y-protocols", import.meta.url)),
		obsidian: fileURLToPath(new URL("./mocks/obsidian.ts", import.meta.url)),
		partyserver: fileURLToPath(new URL("./mocks/partyserver.ts", import.meta.url)),
		"@shared": fileURLToPath(new URL("../server/src/shared", import.meta.url)),
		[WORKER_YWASM_ENGINE]: NODE_YWASM_ENGINE,
		[`${WORKER_YWASM_ENGINE}.js`]: NODE_YWASM_ENGINE,
		[`${WORKER_YWASM_ENGINE}.ts`]: NODE_YWASM_ENGINE,
		"./crdt/ywasmWorkerCrdtEngine": NODE_YWASM_ENGINE,
		"./crdt/ywasmWorkerCrdtEngine.js": NODE_YWASM_ENGINE,
		"./ywasmWorkerCrdtEngine": NODE_YWASM_ENGINE,
		"./ywasmWorkerCrdtEngine.js": NODE_YWASM_ENGINE,
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
