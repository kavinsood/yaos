#!/usr/bin/env bun
/**
 * Non-destructively create a QA fixture vault at a brand-new destination.
 * The filesystem policy and preparation implementation live in
 * prepare-vault-lib.ts so they can be tested without invoking Bun.
 */

import {
	DEFAULT_PREPARE_VAULT_PATHS,
	PREPARE_VAULT_USAGE,
	parsePrepareVaultArgs,
	prepareVault,
} from "./prepare-vault-lib";

async function main(): Promise<void> {
	try {
		const args = parsePrepareVaultArgs(process.argv.slice(2));
		if (args.help) {
			console.log(PREPARE_VAULT_USAGE);
			return;
		}

		const prepared = await prepareVault(args, DEFAULT_PREPARE_VAULT_PATHS);
		console.log(`Vault ready: ${prepared.dest}`);
		console.log(`  fixture: ${prepared.fixture}`);
		if (prepared.enrollment.status === "enrolled") {
			console.log("  enrollment: enrolled with server-issued device credentials");
			console.log(`  host: ${prepared.enrollment.host}`);
			console.log(`  vaultId: ${prepared.enrollment.vaultId}`);
			console.log(`  deviceId: ${prepared.enrollment.deviceId}`);
			console.log(`  device name: ${prepared.enrollment.name}`);
		} else {
			console.log("  enrollment: UNENROLLED (no vault or device membership was generated)");
		}
		console.log("  plugin order: yaos, yaos-qa-harness");
		if (prepared.presetPlugins.length > 0) {
			console.log(`\nPreset "${prepared.preset}" requires these manually installed community plugins:`);
			for (const plugin of prepared.presetPlugins) {
				console.log(`  - ${plugin.id} >= ${plugin.minVersion}`);
			}
		}
		console.log("\nNext steps:");
		if (prepared.enrollment.status === "unenrolled") {
			console.log("  - Enroll with a fresh one-use pairing code, either in Obsidian or by preparing a new vault with --host, --pairing-code, and --device-name.");
		}
		console.log("  - Open the new vault in Obsidian and enable community plugins.");
		console.log("  - Launch with remote debugging: Obsidian --remote-debugging-port=9222");
		console.log("  - Open DevTools and run: __YAOS_QA__.help()");
	} catch (error) {
		console.error(`qa:prepare failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error(PREPARE_VAULT_USAGE);
		process.exitCode = 1;
	}
}

await main();
