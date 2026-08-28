import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { builtinModules } from "node:module";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, resolveStateDirectoryOverride } from "../src/config.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, "../..");
const work = mkdtempSync(path.join(tmpdir(), "yaos-cli-smoke-"));

function command(program: string, args: string[], cwd: string): SpawnSyncReturns<string> {
	const result = spawnSync(program, args, { cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
	if (result.status !== 0) {
		throw new Error(`${program} ${args.join(" ")} failed (${String(result.status)})\n${result.stdout}${result.stderr}`);
	}
	return result;
}
function createIsolatedInstall(
	root: string,
	artifact: string,
	manifest: { dependencies?: Record<string, string> },
): string {
	const packageDirectory = path.join(root, "node_modules", "@yaos", "cli");
	const installedArtifact = path.join(packageDirectory, "dist", "yaos.mjs");
	mkdirSync(path.dirname(installedArtifact), { recursive: true });
	copyFileSync(artifact, installedArtifact);
	writeFileSync(
		path.join(packageDirectory, "package.json"),
		JSON.stringify({ name: "@yaos/cli", type: "module", dependencies: manifest.dependencies ?? {} }),
	);
	for (const dependency of Object.keys(manifest.dependencies ?? {})) {
		const segments = dependency.split("/");
		const source = path.join(repositoryRoot, "node_modules", ...segments);
		if (!existsSync(source)) throw new Error(`declared dependency is not installed: ${dependency}`);
		const target = path.join(root, "node_modules", ...segments);
		mkdirSync(path.dirname(target), { recursive: true });
		symlinkSync(source, target, "dir");
	}
	return installedArtifact;
}

function expectInvalidStateDirectory(value: string): void {
	try {
		resolveStateDirectoryOverride({ YAOS_STATE_DIR: value });
	} catch (error) {
		if (error instanceof ConfigError) return;
		throw error;
	}
	throw new Error("invalid YAOS_STATE_DIR was accepted");
}


try {
	const outdir = path.join(work, "dist");
	command(process.execPath, [path.join(packageRoot, "esbuild.config.mjs"), `--outdir=${outdir}`], repositoryRoot);
	const artifact = path.join(outdir, "yaos.mjs");
	const source = readFileSync(artifact, "utf8");
	if (!source.startsWith("#!/usr/bin/env node")) throw new Error("built CLI has no shebang");
	if (/JITI_ALIAS|jiti\/register/.test(source)) throw new Error("built CLI retained development loader state");

	const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
	const imports = new Set<string>();
	for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
		const specifier = match[1]!;
		if (/\.tsx?$/.test(specifier)) throw new Error(`built CLI retained TypeScript import: ${specifier}`);
		if (specifier.startsWith(".") || specifier.startsWith("/") || builtins.has(specifier)) continue;
		imports.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
	}
	const declared = new Set(Object.keys(manifest.dependencies ?? {}));
	for (const imported of imports) {
		if (!declared.has(imported)) throw new Error(`undeclared runtime dependency: ${imported}`);
	}
	for (const dependency of declared) {
		if (!imports.has(dependency)) throw new Error(`declared dependency is not imported: ${dependency}`);
	}
	const installedArtifact = createIsolatedInstall(path.join(work, "install"), artifact, manifest);
	const help = spawnSync(process.execPath, [installedArtifact, "--help"], {
		cwd: work,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: work,
			XDG_STATE_HOME: path.join(work, "state"),
		},
	});
	if (help.status !== 1 || !`${help.stdout}${help.stderr}`.includes("yaos enroll <vaultPath>")) {
		throw new Error(`plain Node help contract failed\n${help.stdout}${help.stderr}`);
	}

	expectInvalidStateDirectory("");
	expectInvalidStateDirectory(" \t ");
	expectInvalidStateDirectory("invalid\0path");

	const vault = path.join(work, "vault");
	const xdgState = path.join(work, "xdg-state");
	const relativeOverride = "explicit-state";
	const explicitState = path.join(work, relativeOverride);
	const pairingCode = "pairing-secret-never-log";
	mkdirSync(vault);
	const sharedEnv = {
		PATH: process.env.PATH ?? "",
		HOME: work,
		NODE_OPTIONS: "",
		XDG_STATE_HOME: xdgState,
		YAOS_STATE_DIR: relativeOverride,
	};
	const enrollment = spawnSync(process.execPath, [installedArtifact, "enroll", vault], {
		cwd: work,
		encoding: "utf8",
		env: {
			...sharedEnv,
			YAOS_HOST: "http://127.0.0.1:1",
			YAOS_PAIRING_CODE: pairingCode,
		},
	});
	const enrollmentOutput = `${enrollment.stdout}${enrollment.stderr}`;
	if (enrollment.status !== 1 || !enrollmentOutput.includes("durable request can be retried")) {
		throw new Error(`override enrollment contract failed\n${enrollmentOutput}`);
	}
	if (enrollmentOutput.includes(pairingCode)) throw new Error("pairing code appeared in CLI output");
	const enrollmentFile = path.join(explicitState, "enrollment.json");
	if (!existsSync(enrollmentFile)) throw new Error("enrollment did not use YAOS_STATE_DIR as its leaf");
	if (existsSync(xdgState)) throw new Error("YAOS_STATE_DIR silently fell back to XDG_STATE_HOME");
	if ((statSync(explicitState).mode & 0o777) !== 0o700) throw new Error("state leaf is not mode 0700");
	if ((statSync(enrollmentFile).mode & 0o777) !== 0o600) throw new Error("enrollment state is not mode 0600");

	const parsedState: unknown = JSON.parse(readFileSync(enrollmentFile, "utf8"));
	if (typeof parsedState !== "object" || parsedState === null || Array.isArray(parsedState)) {
		throw new Error("persisted enrollment state is not an object");
	}
	const persistedState = parsedState as Record<string, unknown>;
	const pending = persistedState.pending;
	if (typeof pending !== "object" || pending === null || Array.isArray(pending)) {
		throw new Error("persisted enrollment state has no pending identity");
	}
	const pendingRecord = pending as Record<string, unknown>;
	if (typeof persistedState.host !== "string"
		|| typeof pendingRecord.deviceId !== "string"
		|| typeof pendingRecord.deviceToken !== "string") {
		throw new Error("persisted enrollment identity is incomplete");
	}
	persistedState.realVaultPath = path.join(work, "different-vault");
	persistedState.membership = {
		host: persistedState.host,
		vaultId: "vault-id",
		vaultGeneration: "vault-generation",
		deviceId: pendingRecord.deviceId,
		deviceToken: pendingRecord.deviceToken,
		deviceName: "headless-device",
		originImport: false,
		originImportPending: false,
	};
	persistedState.pending = null;
	writeFileSync(enrollmentFile, `${JSON.stringify(persistedState)}\n`);
	const daemon = spawnSync(process.execPath, [installedArtifact, "daemon", vault], {
		cwd: work,
		encoding: "utf8",
		env: sharedEnv,
	});
	const daemonOutput = `${daemon.stdout}${daemon.stderr}`;
	if (daemon.status !== 1 || !daemonOutput.includes("Enrollment state belongs to a different real vault path")) {
		throw new Error(`daemon did not read and validate enrollment's YAOS_STATE_DIR leaf\n${daemonOutput}`);
	}
	const invalidStateFile = path.join(work, "invalid-state-file");
	const invalidXdgState = path.join(work, "invalid-xdg-state");
	writeFileSync(invalidStateFile, "not a directory");
	const invalidOverride = spawnSync(process.execPath, [installedArtifact, "daemon", vault], {
		cwd: work,
		encoding: "utf8",
		env: {
			...sharedEnv,
			XDG_STATE_HOME: invalidXdgState,
			YAOS_STATE_DIR: invalidStateFile,
		},
	});
	const invalidOverrideOutput = `${invalidOverride.stdout}${invalidOverride.stderr}`;
	if (invalidOverride.status !== 1
		|| !invalidOverrideOutput.includes("State directory is not accessible")
		|| invalidOverrideOutput.includes("ConfigError")) {
		throw new Error(`invalid YAOS_STATE_DIR config contract failed\n${invalidOverrideOutput}`);
	}
	if (existsSync(invalidXdgState)) throw new Error("invalid YAOS_STATE_DIR silently fell back to XDG_STATE_HOME");
	const emptyXdgState = path.join(work, "empty-xdg-state");
	const emptyOverride = spawnSync(process.execPath, [installedArtifact, "daemon", vault], {
		cwd: work,
		encoding: "utf8",
		env: {
			...sharedEnv,
			XDG_STATE_HOME: emptyXdgState,
			YAOS_STATE_DIR: "",
		},
	});
	const emptyOverrideOutput = `${emptyOverride.stdout}${emptyOverride.stderr}`;
	if (emptyOverride.status !== 1
		|| !emptyOverrideOutput.includes("YAOS_STATE_DIR must be a non-empty valid directory path")
		|| emptyOverrideOutput.includes("ConfigError")) {
		throw new Error(`empty YAOS_STATE_DIR config contract failed\n${emptyOverrideOutput}`);
	}
	if (existsSync(emptyXdgState)) throw new Error("empty YAOS_STATE_DIR silently fell back to XDG_STATE_HOME");
	process.stdout.write("[cli:smoke] PASS — bundled CLI starts under plain Node and honors secure explicit state leaves\n");
} finally {
	rmSync(work, { recursive: true, force: true });
}
