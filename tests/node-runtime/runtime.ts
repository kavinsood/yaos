import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ActorRegistry,
	DataDirectoryLockedError,
	ProcessDataLock,
} from "../../packages/server-node/src/runtimeHost";
import {
	NewerStorageVersionError,
	NodeDatabaseSet,
	NodeSqliteStorage,
} from "../../packages/server-node/src/storage";
import { NodeTransport } from "../../packages/server-node/src/transport";
import { suite } from "../harness.ts";

const s = suite("node-runtime-operations");

async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test listener did not expose a TCP address");
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

s.test("the data-directory lock rejects a second owner and recovers after release", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-lock-"));
	try {
		const first = ProcessDataLock.acquire(directory);
		try {
			assert.throws(
				() => ProcessDataLock.acquire(directory),
				(error: unknown) => error instanceof DataDirectoryLockedError && error.exitCode === 17,
			);
		} finally {
			first.release();
		}
		const recovered = ProcessDataLock.acquire(directory);
		recovered.release();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("startup rejects a newer dormant actor database before opening the host", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-migration-"));
	const vaultDirectory = join(directory, "vaults");
	await mkdir(vaultDirectory, { recursive: true });
	const future = NodeSqliteStorage.open(join(vaultDirectory, "future.sqlite"));
	const versionRow = future.database.prepare("PRAGMA user_version").get();
	assert.ok(versionRow && "user_version" in versionRow);
	assert.equal(versionRow.user_version, 1);
	future.database.exec("PRAGMA user_version = 2");
	future.close();
	try {
		assert.throws(
			() => new NodeDatabaseSet(directory),
			(error: unknown) => error instanceof NewerStorageVersionError
				&& error.foundVersion === 2
				&& error.supportedVersion === 1
				&& error.exitCode === 18,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("recovery status and authority calls can re-enter a waiting actor without deadlock", async () => {
	let registry!: ActorRegistry;
	let constructions = 0;
	registry = new ActorRegistry((_kind, _name) => {
		constructions++;
		return {
			fetch: async (request: Request): Promise<Response> => {
				const path = new URL(request.url).pathname;
				if (path === "/public-recovery-status") {
					return await registry.fetch(
						"recovery-job",
						"job-a",
						new Request("https://internal/recovery-job-status"),
					);
				}
				if (path === "/recovery-job-status") {
					await Promise.resolve();
					return await registry.fetch(
						"vault",
						"vault-a",
						new Request("https://internal/recovery-authority"),
					);
				}
				if (path === "/recovery-authority") return Response.json({ state: "running" });
				return new Response("not found", { status: 404 });
			},
		};
	});
	let timeout: NodeJS.Timeout | undefined;
	const response = await Promise.race([
		registry.fetch("vault", "vault-a", new Request("https://public/public-recovery-status")),
		new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error("cross-actor recovery status deadlocked")), 1_000);
		}),
	]);
	clearTimeout(timeout);
	assert.deepEqual(await response.json(), { state: "running" });
	assert.equal(constructions, 2, "re-entry must reuse the existing vault actor");
	await registry.drain();
});

s.test("health endpoints are exact unauthenticated GET routes", async () => {
	const port = await reservePort();
	const applicationRequests: string[] = [];
	const transport = new NodeTransport({
		fetch: async (request) => {
			const url = new URL(request.url);
			applicationRequests.push(`${request.method} ${url.pathname}`);
			return new Response("application response", {
				status: 418,
				headers: { "x-application": "true" },
			});
		},
		upgrade: async () => Response.json({ error: "not_a_socket" }, { status: 400 }),
	}, {
		host: "127.0.0.1",
		port,
		drainTimeoutMs: 1_000,
		readiness: () => null,
	});
	try {
		await transport.listen();
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { status: "ok" });
		const readiness = await fetch(`http://127.0.0.1:${port}/health/ready`);
		assert.equal(readiness.status, 200);
		assert.deepEqual(await readiness.json(), { status: "ready" });
		assert.deepEqual(applicationRequests, [], "health requests must bypass application authentication");

		const nearMisses: ReadonlyArray<readonly [string, string]> = [
			["HEAD", "/health"],
			["POST", "/health"],
			["GET", "/health/"],
			["GET", "/healthz"],
			["GET", "/readyz"],
			["GET", "/health/ready/"],
			["POST", "/health/ready"],
		];
		for (const [method, path] of nearMisses) {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
			assert.equal(response.status, 418, `${method} ${path} must reach the application`);
			assert.equal(response.headers.get("x-application"), "true");
		}
		assert.deepEqual(applicationRequests, nearMisses.map(([method, path]) => `${method} ${path}`));
	} finally {
		await transport.drain();
	}
});

s.test("public origin rewrites application URLs behind a TLS proxy", async () => {
	const port = await reservePort();
	let observedUrl = "";
	const transport = new NodeTransport({
		fetch: async (request) => {
			observedUrl = request.url;
			return new Response("ok");
		},
		upgrade: async () => new Response("not found", { status: 404 }),
	}, {
		host: "127.0.0.1",
		port,
		publicOrigin: "https://sync.example.com",
		readiness: () => null,
	});
	try {
		await transport.listen();
		const response = await fetch(`http://127.0.0.1:${port}/vault/example/status?detail=1`);
		assert.equal(response.status, 200);
		assert.equal(observedUrl, "https://sync.example.com/vault/example/status?detail=1");
	} finally {
		await transport.drain();
	}
});

s.test("readiness fails closed without leaking lock identity or paths", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-health-lock-"));
	const lock = ProcessDataLock.acquire(directory);
	const port = await reservePort();
	const transport = new NodeTransport({
		fetch: async () => new Response("not found", { status: 404 }),
		upgrade: async () => new Response("not found", { status: 404 }),
	}, {
		host: "127.0.0.1",
		port,
		readiness: () => lock.ownsLock() ? null : "lock",
	});
	try {
		await transport.listen();
		assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
		lock.release();
		const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
		assert.equal(response.status, 503);
		const body = await response.text();
		assert.deepEqual(JSON.parse(body), { status: "not_ready", reason: "lock" });
		assert.equal(body.includes(directory), false);
		assert.equal(body.includes("runtime.lock"), false);
	} finally {
		await transport.drain();
		lock.release();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("readiness probes storage and requires the exact migration version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-health-storage-"));
	const databases = new NodeDatabaseSet(directory);
	const port = await reservePort();
	const transport = new NodeTransport({
		fetch: async () => new Response("not found", { status: 404 }),
		upgrade: async () => new Response("not found", { status: 404 }),
	}, {
		host: "127.0.0.1",
		port,
		readiness: () => databases.readinessFailure(),
	});
	try {
		await transport.listen();
		assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
		for (const version of [0, 2]) {
			databases.control.database.exec(`PRAGMA user_version = ${version}`);
			const migration = await fetch(`http://127.0.0.1:${port}/health/ready`);
			assert.equal(migration.status, 503);
			const body = await migration.text();
			assert.deepEqual(JSON.parse(body), { status: "not_ready", reason: "migration" });
			assert.equal(body.includes(directory), false);
		}
		databases.control.database.exec("PRAGMA user_version = 1");
		assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);

		databases.control.close();
		const storage = await fetch(`http://127.0.0.1:${port}/health/ready`);
		assert.equal(storage.status, 503);
		const body = await storage.text();
		assert.deepEqual(JSON.parse(body), { status: "not_ready", reason: "storage" });
		assert.equal(body.includes(directory), false);
	} finally {
		await transport.drain();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("readiness hides unexpected probe failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-health-leak-"));
	const port = await reservePort();
	const errors: unknown[] = [];
	let returnUnexpectedReason = true;
	const transport = new NodeTransport({
		fetch: async () => new Response("not found", { status: 404 }),
		upgrade: async () => new Response("not found", { status: 404 }),
	}, {
		host: "127.0.0.1",
		port,
		readiness: () => {
			if (returnUnexpectedReason) return directory as never;
			throw new Error(`vault-secret at ${directory}`);
		},
		onError: (error) => errors.push(error),
	});
	try {
		await transport.listen();
		const unexpected = await fetch(`http://127.0.0.1:${port}/health/ready`);
		assert.equal(unexpected.status, 503);
		const unexpectedBody = await unexpected.text();
		assert.deepEqual(JSON.parse(unexpectedBody), { status: "not_ready", reason: "storage" });
		assert.equal(unexpectedBody.includes(directory), false);
		assert.equal(errors.length, 0);

		returnUnexpectedReason = false;
		const thrown = await fetch(`http://127.0.0.1:${port}/health/ready`);
		assert.equal(thrown.status, 503);
		const thrownBody = await thrown.text();
		assert.deepEqual(JSON.parse(thrownBody), { status: "not_ready", reason: "storage" });
		assert.equal(thrownBody.includes(directory), false);
		assert.equal(thrownBody.includes("vault-secret"), false);
		assert.equal(errors.length, 1);
	} finally {
		await transport.drain();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("an in-flight readiness probe fails when draining begins", async () => {
	const port = await reservePort();
	let probeStartedResolve!: () => void;
	let releaseProbe!: () => void;
	const probeStarted = new Promise<void>((resolve) => {
		probeStartedResolve = resolve;
	});
	const probeGate = new Promise<void>((resolve) => {
		releaseProbe = resolve;
	});
	const transport = new NodeTransport({
		fetch: async () => new Response("not found", { status: 404 }),
		upgrade: async () => new Response("not found", { status: 404 }),
	}, {
		host: "127.0.0.1",
		port,
		drainTimeoutMs: 1_000,
		readiness: async () => {
			probeStartedResolve();
			await probeGate;
			return null;
		},
	});
	await transport.listen();
	let drainPromise: Promise<void> | null = null;
	try {
		const readinessPromise = fetch(`http://127.0.0.1:${port}/health/ready`);
		await probeStarted;
		drainPromise = transport.drain();
		releaseProbe();
		const readiness = await readinessPromise;
		assert.equal(readiness.status, 503);
		assert.deepEqual(await readiness.json(), { status: "not_ready", reason: "draining" });
		await drainPromise;
	} finally {
		releaseProbe();
		await (drainPromise ?? transport.drain());
	}
});

await s.done();
