#!/usr/bin/env node
// The server is an opaque streams relay (docs/server-rewrite/DECISIONS.md §1): it holds no CRDT state, so no file
// under server/src may import yjs or y-protocols.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("server/src");
const violations = [];

function visit(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) visit(path);
		else if (entry.name.endsWith(".ts")) {
			const source = readFileSync(path, "utf8");
			if (/from\s+["'](?:yjs|y-protocols(?:\/[^"']*)?)["']|require\(["'](?:yjs|y-protocols(?:\/[^"']*)?)["']\)/.test(source)) {
				violations.push(relative(root, path));
			}
		}
	}
}

visit(root);
if (violations.length > 0) {
	console.error(`server/src must not import yjs or y-protocols:\n${violations.join("\n")}`);
	process.exit(1);
}
console.log("server/src imports no yjs or y-protocols.");
