import { putBlobRecord, initBlobStoreSchema, type SqlStorage } from "../server/src/blobStoreSql";

class FullSql implements SqlStorage {
	exec(sql: string): unknown {
		if (/create table/i.test(sql)) return [];
		throw new Error("database or disk is full: SQLITE_FULL");
	}
}

const sql = new FullSql();
initBlobStoreSchema(sql);
const result = putBlobRecord(sql, "d".repeat(64), "text/plain", new Uint8Array([1]), Date.now());
if (result.error !== "full") {
	console.error("FAIL: expected full");
	process.exit(1);
}
console.log("PASS: SQLITE_FULL maps to { error: 'full' }");
