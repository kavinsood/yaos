export type ClosedFileConflictDecision =
	| { kind: "no-op" }
	| { kind: "apply-remote-to-disk"; reason: "disk-at-baseline" }
	| { kind: "import-disk-to-crdt"; reason: "crdt-at-baseline" }
	| {
		kind: "preserve-conflict";
		reason: "both-changed" | "missing-baseline";
		winner: "disk";
		preserveCrdt: true;
	};

export interface ClosedFileConflictInput {
	baselineHash: string | null;
	diskHash: string;
	crdtHash: string;
}

export function decideClosedFileConflict(
	input: ClosedFileConflictInput,
): ClosedFileConflictDecision {
	const { baselineHash, diskHash, crdtHash } = input;
	if (diskHash === crdtHash) return { kind: "no-op" };
	if (baselineHash === null) {
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			winner: "disk",
			preserveCrdt: true,
		};
	}
	if (diskHash === baselineHash && crdtHash !== baselineHash) {
		return { kind: "apply-remote-to-disk", reason: "disk-at-baseline" };
	}
	if (crdtHash === baselineHash && diskHash !== baselineHash) {
		return { kind: "import-disk-to-crdt", reason: "crdt-at-baseline" };
	}
	return {
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	};
}
