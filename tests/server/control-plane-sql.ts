import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SqlControlPlaneStorage,
	type ControlPlaneSqlHost,
} from "../../server/src/controlPlaneSql";
import type { SecurityAuditEvent } from "../../server/src/collaborationIdentity";
import { ControlPlaneRuntime } from "../../server/src/config";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { suite } from "../harness.ts";

const s = suite("control-plane-sql");

function post(path: string, body: unknown): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function withStore(
	check: (store: SqlControlPlaneStorage, sqlite: NodeSqliteStorage) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-control-plane-sql-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "control.sqlite"));
	try {
		const store = new SqlControlPlaneStorage(sqlite as unknown as ControlPlaneSqlHost, "test-config");
		await check(store, sqlite);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function withCountedStore(
	check: (store: SqlControlPlaneStorage, sqlite: NodeSqliteStorage, queries: { value: number; statements: string[] }) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-control-plane-counted-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "control.sqlite"));
	const queries = { value: 0, statements: [] as string[] };
	const host = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				queries.value++;
				queries.statements.push(query);
				return sqlite.sql.exec(query, ...bindings);
			},
		},
		transactionSync<T>(closure: () => T): T { return sqlite.transactionSync(closure); },
	} as unknown as ControlPlaneSqlHost;
	try {
		const store = new SqlControlPlaneStorage(host, "counted-config");
		await check(store, sqlite, queries);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function resetQueries(queries: { value: number; statements: string[] }): void {
	queries.value = 0;
	queries.statements.length = 0;
}

function assertNoWholeCollectionRead(queries: { statements: string[] }, label: string): void {
	assert.equal(queries.statements.some((query) => /SELECT record_key, payload_json FROM control_plane_records/.test(query)), false,
		`${label} loaded a whole collection`);
}

async function provisionOwner(runtime: ControlPlaneRuntime, suffix: string) {
	const vaultId = `sql-vault-${suffix}`;
	const pairingCodeHash = "a".repeat(64);
	const tokenHash = "b".repeat(64);
	const claim = await runtime.fetch(post("/__yaos/claim", {
		operatorRecoveryHash: "f".repeat(64), ticketSigningKey: "ticket-signing-key",
		vaultId, vaultName: "SQL Vault", pairingCodeHash, pairingPurpose: "origin",
	}));
	assert.equal(claim.status, 200);
	const claimed = await claim.json() as { vaultGeneration: string };
	assert.equal((await runtime.fetch(post("/__yaos/activate-vault", {
		vaultId, vaultGeneration: claimed.vaultGeneration, pairingCodeHash, pairingPurpose: "origin",
	}))).status, 200);
	const enrollmentRequestId = `sql-enrollment-${suffix}`.padEnd(16, "x");
	const enrollment = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId, pairingCodeHash, deviceId: `sql-device-${suffix}`,
		deviceTokenHash: tokenHash, deviceName: "SQL Device",
	}));
	assert.equal(enrollment.status, 200, await enrollment.clone().text());
	const body = await enrollment.json() as {
		principalId: string; deviceId: string; membershipRevision: number;
		deviceCredentialRevision: number; role: "owner"; change: { changeId: string };
	};
	const completion = await runtime.fetch(post("/__yaos/collaboration/complete-change", {
		changeId: body.change.changeId, vaultId, vaultGeneration: claimed.vaultGeneration,
	}));
	assert.equal(completion.status, 200, await completion.clone().text());
	return { vaultId, vaultGeneration: claimed.vaultGeneration, pairingCodeHash, tokenHash, ...body };
}

s.test("empty initialized collections remain distinguishable from missing collections", async () => {
	await withStore(async (store, sqlite) => {
		assert.equal(await store.get("securityAuditEvents"), undefined);
		await store.put("securityAuditEvents", []);
		assert.deepEqual(await store.get("securityAuditEvents"), []);
		assert.equal(sqlite.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM control_plane_collections WHERE collection = 'securityAuditEvents'",
		).one().count, 1);
		assert.equal(sqlite.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM control_plane_records WHERE collection = 'securityAuditEvents'",
		).one().count, 0);
	});
});

s.test("ten thousand audit events occupy ten thousand bounded rows, never one giant value", async () => {
	await withStore(async (store, sqlite) => {
		const events = Array.from({ length: 10_000 }, (_, index): SecurityAuditEvent => ({
			eventId: `audit-${index.toString().padStart(5, "0")}`,
			vaultId: `vault-${index % 8}`,
			kind: "membership_authorized",
			actorPrincipalId: "principal-owner",
			actorDeviceId: "device-owner",
			targetPrincipalId: `principal-${index}`,
			targetDeviceId: null,
			createdAt: index,
			detail: "bounded audit detail that previously contributed to a value over two megabytes",
		}));
		await store.put("securityAuditEvents", events);

		const physical = sqlite.sql.exec<{ count: number; largest: number; total: number }>(
			`SELECT COUNT(*) AS count, MAX(length(CAST(payload_json AS BLOB))) AS largest,
				SUM(length(CAST(payload_json AS BLOB))) AS total
			 FROM control_plane_records WHERE collection = 'securityAuditEvents'`,
		).one();
		assert.equal(physical.count, 10_000);
		assert.ok(physical.total > 2_000_000, "fixture must reproduce the old oversized collection");
		assert.ok(physical.largest < 2_000, "each physical value is one bounded event");
		assert.equal(await store.countRecords("securityAuditEvents"), 10_000);
		assert.equal(sqlite.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM control_plane_scalars WHERE key = 'securityAuditEvents'",
		).one().count, 0);

		const before = sqlite.sql.exec<{ changes: number }>("SELECT total_changes() AS changes").one().changes;
		events.shift();
		events.push({ ...events.at(-1)!, eventId: "audit-new", createdAt: 10_001 });
		await store.put("securityAuditEvents", events);
		const after = sqlite.sql.exec<{ changes: number }>("SELECT total_changes() AS changes").one().changes;
		assert.ok(after - before <= 3, `retention update wrote ${after - before} rows instead of one delete/insert`);

		const beforeAppend = sqlite.sql.exec<{ changes: number }>("SELECT total_changes() AS changes").one().changes;
		await store.transaction(async (transaction) => {
			await transaction.records!.append("securityAuditEvents", {
				...events.at(-1)!,
				eventId: "audit-direct-append",
				vaultId: "vault-direct",
				createdAt: 10_002,
			}, 10_000);
		});
		const afterAppend = sqlite.sql.exec<{ changes: number }>("SELECT total_changes() AS changes").one().changes;
		assert.ok(afterAppend - beforeAppend <= 3,
			`indexed append/retention wrote ${afterAppend - beforeAppend} rows instead of one insert/delete`);
		assert.equal(await store.countRecords("securityAuditEvents"), 10_000);
		const direct = await store.transaction(async (transaction) =>
			transaction.records!.list<SecurityAuditEvent>("securityAuditEvents", {
				vaultId: "vault-direct",
				limit: 200,
				reverse: true,
			}));
		assert.deepEqual(direct.map((event) => event.eventId), ["audit-direct-append"]);
	});
});

s.test("collection and scalar mutations commit atomically", async () => {
	await withStore(async (store) => {
		await assert.rejects(store.transaction(async (transaction) => {
			await transaction.put("claimed", true);
			await transaction.put("vaults", [
				{ vaultId: "same-vault", name: "first" },
				{ vaultId: "same-vault", name: "duplicate" },
			]);
		}), /duplicate record keys/);
		assert.equal(await store.get("claimed"), undefined);
		assert.equal(await store.get("vaults"), undefined);
	});
});

s.test("record transactions expose filtered deletes and writes before commit", async () => {
	await withStore(async (store) => {
		await store.put("operatorSessions", [
			{ sessionHash: "expired", exp: 10, createdAt: 1 },
			{ sessionHash: "live", exp: 100, createdAt: 2 },
			{ sessionHash: "later", exp: 120, createdAt: 3 },
		]);
		await store.transaction(async (transaction) => {
			const records = transaction.records!;
			assert.equal(await records.deleteWhere("operatorSessions", { expiresAtOrBefore: 50 }), 1);
			assert.equal(await records.get("operatorSessions", { recordKey: "expired" }), undefined);
			assert.equal(await records.count("operatorSessions"), 2);
			assert.deepEqual(await records.list("operatorSessions", { limit: 10 }), [
				{ sessionHash: "live", exp: 100, createdAt: 2 },
				{ sessionHash: "later", exp: 120, createdAt: 3 },
			]);

			await records.upsert("operatorSessions", { sessionHash: "new", exp: 40, createdAt: 3 });
			assert.equal((await records.get<{ sessionHash: string }>("operatorSessions", { expiresAtOrBefore: 50 }))?.sessionHash, "new");
			assert.equal(await records.count("operatorSessions"), 3);
			assert.equal(await records.deleteWhere("operatorSessions", { expiresAtOrBefore: 50 }), 1);
			assert.equal(await records.get("operatorSessions", { recordKey: "new" }), undefined);
			assert.equal(await records.count("operatorSessions"), 2);

			await records.upsert("operatorSessions", { sessionHash: "live", exp: 150, createdAt: 2 });
			await records.append("operatorSessions", { sessionHash: "appended", exp: 200, createdAt: 4 }, 10);
			assert.deepEqual(await records.list("operatorSessions", { limit: 10 }), [
				{ sessionHash: "live", exp: 150, createdAt: 2 },
				{ sessionHash: "later", exp: 120, createdAt: 3 },
				{ sessionHash: "appended", exp: 200, createdAt: 4 },
			]);
			assert.deepEqual(await records.list("operatorSessions", { limit: 2, reverse: true }), [
				{ sessionHash: "appended", exp: 200, createdAt: 4 },
				{ sessionHash: "later", exp: 120, createdAt: 3 },
			]);
			assert.equal(await records.deleteWhere("operatorSessions", { recordKey: "appended" }), 1);
			assert.equal(await records.get("operatorSessions", { recordKey: "appended" }), undefined);
		});
		assert.deepEqual(await store.get("operatorSessions"), [
			{ sessionHash: "live", exp: 150, createdAt: 2 },
			{ sessionHash: "later", exp: 120, createdAt: 3 },
		]);
	});
});

s.test("claim, activation, and enrollment run end-to-end over record SQL", async () => {
	await withStore(async (store, sqlite) => {
		const runtime = new ControlPlaneRuntime(store);
		const pairingCodeHash = "a".repeat(64);
		const claim = await runtime.fetch(post("/__yaos/claim", {
			operatorRecoveryHash: "b".repeat(64),
			ticketSigningKey: "ticket-signing-key",
			vaultId: "sql-vault",
			vaultName: "SQL Vault",
			pairingCodeHash,
			pairingPurpose: "origin",
		}));
		assert.equal(claim.status, 200);
		const claimed = await claim.json() as { vaultGeneration: string };
		assert.equal((await runtime.fetch(post("/__yaos/activate-vault", {
			vaultId: "sql-vault",
			vaultGeneration: claimed.vaultGeneration,
			pairingCodeHash,
			pairingPurpose: "origin",
		}))).status, 200);
		const enrollment = await runtime.fetch(post("/__yaos/enroll", {
			enrollmentRequestId: "sql-enrollment-request",
			pairingCodeHash,
			deviceId: "sql-device",
			deviceTokenHash: "c".repeat(64),
			deviceName: "SQL Device",
		}));
		assert.equal(enrollment.status, 200);
		assert.equal(await store.countRecords("vaults"), 1);
		assert.equal(await store.countRecords("devices"), 1);
		assert.equal(await store.countRecords("principals"), 1);
		assert.equal(await store.countRecords("vaultMemberships"), 1);
		assert.equal(await store.countRecords("authorizationChanges"), 1);
		assert.equal(await store.countRecords("securityAuditEvents"), 1);
		assert.equal(sqlite.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM control_plane_scalars
			 WHERE key IN ('vaults', 'devices', 'principals', 'vaultMemberships', 'securityAuditEvents')`,
		).one().count, 0);
	});
});

s.test("expired indexed ownership transfers do not block a replacement offer", async () => {
	await withStore(async (store) => {
		const runtime = new ControlPlaneRuntime(store);
		const owner = await provisionOwner(runtime, "transfer-overlay");
		const invitationHash = "c".repeat(64);
		const invitation = await runtime.fetch(post("/__yaos/collaboration/create-code", {
			vaultId: owner.vaultId, principalId: owner.principalId, deviceId: owner.deviceId,
			purpose: "member-invitation", codeHash: invitationHash,
		}));
		assert.equal(invitation.status, 200, await invitation.clone().text());
		const enrollment = await runtime.fetch(post("/__yaos/enroll", {
			enrollmentRequestId: "transfer-overlay-member", pairingCodeHash: invitationHash,
			deviceId: "transfer-overlay-target", deviceTokenHash: "d".repeat(64), deviceName: "Target",
		}));
		assert.equal(enrollment.status, 200, await enrollment.clone().text());
		const member = await enrollment.json() as { principalId: string; change: { changeId: string } };
		const completion = await runtime.fetch(post("/__yaos/collaboration/complete-change", {
			changeId: member.change.changeId, vaultId: owner.vaultId, vaultGeneration: owner.vaultGeneration,
		}));
		assert.equal(completion.status, 200, await completion.clone().text());

		await store.transaction(async (transaction) => transaction.records!.upsert("ownershipTransfers", {
			transferId: "expired-transfer", vaultId: owner.vaultId,
			fromPrincipalId: owner.principalId, fromMembershipRevision: owner.membershipRevision,
			toPrincipalId: member.principalId, toMembershipRevision: 1,
			state: "offered", createdAt: 1, expiresAt: 1,
			acceptedAt: null, authorizationChangeId: null,
		}));
		const offered = await runtime.fetch(post("/__yaos/collaboration/create-transfer", {
			vaultId: owner.vaultId, principalId: owner.principalId, deviceId: owner.deviceId,
			targetPrincipalId: member.principalId,
		}));
		assert.equal(offered.status, 200, await offered.clone().text());
		const remaining = await store.transaction(async (transaction) => transaction.records!.list<{
			transferId: string; state: string;
		}>("ownershipTransfers", { vaultId: owner.vaultId, limit: 10 }));
		assert.equal(remaining.length, 1);
		assert.notEqual(remaining[0]?.transferId, "expired-transfer");
		assert.equal(remaining[0]?.state, "offered");
	});
});

s.test("session cleanup is visible to the revocation lookup", async () => {
	await withStore(async (store) => {
		await store.put("operatorSessions", [{ sessionHash: "expired-session", exp: 1, createdAt: 1 }]);
		const response = await new ControlPlaneRuntime(store).fetch(post("/__yaos/revoke-session", {
			sessionHash: "expired-session",
		}));
		assert.equal(response.status, 404);
		assert.deepEqual(await store.get("operatorSessions"), []);
	});
});

s.test("large global collections do not amplify admission, audit, enrollment, code consume, or destroy SQL", async () => {
	await withCountedStore(async (store, _sqlite, queries) => {
		const runtime = new ControlPlaneRuntime(store);
		const owner = await provisionOwner(runtime, "hotpath");
		const decoyAudits = Array.from({ length: 10_000 }, (_, index): SecurityAuditEvent => ({
			eventId: `large-audit-${index}`, vaultId: `unrelated-${index % 100}`,
			kind: "membership_authorized", actorPrincipalId: "decoy-principal",
			actorDeviceId: "decoy-device", targetPrincipalId: null, targetDeviceId: null,
			createdAt: index, detail: "large global collection",
		}));
		await store.put("securityAuditEvents", decoyAudits);

		resetQueries(queries);
		const authorized = await runtime.fetch(post("/__yaos/authorize-device", {
			tokenHash: owner.tokenHash, vaultId: owner.vaultId,
		}));
		assert.equal(authorized.status, 200);
		assert.ok(queries.value <= 4, `admission used ${queries.value} SQL statements`);
		assertNoWholeCollectionRead(queries, "admission");

		resetQueries(queries);
		const audit = await runtime.fetch(post("/__yaos/collaboration/audit", {
			vaultId: owner.vaultId, principalId: owner.principalId, deviceId: owner.deviceId,
		}));
		assert.equal(audit.status, 200);
		assert.ok(queries.value <= 5, `bounded audit read used ${queries.value} SQL statements`);
		assertNoWholeCollectionRead(queries, "audit read");

		for (const [label, request] of [
			["device touch", post("/__yaos/touch-device", { deviceId: owner.deviceId, vaultId: owner.vaultId })],
			["device rename", post("/__yaos/rename-device", { deviceId: owner.deviceId, name: "Bounded SQL device" })],
			["device verify", post("/__yaos/verify-device", { deviceId: owner.deviceId, vaultId: owner.vaultId })],
			["pairing creation", post("/__yaos/create-pairing-code", { vaultId: owner.vaultId, codeHash: "7".repeat(64) })],
			["session creation", post("/__yaos/create-session", { sessionHash: "8".repeat(64), exp: Date.now() + 60_000 })],
			["session verification", post("/__yaos/verify-session", { sessionHash: "8".repeat(64) })],
			["session revocation", post("/__yaos/revoke-session", { sessionHash: "8".repeat(64) })],
		] as const) {
			resetQueries(queries);
			const response = await runtime.fetch(request);
			assert.equal(response.status, 200, `${label}: ${await response.clone().text()}`);
			assertNoWholeCollectionRead(queries, label);
			assert.ok(queries.value <= 12, `${label} used ${queries.value} SQL statements`);
		}

		const governanceRequest = {
			governanceRequestId: "governance-hotpath", requestId: "destroy-request-hotpath",
			requestDigest: "d".repeat(64), vaultId: owner.vaultId,
			vaultGeneration: owner.vaultGeneration, kind: "vault-destroy", state: "confirmed",
			requestedByPrincipalId: owner.principalId, requestedByDeviceId: owner.deviceId,
			requestedByMembershipRevision: 1, requestedName: null, emergencyReason: null,
			createdAt: Date.now(), confirmedAt: Date.now(), completedAt: null, lastError: null,
		};
		await store.transaction(async (txn) => txn.records!.upsert("vaultGovernanceRequests", governanceRequest));
		resetQueries(queries);
		const destroy = await runtime.fetch(post("/__yaos/destroy-vault", {
			vaultId: owner.vaultId, governanceRequestId: governanceRequest.governanceRequestId,
		}));
		assert.equal(destroy.status, 200);
		assert.ok(queries.value <= 20, `destroy admission/mutation used ${queries.value} SQL statements`);
		assertNoWholeCollectionRead(queries, "destroy");
	});

	await withCountedStore(async (store, _sqlite, queries) => {
		const runtime = new ControlPlaneRuntime(store);
		const pairingCodeHash = "e".repeat(64);
		const claim = await runtime.fetch(post("/__yaos/claim", {
			operatorRecoveryHash: "f".repeat(64), ticketSigningKey: "ticket-signing-key",
			vaultId: "enrollment-target", vaultName: "Enrollment target",
			pairingCodeHash, pairingPurpose: "origin",
		}));
		const claimed = await claim.json() as { vaultGeneration: string };
		await runtime.fetch(post("/__yaos/activate-vault", {
			vaultId: "enrollment-target", vaultGeneration: claimed.vaultGeneration,
			pairingCodeHash, pairingPurpose: "origin",
		}));
		await store.put("securityAuditEvents", Array.from({ length: 10_000 }, (_, index): SecurityAuditEvent => ({
			eventId: `enroll-audit-${index}`, vaultId: `other-${index % 50}`,
			kind: "membership_authorized", actorPrincipalId: null, actorDeviceId: null,
			targetPrincipalId: null, targetDeviceId: null, createdAt: index, detail: null,
		})));
		resetQueries(queries);
		const enrollment = await runtime.fetch(post("/__yaos/enroll", {
			enrollmentRequestId: "large-enrollment-request", pairingCodeHash,
			deviceId: "large-enrollment-device", deviceTokenHash: "9".repeat(64),
			deviceName: "Large enrollment",
		}));
		assert.equal(enrollment.status, 200);
		assert.ok(queries.value <= 40, `enrollment and code consume used ${queries.value} SQL statements`);
		assertNoWholeCollectionRead(queries, "enrollment");
	});
});

await s.done();
