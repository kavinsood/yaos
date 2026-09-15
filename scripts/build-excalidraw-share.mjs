#!/usr/bin/env node

import esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".");
const source = resolve(root, "browser/excalidraw-share");
const output = resolve(root, "server/public/share");
const bundlePath = resolve(output, "app.js");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

await esbuild.build({
	absWorkingDir: root,
	entryPoints: [resolve(source, "app.ts")],
	outfile: bundlePath,
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["es2020"],
	minify: true,
	legalComments: "none",
	sourcemap: false,
	banner: { js: "window.EXCALIDRAW_ASSET_PATH='/share/';" },
	define: {
		"process.env.NODE_ENV": '"production"',
	},
});

const bundle = readFileSync(bundlePath, "utf8");
const fallbackStart = bundle.indexOf("`https://esm.sh/");
const fallbackEndMarker = "/dist/prod/`";
const fallbackEnd = bundle.indexOf(fallbackEndMarker, fallbackStart);
if (fallbackStart < 0 || fallbackEnd < 0
	|| bundle.indexOf("`https://esm.sh/", fallbackStart + 1) >= 0) {
	throw new Error("Could not uniquely replace Excalidraw's pinned external font fallback");
}
const localFallback = 'new URL("/share/",window.location.origin).toString()';
const selfHostedBundle = bundle.slice(0, fallbackStart) + localFallback
	+ bundle.slice(fallbackEnd + fallbackEndMarker.length);
if (selfHostedBundle.includes("https://esm.sh/")) {
	throw new Error("Excalidraw share bundle still contains an external font fallback");
}
writeFileSync(bundlePath, selfHostedBundle);

const excalidrawCss = readFileSync(resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/index.css"), "utf8");
const appCss = readFileSync(resolve(source, "app.css"), "utf8").replace(/^@import[^\n]+\n+/u, "");
writeFileSync(resolve(output, "app.css"), `${excalidrawCss}\n${appCss}`);
cpSync(resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"), resolve(output, "fonts"), { recursive: true });
cpSync(resolve(source, "index.html"), resolve(output, "index.html"));

console.log("Built the YAOS read-only Excalidraw share application.");
