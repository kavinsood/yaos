import { sha256TextHex } from "../../src/utils/sha256";
import {
	computeFolderKey,
	folderKeySeed,
	nextSysGeneration,
	readSysGeneration,
	receiptRoomName,
	vaultIdbName,
} from "../../src/sync/vaultPersistence";
import { readSource, suite } from "../harness.ts";

const s = suite("vault-persistence");

s.section("Folder-keyed persistence");
{
	s.check(folderKeySeed({ basePath: "/Users/me/Work", vaultName: "Notes" }) === "/Users/me/Work", "base path scopes the folder key");
	s.check(folderKeySeed({ basePath: "   ", vaultName: "Notes" }) === "Notes", "vault name is the fallback seed");
	const digest = await sha256TextHex("/Users/me/Work");
	const folderKey = await computeFolderKey("/Users/me/Work");
	s.check(folderKey === digest.slice(0, 16), "folder key is the first 16 SHA-256 hex characters");
	s.check(vaultIdbName("vault-1", folderKey) === `yaos:vault-1:${folderKey}`, "IDB name combines server vault and local folder");
}

s.section("Receipt generation scope");
{
	s.check(readSysGeneration(undefined) === 0, "missing generation starts at zero");
	s.check(readSysGeneration(-1) === 0, "invalid generation starts at zero");
	s.check(nextSysGeneration(4) === 5, "nuclear reset advances the generation");
	s.check(receiptRoomName("vault-1", 5) === "vault-1:5", "receipt room is scoped by vault and generation");
}

s.section("No legacy persistence namespace fallback");
{
	const source = readSource("src/sync/vaultSync.ts");
	s.check(source.includes("vaultIdbName(settings.vaultId, options.folderKey)"), "VaultSync always opens the folder-keyed database");
	s.check(source.includes("static deleteIdb(vaultId: string, folderKey: string)"), "database deletion requires the local folder key");
	s.check(source.includes("this.sys.set(\"generation\", nextGeneration)"), "nuclear reset writes the next receipt generation");
	s.check(
		source.includes("receiptRoomName(base.vaultId, generation)") &&
			source.includes("roomGeneration: generation"),
		"receipt persistence uses authoritative generation scope",
	);
	const main = readSource("src/main.ts");
	s.check(main.includes("await VaultSync.deleteIdb(vaultId, await this.ensureFolderKey())"), "reset and leave delete only the current folder database");
}

await s.done();
