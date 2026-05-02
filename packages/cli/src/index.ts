#!/usr/bin/env node

import { Command, InvalidOptionArgumentError, Option } from "commander";
import type { CliCommandOptions, ResolvedCliConfig } from "./config";
import { requireRuntimeConfig, resolveCliConfig } from "./config";
import { exitCodeForError, HeadlessCliError } from "./errors";
import { createNodeVaultSync, HeadlessYaosClient } from "./nodeVaultSync";

const program = new Command();

program
	.name("yaos-cli")
	.description("Headless YAOS client for filesystem-backed Markdown vaults")
	.showHelpAfterError()
	.exitOverride();

addCommonOptions(
	program
		.command("daemon")
		.description("Run the headless YAOS client and keep watching the vault")
		.action(async (options: CliCommandOptions) => {
			const resolved = await resolveCliConfig(options);
			const runtime = requireRuntimeConfig(resolved, { requireDir: true });
			const client = new HeadlessYaosClient(runtime);
			const startup = await client.startup({ watch: true });
			console.log(JSON.stringify({
				mode: "daemon",
				config: summarizeConfig(runtime),
				startup,
				status: client.getStatus(),
			}, null, 2));
			await waitForShutdown(client);
		}),
	{ includeDir: true },
);

addCommonOptions(
	program
		.command("sync")
		.description("Perform one reconciliation pass and exit")
		.action(async (options: CliCommandOptions) => {
			const resolved = await resolveCliConfig(options);
			const runtime = requireRuntimeConfig(resolved, { requireDir: true });
			const client = new HeadlessYaosClient(runtime);
			const stateStatus = client.getStatePersistenceStatus();
			if (!stateStatus.loaded) {
				console.warn(
					"WARN: No local YAOS state cache found. Downloading full vault history. " +
					"Future runs will use '.yaos-state.bin' for delta sync. " +
					"For continuous updates, use 'yaos-cli daemon' to prevent rate-limiting.",
				);
			}
			try {
				const startup = await client.startup({ watch: false });
				console.log(JSON.stringify({
					mode: "sync",
					config: summarizeConfig(runtime),
					startup,
					status: client.getStatus(),
				}, null, 2));
			} finally {
				await client.stop();
			}
		}),
	{ includeDir: true },
);

addCommonOptions(
	program
		.command("status")
		.description("Show current connection and local-cache status")
		.action(async (options: CliCommandOptions) => {
			const resolved = await resolveCliConfig(options);
			const runtime = requireRuntimeConfig(resolved, { requireDir: false });
			const vaultSync = createNodeVaultSync(runtime);
			try {
				const localLoaded = await vaultSync.waitForLocalPersistence();
				const providerSynced = await vaultSync.waitForProviderSync();
				if (vaultSync.fatalAuthError) {
					throw new HeadlessCliError(
						`Provider rejected the connection (${vaultSync.fatalAuthCode ?? "unknown"})`,
						vaultSync.fatalAuthCode,
					);
				}
				console.log(JSON.stringify({
					mode: "status",
					config: summarizeConfig(resolved),
					localLoaded,
					providerSynced,
					connected: vaultSync.connected,
					localReady: vaultSync.localReady,
					connectionGeneration: vaultSync.connectionGeneration,
					storedSchemaVersion: vaultSync.storedSchemaVersion,
					safeReconcileMode: vaultSync.getSafeReconcileMode(),
					fatalAuthError: vaultSync.fatalAuthError,
					fatalAuthCode: vaultSync.fatalAuthCode,
					activeMarkdownPaths: vaultSync.getActiveMarkdownPaths().length,
				}, null, 2));
			} finally {
				vaultSync.destroy();
			}
		}),
	{ includeDir: false },
);

program.parseAsync(process.argv).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const exitCode = exitCodeForError(error);
	if (exitCode !== 0) {
		process.stderr.write(`error: ${message}\n`);
	}
	process.exit(exitCode);
});

function addCommonOptions<T extends Command>(
	command: T,
	options: { includeDir: boolean },
): T {
	command
		.option("--host <url>", "YAOS server URL")
		.option("--token <token>", "YAOS sync token")
		.option("--vault-id <id>", "YAOS vault ID")
		.option("--device-name <name>", "Device name reported to YAOS")
		.option("--debug", "Enable verbose logging")
		.option("--exclude-patterns <csv>", "Comma-separated path prefixes to exclude")
		.addOption(
			new Option("--max-file-size-kb <number>", "Maximum markdown file size to sync")
				.argParser(parsePositiveInteger),
		)
		.addOption(
			new Option("--external-edit-policy <policy>", "How to treat local filesystem edits")
				.choices(["always", "closed-only", "never"]),
		);

	if (options.includeDir) {
		command.option("--dir <path>", "Vault directory to mirror");
	}

	return command;
}

function parsePositiveInteger(value: string): number {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new InvalidOptionArgumentError(`Expected a positive integer, received ${value}`);
	}
	return Number.parseInt(value, 10);
}

function summarizeConfig(config: ResolvedCliConfig): Record<string, unknown> {
	return {
		host: config.host ?? null,
		vaultId: config.vaultId ?? null,
		dir: config.dir ?? null,
		deviceName: config.deviceName,
		debug: config.debug,
		excludePatterns: config.excludePatterns,
		maxFileSizeKB: config.maxFileSizeKB,
		externalEditPolicy: config.externalEditPolicy,
		frontmatterGuardEnabled: config.frontmatterGuardEnabled,
		configDir: config.configDir,
		configPath: config.configPath,
	};
}

async function waitForShutdown(client: HeadlessYaosClient): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const finish = async () => {
			cleanup();
			try {
				await client.stop();
				resolve();
			} catch (error) {
				reject(error);
			}
		};

		const onSigint = () => {
			void finish();
		};
		const onSigterm = () => {
			void finish();
		};
		const cleanup = () => {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
		};

		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);
	});
}
