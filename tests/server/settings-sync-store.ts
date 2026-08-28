import { strict as assert } from "node:assert";
import {
	MAX_SETTINGS_CONFIG_KEY_LENGTH,
	MAX_SETTINGS_ENVIRONMENT_BODY_BYTES,
	MAX_SETTINGS_FILE_BYTES,
	MAX_SETTINGS_FILES,
	MAX_SETTINGS_ID_LENGTH,
	MAX_SETTINGS_REPO_LENGTH,
	MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES,
	MAX_SETTINGS_VERSION_LENGTH,
	SettingsSyncStore,
	handleSettingsSyncRequest,
	type SettingsSqlCursor,
	type SqlStorageValue,
} from "../../server/src/settingsSyncStore";
import { suite } from "../harness.ts";

const s = suite("settings-sync-store");
const KEY = ".obsidian";
const HASH = "a".repeat(64);

class FakeSqlCursor<T> implements SettingsSqlCursor<T> {
	constructor(private readonly rows: T[]) {}
	toArray(): T[] { return this.rows; }
	[Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

const PRIMARY_KEYS: Record<string, string[]> = {
	settings_env: ["config_key"], settings_files: ["config_key", "path"], settings_intents: ["config_key", "id"],
	settings_themes: ["config_key", "name"], settings_tombstones: ["config_key", "kind", "id"],
	settings_plugin_data: ["config_key", "plugin_id"],
};

function filters(clause: string, bindings: unknown[], start = 0): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let index = start;
	for (const part of clause.split(" AND ")) {
		const match = /^(\w+)\s*=\s*\?$/.exec(part.trim());
		if (!match) throw new Error(`FakeSql: bad WHERE ${part}`);
		result[match[1]!] = bindings[index++];
	}
	return result;
}
function matches(row: Record<string, unknown>, wanted: Record<string, unknown>): boolean {
	return Object.entries(wanted).every(([key, value]) => row[key] === value);
}

class FakeSqlStorage {
	private tables = new Map<string, Array<Record<string, unknown>>>();
	private table(name: string): Array<Record<string, unknown>> {
		let rows = this.tables.get(name);
		if (!rows) { rows = []; this.tables.set(name, rows); }
		return rows;
	}
	snapshot(): Array<[string, Array<Record<string, unknown>>]> {
		return [...this.tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]);
	}
	restore(snapshot: Array<[string, Array<Record<string, unknown>>]>): void {
		this.tables = new Map(snapshot.map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
	}
	exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): FakeSqlCursor<T> {
		const sql = query.trim().replace(/\s+/g, " ");
		const create = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql);
		if (create) { this.table(create[1]!); return new FakeSqlCursor<T>([]); }
		const insert = /^(INSERT OR REPLACE|INSERT) INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql);
		if (insert) {
			const table = insert[2]!;
			const columns = insert[3]!.split(",").map((column) => column.trim());
			const row = Object.fromEntries(columns.map((column, index) => [column, bindings[index]]));
			const rows = this.table(table);
			const keys = PRIMARY_KEYS[table] ?? columns.slice(0, 1);
			const prior = rows.findIndex((candidate) => keys.every((key) => candidate[key] === row[key]));
			if (prior >= 0) {
				if (insert[1]!.toUpperCase() !== "INSERT OR REPLACE") throw new Error("FakeSql: duplicate key");
				rows.splice(prior, 1);
			}
			rows.push(row);
			return new FakeSqlCursor<T>([]);
		}
		const update = /^UPDATE (\w+) SET (.+) WHERE (.+)$/i.exec(sql);
		if (update) {
			const setParts = update[2]!.split(",").map((part) => part.trim());
			const values: Record<string, unknown> = {};
			let index = 0;
			for (const part of setParts) {
				const match = /^(\w+)\s*=\s*\?$/.exec(part);
				if (!match) throw new Error(`FakeSql: bad SET ${part}`);
				values[match[1]!] = bindings[index++];
			}
			const wanted = filters(update[3]!, bindings, index);
			for (const row of this.table(update[1]!)) if (matches(row, wanted)) Object.assign(row, values);
			return new FakeSqlCursor<T>([]);
		}
		const deletion = /^DELETE FROM (\w+)(?: WHERE (.+))?$/i.exec(sql);
		if (deletion) {
			const table = deletion[1]!;
			this.tables.set(table, deletion[2] ? this.table(table).filter((row) => !matches(row, filters(deletion[2]!, bindings))) : []);
			return new FakeSqlCursor<T>([]);
		}
		const select = /^SELECT (.+) FROM (\w+)(?: WHERE (.+))?$/i.exec(sql);
		if (select) {
			const columns = select[1]!.split(",").map((column) => column.trim());
			let rows = [...this.table(select[2]!)];
			if (select[3]) rows = rows.filter((row) => matches(row, filters(select[3]!, bindings)));
			return new FakeSqlCursor<T>(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) as T[]);
		}
		throw new Error(`FakeSql: unhandled query ${sql}`);
	}
}

class FakeStorage {
	readonly sql = new FakeSqlStorage();
	transactionSync<T>(closure: () => T): T {
		const before = this.sql.snapshot();
		try { return closure(); }
		catch (error) { this.sql.restore(before); throw error; }
	}
}

function jsonBase64(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64"); }
function intent(version = "1.5.10") {
	return { id: "calendar", repo: "liamcain/obsidian-calendar-plugin", version, enabled: true };
}
function makeStore(): SettingsSyncStore { return new SettingsSyncStore(new FakeStorage()); }

s.test("seed, monotonic LWW, plugin version gates, and tombstones round-trip", () => {
	const store = makeStore();
	assert.deepEqual(store.getEnvironment(KEY), { ok: true, value: { seeded: false } });
	assert.deepEqual(store.seed(KEY, {
		files: [{ path: "app.json", sha256: HASH, bodyBase64: jsonBase64({ promptDelete: false }) }],
		intents: [intent()],
		themes: [{ name: "Minimal", repo: "kepano/obsidian-minimal", version: "7.0.0" }],
		pluginData: [{ pluginId: "calendar", pluginVersion: "1.5.10", sha256: HASH, bodyBase64: jsonBase64({ startDay: 1 }) }],
	}), { ok: true, value: { envRev: 1, rev: 1 } });
	assert.deepEqual(store.putFile(KEY, "app.json", HASH, jsonBase64({ promptDelete: true })),
		{ ok: true, value: { envRev: 2, rev: 2 } });
	assert.deepEqual(store.putPluginData(KEY, { pluginId: "calendar", pluginVersion: "1.5.9", sha256: HASH, bodyBase64: jsonBase64({}) }),
		{ ok: false, status: 409, error: "plugin_version_mismatch" });
	assert.deepEqual(store.putTombstone(KEY, { kind: "plugin", id: "calendar" }),
		{ ok: true, value: { envRev: 3, rev: 3 } });
	const got = store.getEnvironment(KEY);
	assert.ok(got.ok && got.value.seeded);
	assert.equal(got.value.files[0]?.rev, 2);
	assert.equal(got.value.intents.length, 0);
	assert.equal(got.value.pluginData.length, 0);
	assert.equal(got.value.tombstones[0]?.id, "calendar");
	assert.equal(store.putIntent(KEY, intent()).ok, true);
	const revived = store.getEnvironment(KEY);
	assert.equal(revived.ok && revived.value.seeded && revived.value.tombstones.length, 0);
});

s.test("invalid seed and duplicate replace fail atomically before mutation", () => {
	const failed = makeStore();
	assert.deepEqual(failed.seed(KEY, { files: [{ path: "app.json", sha256: HASH, bodyBase64: Buffer.from("{").toString("base64") }] }),
		{ ok: false, status: 400, error: "invalid_json" });
	assert.deepEqual(failed.getEnvironment(KEY), { ok: true, value: { seeded: false } });
	const store = makeStore();
	store.seed(KEY, { files: [{ path: "app.json", sha256: HASH, bodyBase64: jsonBase64({ before: true }) }] });
	assert.deepEqual(store.replace(KEY, { files: [
		{ path: "hotkeys.json", sha256: HASH, bodyBase64: jsonBase64({ one: true }) },
		{ path: "hotkeys.json", sha256: HASH, bodyBase64: jsonBase64({ two: true }) },
	] }), { ok: false, status: 400, error: "duplicate_entry" });
	const unchanged = store.getEnvironment(KEY);
	assert.ok(unchanged.ok && unchanged.value.seeded);
	assert.equal(unchanged.value.envRev, 1);
	assert.equal(unchanged.value.files[0]?.path, "app.json");
});

s.test("replace creates tombstones for missing unique live entries", () => {
	const store = makeStore();
	store.seed(KEY, {
		intents: [intent(), { id: "dataview", repo: "blacksmithgu/dataview", version: "0.5.67", enabled: true }],
		themes: [{ name: "Minimal", repo: "owner/minimal", version: "1" }, { name: "Things", repo: "owner/things", version: "1" }],
	});
	assert.equal(store.replace(KEY, { intents: [intent()], themes: [{ name: "Minimal", repo: "owner/minimal", version: "2" }] }).ok, true);
	const got = store.getEnvironment(KEY);
	assert.ok(got.ok && got.value.seeded);
	assert.deepEqual(got.value.tombstones.map((row) => `${row.kind}:${row.id}`), ["plugin:dataview", "theme:Things"]);
});

s.test("duplicates and every durable string/body/count boundary fail closed", () => {
	for (const snapshot of [
		{ intents: [intent(), intent()] },
		{ themes: [0, 1].map(() => ({ name: "Minimal", repo: "owner/repo", version: "1" })) },
		{ files: [0, 1].map(() => ({ path: "app.json", sha256: HASH, bodyBase64: jsonBase64({}) })) },
		{
			intents: [intent()],
			pluginData: [0, 1].map(() => ({
				pluginId: "calendar",
				pluginVersion: "1.5.10",
				sha256: HASH,
				bodyBase64: jsonBase64({}),
			})),
		},
	]) assert.deepEqual(makeStore().seed(KEY, snapshot), { ok: false, status: 400, error: "duplicate_entry" });
	for (const key of ["", ".", "..", "foo/bar", "foo\\bar", "a".repeat(MAX_SETTINGS_CONFIG_KEY_LENGTH + 1), "has\0nul"]) {
		assert.deepEqual(makeStore().getEnvironment(key), { ok: false, status: 400, error: "invalid_config_key" });
	}
	const store = makeStore();
	store.seed(KEY, {});
	assert.equal(store.putFile(KEY, "snippets/../app.json", HASH, jsonBase64({})).ok, false);
	assert.equal(store.putIntent(KEY, { id: "a".repeat(MAX_SETTINGS_ID_LENGTH + 1), repo: "owner/repo", version: "1", enabled: true }).ok, false);
	assert.equal(store.putIntent(KEY, { id: "valid", repo: "r".repeat(MAX_SETTINGS_REPO_LENGTH + 1), version: "1", enabled: true }).ok, false);
	assert.equal(store.putIntent(KEY, { id: "valid", repo: "owner/repo", version: "v".repeat(MAX_SETTINGS_VERSION_LENGTH + 1), enabled: true }).ok, false);
	assert.deepEqual(store.putIntent(KEY, { id: "yaos", repo: "owner/repo", version: "1", enabled: true }),
		{ ok: false, status: 400, error: "forbidden_plugin" });
	assert.equal(store.putFile(KEY, "app.json", "a".repeat(63), jsonBase64({})).ok, false);
	const huge = Buffer.alloc(MAX_SETTINGS_FILE_BYTES + 1, 97).toString("base64");
	assert.deepEqual(store.putFile(KEY, "snippets/large.css", HASH, huge), { ok: false, status: 413, error: "oversized" });
	const tooMany = makeStore().seed(KEY, { files: Array.from({ length: MAX_SETTINGS_FILES + 1 }, (_, index) => ({
		path: `snippets/${index}.css`, sha256: HASH, bodyBase64: Buffer.from("a").toString("base64"),
	})) });
	assert.deepEqual(tooMany, { ok: false, status: 413, error: "too_many_entries" });
	const aggregateBodySize = Math.floor(MAX_SETTINGS_ENVIRONMENT_BODY_BYTES / 5) + 1;
	const aggregate = makeStore().seed(KEY, { files: Array.from({ length: 5 }, (_, index) => ({
		path: `snippets/aggregate-${index}.css`,
		sha256: HASH,
		bodyBase64: Buffer.alloc(aggregateBodySize, 97).toString("base64"),
	})) });
	assert.deepEqual(aggregate, { ok: false, status: 413, error: "environment_too_large" });
});

s.test("bounded HTTP reader rejects an oversized snapshot before seed", async () => {
	const store = makeStore();
	const response = await handleSettingsSyncRequest(store, new Request("https://internal/settings-sync/.obsidian/seed?settingsFormatVersion=1", {
		method: "PUT", headers: { "content-length": String(MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES + 1) }, body: "{}",
	}), KEY, "seed");
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { error: "request_too_large" });
	assert.deepEqual(store.getEnvironment(KEY), { ok: true, value: { seeded: false } });
});


s.test("HTTP mutation binds declared SHA-256 to exact body bytes", async () => {
	const store = makeStore();
	const response = await handleSettingsSyncRequest(
		store,
		new Request("https://internal/settings-sync/.obsidian/seed?settingsFormatVersion=1", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [{
					path: "app.json",
					sha256: "0".repeat(64),
					bodyBase64: Buffer.from("{}").toString("base64"),
				}],
				intents: [],
				themes: [],
				pluginData: [],
			}),
		}),
		KEY,
		"seed",
	);
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "hash_mismatch" });
	assert.deepEqual(store.getEnvironment(KEY), { ok: true, value: { seeded: false } });
});
await s.done();
