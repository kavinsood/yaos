export type LwwAck = {
	sha256: string;
	rev: number;
};

export type LwwBoth = "nop" | "take-remote" | "put-local";
export type LwwMissingLocal = "take-remote" | "delete-remote";
export type LwwMissingRemote = "put-local" | "delete-local";

export function decideLwwBoth(
	localSha: string,
	remoteSha: string,
	remoteRev: number,
	ack: LwwAck | undefined,
): LwwBoth {
	if (localSha === remoteSha) return "nop";
	if (ack && remoteRev > ack.rev) return "take-remote";
	if (!ack || ack.sha256 !== localSha) return "put-local";
	return "nop";
}

export function decideLwwMissingLocal(hasAck: boolean): LwwMissingLocal {
	return hasAck ? "delete-remote" : "take-remote";
}

export function decideLwwMissingRemote(hasAck: boolean): LwwMissingRemote {
	return hasAck ? "delete-local" : "put-local";
}

export function shouldPutMissingRemotePluginData(
	localSha: string,
	remotePresent: boolean,
	ack: LwwAck | undefined,
): boolean {
	return !remotePresent && ack?.sha256 !== localSha;
}

export function mutationRev(json: unknown, fallback: number): number {
	if (!json || typeof json !== "object" || !("rev" in json)) return fallback;
	const rev = json.rev;
	return typeof rev === "number" && Number.isFinite(rev) && rev > 0 ? rev : fallback;
}
