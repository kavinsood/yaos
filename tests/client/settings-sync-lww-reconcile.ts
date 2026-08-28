import {
	decideLwwBoth,
	decideLwwMissingLocal,
	decideLwwMissingRemote,
	mutationRev,
	shouldPutMissingRemotePluginData,
} from "../../src/sync/settingsSync/lwwReconcile";
import { suite } from "../harness.ts";

const s = suite("settings-sync-lww-reconcile");

s.section("both sides exist");
{
	s.check(decideLwwBoth("aaa", "aaa", 4, { sha256: "aaa", rev: 3 }) === "nop", "equal hash is a no-op");
	s.check(decideLwwBoth("local", "remote", 5, { sha256: "local", rev: 4 }) === "take-remote", "newer server rev beats acknowledged local");
	s.check(decideLwwBoth("local", "remote", 5, { sha256: "old", rev: 4 }) === "take-remote", "newer server rev beats dirty local");
	s.check(decideLwwBoth("local", "remote", 4, { sha256: "old", rev: 4 }) === "put-local", "dirty local uploads when remote is not newer");
	s.check(decideLwwBoth("local", "remote", 3, { sha256: "local", rev: 4 }) === "nop", "stale GET does not clobber acknowledged local");
	s.check(decideLwwBoth("local", "remote", 1, undefined) === "put-local", "unacknowledged local uploads");
}

s.section("one side missing");
{
	s.check(decideLwwMissingLocal(false) === "take-remote", "unknown missing local takes remote");
	s.check(decideLwwMissingLocal(true) === "delete-remote", "acknowledged missing local deletes remote");
	s.check(decideLwwMissingRemote(false) === "put-local", "new local file uploads");
	s.check(decideLwwMissingRemote(true) === "delete-local", "acknowledged remote deletion removes local");
}


s.section("plugin data missing remotely");
{
	s.check(
		!shouldPutMissingRemotePluginData("same", true, { sha256: "same", rev: 2 }),
		"present matching plugin data is never re-uploaded",
	);
	s.check(
		!shouldPutMissingRemotePluginData("same", false, { sha256: "same", rev: 2 }),
		"acknowledged absent plugin data stays quiescent",
	);
	s.check(
		shouldPutMissingRemotePluginData("changed", false, { sha256: "old", rev: 2 }),
		"a new local plugin-data hash uploads once",
	);
}
s.section("mutation rev");
{
	s.check(mutationRev({ rev: 12, envRev: 12 }, 0) === 12, "reads positive mutation rev");
	s.check(mutationRev({ envRev: 3 }, 7) === 7, "missing rev preserves fallback");
	s.check(mutationRev({ rev: Number.NaN }, 5) === 5, "invalid rev preserves fallback");
	s.check(mutationRev(null, 1) === 1, "null body preserves fallback");
}

await s.done();
