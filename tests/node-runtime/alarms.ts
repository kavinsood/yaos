import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorRegistry, DurableAlarmScheduler } from "../../packages/server-node/src/runtimeHost";
import { NodeDatabaseSet } from "../../packages/server-node/src/storage";
import { suite } from "../harness.ts";

const s = suite("node-runtime-alarms");

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for alarm state");
}

s.test("dispatch observes its durable lease before actor work begins", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-alarm-lease-"));
	const databases = new NodeDatabaseSet(directory);
	let observedLease: string | null = null;
	const scheduler = new DurableAlarmScheduler(
		databases.control,
		async (kind, name, dispatchId) => {
			const row = databases.control.sql.exec<{ lease_id: string | null }>(
				"SELECT lease_id FROM node_alarms WHERE actor_kind = ? AND actor_name = ?",
				kind,
				name,
			).one();
			assert.equal(row.lease_id, dispatchId);
			observedLease = row.lease_id;
		},
		{ now: () => 10_000, leaseMs: 5_000 },
	);
	try {
		await scheduler.set("vault", "vault-a", 10_000);
		scheduler.start();
		await waitFor(() => observedLease !== null);
		await scheduler.stop();
		assert.match(observedLease ?? "", /^[0-9a-f-]{36}$/);
		assert.equal(
			databases.control.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM node_alarms").one().count,
			0,
		);
	} finally {
		await scheduler.stop();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("dispatch completion preserves a successor deadline scheduled under the lease", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-alarm-successor-"));
	const databases = new NodeDatabaseSet(directory);
	let dispatches = 0;
	let scheduler!: DurableAlarmScheduler;
	scheduler = new DurableAlarmScheduler(
		databases.control,
		async (kind, name) => {
			await scheduler.set(kind, name, 2_000);
			dispatches++;
		},
		{ now: () => 1_000, leaseMs: 5_000 },
	);
	try {
		await scheduler.set("recovery-job", "job-watchdog", 1_000);
		scheduler.start();
		await waitFor(() => {
			const row = databases.control.sql.exec<{ deadline_ms: number | null; lease_id: string | null }>(
				"SELECT deadline_ms, lease_id FROM node_alarms WHERE actor_kind = 'recovery-job' AND actor_name = 'job-watchdog'",
			).toArray()[0];
			return dispatches === 1 && row?.deadline_ms === 2_000 && row.lease_id === null;
		});
		assert.equal(dispatches, 1);
	} finally {
		await scheduler.stop();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("failed vault and recovery dispatches retain a bounded durable retry", async () => {
	for (const actor of [
		{ kind: "vault", name: "vault-retry" },
		{ kind: "recovery-job", name: "recovery-retry" },
	] as const) {
		const directory = await mkdtemp(join(tmpdir(), `yaos-node-${actor.kind}-retry-`));
		const databases = new NodeDatabaseSet(directory);
		let now = 10_000;
		let dispatches = 0;
		let dispatchErrors = 0;
		const failedScheduler = new DurableAlarmScheduler(
			databases.control,
			async () => {
				dispatches++;
				throw new Error("dispatch failed before scheduling a successor");
			},
			{
				now: () => now,
				leaseMs: 5_000,
				onDispatchError: () => {
					dispatchErrors++;
				},
			},
		);
		let retryScheduler: DurableAlarmScheduler | undefined;
		try {
			await failedScheduler.set(actor.kind, actor.name, now);
			failedScheduler.start();
			await waitFor(() => dispatchErrors === 1);
			const retained = databases.control.sql.exec<{
				deadline_ms: number | null;
				lease_id: string | null;
				lease_until_ms: number | null;
				abandoned_dispatches: number;
				revision: number;
			}>(
				`SELECT deadline_ms, lease_id, lease_until_ms, abandoned_dispatches, revision
				 FROM node_alarms WHERE actor_kind = ? AND actor_name = ?`,
				actor.kind,
				actor.name,
			).one();
			assert.deepEqual(retained, {
				deadline_ms: 11_000,
				lease_id: null,
				lease_until_ms: null,
				abandoned_dispatches: 0,
				revision: 3,
			});
			assert.equal(dispatches, 1, `${actor.kind} failure must not hot-loop`);

			await failedScheduler.stop();
			now = 11_000;
			retryScheduler = new DurableAlarmScheduler(
				databases.control,
				async () => {
					dispatches++;
				},
				{ now: () => now, leaseMs: 5_000 },
			);
			retryScheduler.start();
			await waitFor(() => databases.control.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM node_alarms WHERE actor_kind = ? AND actor_name = ?",
				actor.kind,
				actor.name,
			).one().count === 0);
			assert.equal(dispatches, 2);
		} finally {
			await failedScheduler.stop();
			await retryScheduler?.stop();
			databases.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

s.test("failed stale completion preserves a newer successor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-alarm-stale-failure-"));
	const databases = new NodeDatabaseSet(directory);
	let dispatchEnteredResolve!: () => void;
	const dispatchEntered = new Promise<void>((resolve) => {
		dispatchEnteredResolve = resolve;
	});
	let releaseDispatchResolve!: () => void;
	const dispatchGate = new Promise<void>((resolve) => {
		releaseDispatchResolve = resolve;
	});
	let dispatchReleased = false;
	const releaseDispatch = (): void => {
		if (dispatchReleased) return;
		dispatchReleased = true;
		releaseDispatchResolve();
	};
	let dispatchErrors = 0;
	const scheduler = new DurableAlarmScheduler(
		databases.control,
		async () => {
			dispatchEnteredResolve();
			await dispatchGate;
			throw new Error("stale dispatch failed");
		},
		{
			now: () => 1_000,
			leaseMs: 5_000,
			onDispatchError: () => {
				dispatchErrors++;
			},
		},
	);
	try {
		await scheduler.set("recovery-job", "stale-recovery", 1_000);
		scheduler.start();
		await dispatchEntered;
		const claimed = databases.control.sql.exec<{ lease_id: string | null; revision: number }>(
			"SELECT lease_id, revision FROM node_alarms WHERE actor_kind = 'recovery-job' AND actor_name = 'stale-recovery'",
		).one();
		assert.notEqual(claimed.lease_id, null);
		assert.equal(claimed.revision, 2);

		await scheduler.set("recovery-job", "stale-recovery", 5_000);
		releaseDispatch();
		await waitFor(() => dispatchErrors === 1);
		const successor = databases.control.sql.exec<{
			deadline_ms: number | null;
			lease_id: string | null;
			lease_until_ms: number | null;
			revision: number;
		}>(
			`SELECT deadline_ms, lease_id, lease_until_ms, revision
			 FROM node_alarms WHERE actor_kind = 'recovery-job' AND actor_name = 'stale-recovery'`,
		).one();
		assert.deepEqual(successor, {
			deadline_ms: 5_000,
			lease_id: null,
			lease_until_ms: null,
			revision: 4,
		});
	} finally {
		releaseDispatch();
		await scheduler.stop();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("restore dispatch leaves public status readable while calling vault authority", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-restore-status-"));
	const databases = new NodeDatabaseSet(directory);
	let authorityEnteredResolve!: () => void;
	const authorityEntered = new Promise<void>((resolve) => {
		authorityEnteredResolve = resolve;
	});
	let releaseAuthorityResolve!: () => void;
	const authorityGate = new Promise<void>((resolve) => {
		releaseAuthorityResolve = resolve;
	});
	let authorityReleased = false;
	const releaseAuthority = (): void => {
		if (authorityReleased) return;
		authorityReleased = true;
		releaseAuthorityResolve();
	};
	let dispatches = 0;
	let actors!: ActorRegistry;
	let scheduler!: DurableAlarmScheduler;
	actors = new ActorRegistry((kind) => kind === "recovery-job"
		? {
			fetch: async () => Response.json({ state: "awaiting-results" }),
			dispatch: async () => {
				await actors.fetch("vault", "vault-restore", new Request("https://internal/restore-authority"));
				dispatches++;
				if (dispatches < 20) await scheduler.set("recovery-job", "restore-job", 1_000);
			},
		}
		: {
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname;
				if (path === "/restore-authority") {
					authorityEnteredResolve();
					await authorityGate;
					return Response.json({ valid: true });
				}
				return await actors.fetch(
					"recovery-job",
					"restore-job",
					new Request("https://internal/recovery-job-status"),
				);
			},
		});
	scheduler = new DurableAlarmScheduler(
		databases.control,
		(kind, name, dispatchId) => actors.dispatch(kind, name, dispatchId),
		{ now: () => 1_000, leaseMs: 5_000 },
	);
	try {
		await scheduler.set("recovery-job", "restore-job", 1_000);
		scheduler.start();
		await authorityEntered;
		let statusTimeout: NodeJS.Timeout | undefined;
		const statuses = await Promise.race([
			Promise.all(Array.from({ length: 5 }, () =>
				actors.fetch("vault", "vault-restore", new Request("https://public/recovery/restore/status")))),
			new Promise<never>((_resolve, reject) => {
				statusTimeout = setTimeout(() => reject(new Error("restore status deadlocked behind authority dispatch")), 1_000);
			}),
		]);
		clearTimeout(statusTimeout);
		for (const response of statuses) {
			assert.deepEqual(await response.json(), { state: "awaiting-results" });
		}
		const interleavedStatus = new Promise<number>((resolve, reject) => {
			setTimeout(() => {
				actors.fetch("vault", "vault-restore", new Request("https://public/recovery/restore/status"))
					.then(() => resolve(dispatches), reject);
			}, 0);
		});
		releaseAuthority();
		assert.ok(await interleavedStatus < 20, "immediate successor alarms must yield to public status I/O");
	} finally {
		releaseAuthority();
		await scheduler.stop();
		await actors.drain();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("a third abandoned dispatch quarantines until explicit retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-alarm-quarantine-"));
	const databases = new NodeDatabaseSet(directory);
	let dispatches = 0;
	const scheduler = new DurableAlarmScheduler(
		databases.control,
		async () => {
			dispatches++;
		},
		{ now: () => 20_000, leaseMs: 5_000 },
	);
	try {
		databases.control.sql.exec(
			`INSERT INTO node_alarms(
				actor_kind, actor_name, deadline_ms, lease_id, lease_until_ms,
				abandoned_dispatches, revision
			) VALUES ('recovery-job', 'job-a', 10000, 'abandoned-dispatch', 19000, 2, 7)`,
		);
		scheduler.start();
		await waitFor(() => databases.control.sql.exec<{ quarantine_reason: string | null }>(
			"SELECT quarantine_reason FROM node_alarms WHERE actor_kind = 'recovery-job' AND actor_name = 'job-a'",
		).one().quarantine_reason !== null);
		assert.equal(dispatches, 0);
		const quarantined = databases.control.sql.exec<{
			deadline_ms: number | null;
			lease_id: string | null;
			abandoned_dispatches: number;
			quarantine_reason: string | null;
		}>("SELECT deadline_ms, lease_id, abandoned_dispatches, quarantine_reason FROM node_alarms").one();
		assert.deepEqual(quarantined, {
			deadline_ms: null,
			lease_id: null,
			abandoned_dispatches: 3,
			quarantine_reason: "three_abandoned_dispatches",
		});
		await scheduler.retryQuarantined("recovery-job", "job-a", 30_000);
		const retried = databases.control.sql.exec<{
			deadline_ms: number | null;
			abandoned_dispatches: number;
			quarantine_reason: string | null;
		}>("SELECT deadline_ms, abandoned_dispatches, quarantine_reason FROM node_alarms").one();
		assert.deepEqual(retried, {
			deadline_ms: 30_000,
			abandoned_dispatches: 0,
			quarantine_reason: null,
		});
	} finally {
		await scheduler.stop();
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
