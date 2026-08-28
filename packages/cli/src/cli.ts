import { CleanupStack } from "./cleanup";
import {
	ConfigError,
	EXIT,
	parseArgs,
	resolveDaemonConfig,
	resolveEnrollmentConfig,
	resolveRealVaultPath,
} from "./config";
import { DaemonEngine, FatalAuthError, StartupError } from "./engine";
import { enrollDevice, EnrollmentError } from "./enrollment";
import { acquireProcessLock, LockHeldError } from "./lock";
import { NodeVaultDatabaseIdentityError } from "./nodeVaultDatabase";
import {
	prepareStatePaths,
	readEnrollmentState,
	StateProvisioningMismatchError,
	StateIdentityError,
	validateStateIdentity,
} from "./state";

function log(message: string): void {
	process.stderr.write(`[yaos] ${message}\n`);
}

async function run(): Promise<number> {
	let parsed;
	let realVaultPath: string;
	try {
		parsed = parseArgs(process.argv);
		realVaultPath = await resolveRealVaultPath(parsed.vaultPath);
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`);
			return EXIT.failure;
		}
		throw error;
	}

	const paths = await prepareStatePaths(realVaultPath);
	const cleanup = new CleanupStack();
	try {
		const lock = await acquireProcessLock(paths.lockFile);
		cleanup.defer(() => lock.release());
		if (parsed.command === "enroll") {
			const membership = await enrollDevice(
				resolveEnrollmentConfig(parsed, process.env),
				realVaultPath,
				paths,
			);
			process.stdout.write(`YAOS_ENROLLED ${membership.vaultId} ${membership.deviceId}\n`);
			return EXIT.ok;
		}

		const config = resolveDaemonConfig(parsed, process.env);
		const state = await readEnrollmentState(paths);
		if (!state?.membership) {
			throw new ConfigError(`This vault path is not enrolled. Run \`yaos enroll ${parsed.vaultPath}\` first.`);
		}
		validateStateIdentity(state, realVaultPath);
		const engine = new DaemonEngine(
			config,
			realVaultPath,
			state.membership,
			paths,
			cleanup,
			log,
		);

		let requestedCode: number | null = null;
		let finish: (code: number) => void = () => undefined;
		const finished = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const requestStop = (signal: NodeJS.Signals): void => {
			if (requestedCode !== null) return;
			requestedCode = EXIT.ok;
			log(`${signal} received — draining`);
			finish(EXIT.ok);
		};
		const onSigterm = () => requestStop("SIGTERM");
		const onSigint = () => requestStop("SIGINT");
		process.on("SIGTERM", onSigterm);
		process.on("SIGINT", onSigint);
		cleanup.defer(() => {
			process.off("SIGTERM", onSigterm);
			process.off("SIGINT", onSigint);
		});
		engine.onFatalAuth((error) => {
			if (requestedCode !== null) return;
			requestedCode = EXIT.fatalAuth;
			log(error.message);
			finish(EXIT.fatalAuth);
		});

		try {
			await engine.start();
			if (requestedCode === null) {
				process.stdout.write(`YAOS_DAEMON_READY ${state.membership.vaultId}\n`);
				log("ready");
			}
			return requestedCode ?? await finished;
		} finally {
			await engine.stop();
		}
	} catch (error) {
		if (error instanceof LockHeldError) {
			log(error.message);
			return EXIT.locked;
		}
		if (error instanceof StateProvisioningMismatchError) {
			log(error.message);
			return EXIT.fatalAuth;
		}
		if (error instanceof NodeVaultDatabaseIdentityError) {
			log(error.message);
			return error.fatal ? EXIT.fatalAuth : EXIT.failure;
		}
		if (error instanceof FatalAuthError) {
			log(error.message);
			return EXIT.fatalAuth;
		}
		if (error instanceof ConfigError
			|| error instanceof EnrollmentError
			|| error instanceof StartupError
			|| error instanceof StateIdentityError) {
			log(error.message);
			return EXIT.failure;
		}
		log(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		return EXIT.failure;
	} finally {
		await cleanup.dispose().catch((error: unknown) => {
			log(`Cleanup error: ${String(error)}`);
		});
	}
}

const exitCode = await run();
process.exit(exitCode);
