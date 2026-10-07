/**
 * TEST ONLY (testkit/: never imported by product code). Fixture vaultIds that pass the client's strict check
 * (isVaultId: 22-char canonical base64url of 16 bytes, server DECISIONS §2.1) and still read as their label.
 */

import { isVaultId } from "../../../core/codec/ids";
import type { VaultId } from "../../../core/types";

/** `label` (1..21 base64url chars) padded with "A" to a canonical 22-char vaultId: "v1" -> "v1AAAAAAAAAAAAAAAAAAAA". */
export function testVaultId(label: string): VaultId {
	const id = `${label}${"A".repeat(21)}`.slice(0, 21) + "A";
	if (label.length < 1 || label.length > 21 || !isVaultId(id)) throw new Error("testVaultId: the label must be 1..21 base64url chars");
	return id;
}

/** Strings a strict client refuses as a vaultId (server/src/vaultId.ts VAULT_ID_PATTERN, plus canonical): each is
 * close to the valid "AAECAwQFBgcICQoLDA0ODw" so a test failing on one names the exact rule it breaks. */
export const BAD_VAULT_IDS: readonly string[] = [
	"AAECAwQFBgcICQoLDA0OD", // 21 chars
	"AAECAwQFBgcICQoLDA0ODwA", // 23 chars
	"AAECAwQFBgcICQoLDA0ODw==", // padded
	"AAECAwQFBgcICQoLDA0OD+", // standard base64 alphabet
	"AAECAwQFBgcICQoLDA0OD/",
	"+/ECAwQFBgcICQoLDA0ODw",
	" AAECAwQFBgcICQoLDA0ODw", // never trimmed for the caller
	"AAECAwQFBgcICQoLDA0ODw\n",
	"AAECAwQFBgcICQoLDA0ODx", // non-canonical: the last char's unused low bits set
	"",
	"vault-1",
];
