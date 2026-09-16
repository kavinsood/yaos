#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("server/src");
const allowed = new Set([
	"crdt/yjsCrdtEngine.ts",
	"shared/canvasSemanticDocument.ts",
	"shared/frontmatterSemanticValidation.ts",
]);
const violations = [];

function visit(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) visit(path);
		else if (entry.name.endsWith(".ts")) {
			const name = relative(root, path);
			if (allowed.has(name)) continue;
			const source = readFileSync(path, "utf8");
			if (/from\s+["']yjs["']|from\s+["']y-protocols\/sync["']|require\(["']yjs["']\)/.test(source)) {
				violations.push(name);
			}
		}
	}
}

visit(root);
if (violations.length > 0) {
	console.error(`Production server CRDT imports bypass the engine boundary:\n${violations.join("\n")}`);
	process.exit(1);
}
console.log("Production server CRDT imports are confined to the oracle/shared client adapters.");
