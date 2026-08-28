#!/usr/bin/env node

// Static ESM dependencies are evaluated before an importing module's body.
// Config is safe to load here; keep the browser-global shim in this tiny entry
// graph, then cross a dynamic-import boundary before loading VaultSync and its
// y-partyserver provider.
import "./globals";
import { ConfigError, EXIT } from "./config";

try {
	await import("./cli");
} catch (error) {
	if (error instanceof ConfigError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(EXIT.failure);
	}
	throw error;
}
