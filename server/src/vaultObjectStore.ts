import { blobObjectKey } from "./recoveryProtocol";

export function blobKey(vaultId: string, vaultGeneration: string, hash: string): string {
	return blobObjectKey(vaultId, vaultGeneration, hash);
}
