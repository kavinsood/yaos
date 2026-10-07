import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BUNDLE_FUNCTION_NAME, workerScript, workerScriptFrom } from "./bundleSource";

test("outside the built bundle there is no worker script (the plugin cannot start its worker)", () => {
	assert.equal(workerScript(), null);
});

test("workerScriptFrom rejects text that is not the bundle wrapper", () => {
	assert.equal(workerScriptFrom("function () { [native code] }"), null);
	assert.equal(workerScriptFrom(`function other(require, module, exports, s) {}`), null);
	assert.equal(workerScriptFrom(`function ${BUNDLE_FUNCTION_NAME}(require, module, exports, s) {`), null, "truncated");
});

test("the worker script calls the wrapper with the worker scope, and a require that refuses main-thread modules", () => {
	// Same shape as esbuild.config.mjs's banner/footer; the body stands in for host/entry.ts.
	const wrapper = `function ${BUNDLE_FUNCTION_NAME}(require, module, exports, __yaosWorkerScope) {
		"use strict";
		if (__yaosWorkerScope) { __yaosWorkerScope.started = true; try { require("obsidian"); } catch (e) { __yaosWorkerScope.requireError = e.message; } }
		else module.exports = { main: true };
	}`;
	const script = workerScriptFrom(wrapper);
	assert.ok(script);
	const scope: { self?: unknown; started?: boolean; requireError?: string } = {};
	scope.self = scope;
	vm.runInNewContext(script, scope);
	assert.equal(scope.started, true);
	assert.match(scope.requireError ?? "", /module "obsidian" is main-thread only/);
});
