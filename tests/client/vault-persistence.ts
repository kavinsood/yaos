import { sha256TextHex } from "../../src/utils/sha256";
import {
	computeFolderKey,
	folderKeySeed,
	vaultIdbName,
} from "../../src/sync/vaultPersistence";
import { schema4VaultIdbName } from "../../src/sync/vaultIndexedDb";
import { readSource, suite } from "../harness.ts";

const s = suite("vault-persistence");

s.section("Folder-keyed schema-4 persistence");
{
	s.check(folderKeySeed({ basePath: "/Users/me/Work", vaultName: "Notes" }) === "/Users/me/Work", "base path scopes the folder key");
	s.check(folderKeySeed({ basePath: "   ", vaultName: "Notes" }) === "Notes", "vault name is the fallback seed");
	const digest = await sha256TextHex("/Users/me/Work");
	const folderKey = await computeFolderKey("/Users/me/Work");
	s.check(folderKey === digest.slice(0, 16), "folder key is the first 16 SHA-256 hex characters");
	s.check(vaultIdbName("vault-1", folderKey) === `yaos:vault-1:${folderKey}`, "base identity combines vault and local folder");
	s.check(
		schema4VaultIdbName("vault-1", "generation-1", folderKey)
			=== `yaos:vault-1:generation-1:${folderKey}:schema-4`,
		"schema-4 cache uses a generation-fenced namespace",
	);
	s.check(
		schema4VaultIdbName("vault-1", "generation-1", "folder-a")
			!== schema4VaultIdbName("vault-1", "generation-1", "folder-b"),
		"two local folders never share body candidates or documents",
	);
}

s.section("Runtime uses explicit schema-4 storage and server-derived device receipts");
{
	const runtime = readSource("src/sync/vaultSync.ts");
	const database = readSource("src/sync/vaultIndexedDb.ts");
	const main = readSource("src/main.ts");
	s.check(!runtime.includes("IndexeddbPersistence"), "runtime never opens the schema-3 whole-document cache");
	s.check(!runtime.includes("\"x-yaos-client-id\""), "candidate requests never send a client-selected durable identity");
	s.check(!database.includes("clientId: string;\\n\\tcandidateDigest"), "pending candidates do not persist a clientId");
	s.check(
		main.includes("this.settings.vaultGeneration,"),
		"startup passes the active vault generation into schema-4 storage",
	);
}

await s.done();
