import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ControlPlaneRuntime } from "../../../server/src/config";
import { handleWorkerRequest, type WorkerRuntimeEnvironment } from "../../../server/src/index";
import type { ActorCallPort, ExecutionPort } from "../../../server/src/platformPorts";
import { RecoveryJobRuntime } from "../../../server/src/recoveryJob";
import { VaultRuntime } from "../../../server/src/server";
import type { VaultSocketPort } from "../../../server/src/vaultSocketService";
import { FilesystemObjectStore } from "./objectStore";
import {
	ActorRegistry,
	DataDirectoryLockedError,
	DurableAlarmScheduler,
	ProcessDataLock,
	type ActorFactory,
	type ActorKind,
	type AlarmPort,
	type RuntimeActor,
} from "./runtimeHost";
import { NodeSocketHub, NodeSocketRegistry } from "./socketHost";
import { NewerStorageVersionError, NodeDatabaseSet, type NodeSqliteStorage } from "./storage";
import { NodeTransport, type NodeTransportApplication, type WebSocketUpgradeResult } from "./transport";

export interface NodeServerOptions {
	readonly host: string;
	readonly port: number;
	readonly dataDirectory: string;
	readonly ticketTtlMs?: string;
	readonly enableAdminRoutes?: string;
	readonly drainTimeoutMs?: number;
}

export interface AlarmRetryOptions {
	readonly dataDirectory: string;
}

class CleanupStack {
	private readonly cleanups: Array<() => Promise<void> | void> = [];
	private disposing: Promise<void> | null = null;

	defer(cleanup: () => Promise<void> | void): void {
		this.cleanups.push(cleanup);
	}

	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.disposing = (async () => {
			let failure: unknown;
			for (let index = this.cleanups.length - 1; index >= 0; index--) {
				try {
					await this.cleanups[index]!();
				} catch (error) {
					failure ??= error;
				}
			}
			this.cleanups.length = 0;
			if (failure !== undefined) throw new Error("Node server cleanup failed", { cause: failure });
		})();
		return this.disposing;
	}
}

class NodeExecution implements ExecutionPort {
	private readonly tasks = new Set<Promise<unknown>>();

	waitUntil(task: Promise<unknown>): void {
		const tracked = task.catch((error) => {
			console.error("[yaos-node] background task failed", error);
		}).finally(() => this.tasks.delete(tracked));
		this.tasks.add(tracked);
	}

	async drain(): Promise<void> {
		while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
	}
}

class ConfigActor implements RuntimeActor {
	private readonly runtime;

	constructor(databases: NodeDatabaseSet, name: string) {
		this.runtime = new ControlPlaneRuntime(databases.controlKv(`config:${name}`));
	}

	fetch(request: Request): Promise<Response> {
		return this.runtime.fetch(request);
	}
}

class VaultActor implements RuntimeActor {
	readonly runtime: VaultRuntime;

	constructor(
		storage: NodeSqliteStorage,
		readonly sockets: NodeSocketRegistry,
		private readonly execution: NodeExecution,
		alarms: AlarmPort,
		objects: FilesystemObjectStore,
		recoveryJobs: ActorCallPort,
	) {
		this.runtime = new VaultRuntime({
			storage,
			sockets,
			alarms,
			execution,
			objectStore: objects,
			recoveryJobs,
		});
	}

	fetch(request: Request): Promise<Response> {
		return this.runtime.fetch(request);
	}

	dispatch(): Promise<void> {
		return this.runtime.alarm();
	}

	message(socket: VaultSocketPort, message: string | ArrayBuffer): Promise<void> {
		return this.runtime.webSocketMessage(socket, message);
	}

	closed(): void {
		this.runtime.webSocketClose();
	}

	socketError(socket: VaultSocketPort): void {
		this.runtime.webSocketError(socket);
	}

	async close(): Promise<void> {
		await this.runtime.drain();
		await this.execution.drain();
		this.sockets.closeAll();
	}
}

class RecoveryActor implements RuntimeActor {
	private readonly runtime: RecoveryJobRuntime;

	constructor(
		storage: NodeSqliteStorage,
		alarms: AlarmPort,
		objects: FilesystemObjectStore,
		vaults: ActorCallPort,
		controlPlane: ActorCallPort,
	) {
		this.runtime = new RecoveryJobRuntime({
			storage,
			alarms,
			objectStore: objects,
			recoveryAuthority: vaults,
			controlPlane,
		});
	}

	fetch(request: Request): Promise<Response> {
		return this.runtime.fetch(request);
	}

	dispatch(dispatchId: string): Promise<void> {
		return this.runtime.dispatch(dispatchId);
	}
}

class NodeActorCalls implements ActorCallPort {
	constructor(
		private readonly actors: () => ActorRegistry,
		private readonly kind: ActorKind,
	) {}

	call(actorName: string, request: Request): Promise<Response> {
		return this.actors().fetch(this.kind, actorName, request);
	}
}

function parseEnvironment(environment: NodeJS.ProcessEnv): NodeServerOptions {
	const host = environment.YAOS_NODE_HOST?.trim() || "127.0.0.1";
	const rawPort = environment.YAOS_NODE_PORT;
	const port = Number(rawPort);
	if (!rawPort || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("YAOS_NODE_PORT must be an integer between 1 and 65535");
	}
	const configuredDirectory = environment.YAOS_NODE_DATA_DIR?.trim();
	if (!configuredDirectory) throw new Error("YAOS_NODE_DATA_DIR is required");
	return {
		host,
		port,
		dataDirectory: resolve(configuredDirectory),
		...(environment.YAOS_TICKET_TTL_MS ? { ticketTtlMs: environment.YAOS_TICKET_TTL_MS } : {}),
		...(environment.YAOS_ENABLE_ADMIN_ROUTES ? { enableAdminRoutes: environment.YAOS_ENABLE_ADMIN_ROUTES } : {}),
	};
}

export async function runNodeServer(options: NodeServerOptions): Promise<void> {
	const cleanup = new CleanupStack();
	let shutdownResolve: (() => void) | null = null;
	const shutdown = new Promise<void>((resolveShutdown) => {
		shutdownResolve = resolveShutdown;
	});
	let stopping = false;
	const requestShutdown = (): void => {
		if (stopping) return;
		stopping = true;
		shutdownResolve?.();
	};
	process.once("SIGINT", requestShutdown);
	process.once("SIGTERM", requestShutdown);
	cleanup.defer(() => {
		process.off("SIGINT", requestShutdown);
		process.off("SIGTERM", requestShutdown);
	});

	try {
		const lock = ProcessDataLock.acquire(options.dataDirectory);
		cleanup.defer(() => lock.release());

		const databases = new NodeDatabaseSet(options.dataDirectory);
		cleanup.defer(() => databases.close());

		const objects = new FilesystemObjectStore(resolve(options.dataDirectory, "objects"));
		await objects.initialize();
		if (stopping) return;

		const socketHub = new NodeSocketHub();
		cleanup.defer(() => socketHub.clear());

		let actors: ActorRegistry;
		const configCalls = new NodeActorCalls(() => actors, "config");
		const vaultCalls = new NodeActorCalls(() => actors, "vault");
		const recoveryCalls = new NodeActorCalls(() => actors, "recovery-job");
		let alarms: DurableAlarmScheduler;

		const actorFactory: ActorFactory = (kind, name) => {
			if (kind === "config") return new ConfigActor(databases, name);
			if (kind === "recovery-job") {
				return new RecoveryActor(
					databases.job(name),
					alarms.forActor(kind, name),
					objects,
					vaultCalls,
					configCalls,
				);
			}
			const execution = new NodeExecution();
			const sockets = new NodeSocketRegistry(socketHub, {
				message: (socket, message) => {
					void actors.call("vault", name, async (actor) => {
						await (actor as VaultActor).message(socket, message);
					}).catch((error) => console.error("[yaos-node] WebSocket message failed", error));
				},
				close: () => {
					void actors.call("vault", name, async (actor) => {
						(actor as VaultActor).closed();
					}).catch((error) => console.error("[yaos-node] WebSocket close failed", error));
				},
				error: (socket) => {
					void actors.call("vault", name, async (actor) => {
						(actor as VaultActor).socketError(socket);
					}).catch((error) => console.error("[yaos-node] WebSocket error failed", error));
				},
			});
			return new VaultActor(
				databases.vault(name),
				sockets,
				execution,
				alarms.forActor(kind, name),
				objects,
				recoveryCalls,
			);
		};

		actors = new ActorRegistry(actorFactory);
		cleanup.defer(() => actors.drain());
		alarms = new DurableAlarmScheduler(
			databases.control,
			(kind, name, dispatchId) => actors.dispatch(kind, name, dispatchId),
			{
				onDispatchError: (error, actor) => console.error(`[yaos-node] alarm failed for ${actor.kind}:${actor.name}`, error),
				onQuarantine: (actor) => console.error(`[yaos-node] alarm quarantined after three abandoned dispatches: ${actor.kind}:${actor.name}`),
			},
		);
		cleanup.defer(() => alarms.stop());

		const workerEnvironment: WorkerRuntimeEnvironment = {
			YAOS_SYNC: vaultCalls,
			YAOS_CONFIG: configCalls,
			YAOS_RECOVERY_JOBS: recoveryCalls,
			YAOS_BUCKET: objects,
			socketUpgrades: socketHub,
			...(options.ticketTtlMs ? { YAOS_TICKET_TTL_MS: options.ticketTtlMs } : {}),
			...(options.enableAdminRoutes ? { YAOS_ENABLE_ADMIN_ROUTES: options.enableAdminRoutes } : {}),
		};
		const application: NodeTransportApplication = {
			fetch: (request) => handleWorkerRequest(request, workerEnvironment),
			upgrade: async (request): Promise<WebSocketUpgradeResult> => {
				const response = await handleWorkerRequest(request, workerEnvironment);
				return socketHub.takeUpgrade(response) ?? response;
			},
		};
		if (stopping) return;
		const transport = new NodeTransport(application, {
			host: options.host,
			port: options.port,
			drainTimeoutMs: options.drainTimeoutMs,
			readiness: () => lock.ownsLock() ? databases.readinessFailure() : "lock",
			onError: (error) => console.error("[yaos-node] transport error", error),
		});
		cleanup.defer(() => transport.drain());
		await transport.listen();
		if (stopping) return;
		alarms.start();
		console.log(`[yaos-node] ready http://${options.host}:${options.port}`);

		await shutdown;
	} finally {
		await cleanup.dispose();
	}
}

export async function retryQuarantinedAlarm(
	options: AlarmRetryOptions,
	kind: "vault" | "recovery-job",
	actorName: string,
): Promise<void> {
	if (!actorName || actorName.includes("\0")) throw new Error("a valid alarm actor name is required");
	const lock = ProcessDataLock.acquire(options.dataDirectory);
	try {
		const databases = new NodeDatabaseSet(options.dataDirectory);
		try {
			const alarms = new DurableAlarmScheduler(
				databases.control,
				async () => {
					throw new Error("alarm dispatch is unavailable in retry mode");
				},
			);
			await alarms.retryQuarantined(kind, actorName);
		} finally {
			databases.close();
		}
	} finally {
		lock.release();
	}
}

async function main(): Promise<void> {
	try {
		const argumentsAfterEntry = process.argv.slice(2);
		if (argumentsAfterEntry.length === 0) {
			await runNodeServer(parseEnvironment(process.env));
		} else if (argumentsAfterEntry.length === 3 && argumentsAfterEntry[0] === "--retry-alarm"
			&& (argumentsAfterEntry[1] === "vault" || argumentsAfterEntry[1] === "recovery-job")) {
			const configuredDirectory = process.env.YAOS_NODE_DATA_DIR?.trim();
			if (!configuredDirectory) throw new Error("YAOS_NODE_DATA_DIR is required");
			await retryQuarantinedAlarm(
				{ dataDirectory: resolve(configuredDirectory) },
				argumentsAfterEntry[1],
				argumentsAfterEntry[2]!,
			);
			console.log(`[yaos-node] alarm retry scheduled for ${argumentsAfterEntry[1]}:${argumentsAfterEntry[2]}`);
		} else {
			throw new Error("usage: index.ts [--retry-alarm <vault|recovery-job> <actor-name>]");
		}
	} catch (error) {
		if (error instanceof DataDirectoryLockedError || error instanceof NewerStorageVersionError) {
			console.error(`[yaos-node] ${error.message}`);
			process.exitCode = error.exitCode;
			return;
		}
		console.error("[yaos-node] fatal", error);
		process.exitCode = 1;
	}
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath && entryPath === resolve(fileURLToPath(import.meta.url))) void main();
