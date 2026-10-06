/** DECISIONS §2.1: a vaultId is base64url(16 random bytes), exactly 22 characters. */
export const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isVaultId(value: unknown): value is string {
	return typeof value === "string" && VAULT_ID_PATTERN.test(value);
}
