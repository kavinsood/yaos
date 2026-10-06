/**
 * A semantic epoch identifies one CRDT identity lineage.
 *
 * Durable generation advances for ordinary commits. Runtime epoch advances when
 * a Durable Object restarts. Semantic epoch advances only when YAOS replaces a
 * Y.Doc with a freshly materialized document and deliberately abandons its old
 * struct identities.
 */
export type SemanticEpoch = number;

export const INITIAL_SEMANTIC_EPOCH: SemanticEpoch = 1;
export const SEMANTIC_EPOCH_MISMATCH_STATUS = 409;
export const SEMANTIC_EPOCH_MISMATCH_CODE = "semantic_epoch_mismatch" as const;
export const SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE = 4409;

export const BODY_EPOCH_HEADER = "x-yaos-body-epoch" as const;
export const ROOT_EPOCH_HEADER = "x-yaos-root-epoch" as const;

/** Required persisted metadata for an ordinary body record. */
export interface BodyEpochBound {
	bodyEpoch: SemanticEpoch;
}

/** Required persisted metadata for the replication-only root record. */
export interface RootEpochBound {
	rootEpoch: SemanticEpoch;
}

/** Durable records never use one ambiguous `epoch` field for both domains. */
export type PersistedDocumentEpoch =
	| ({ purpose: "root"; documentId: "root" } & RootEpochBound)
	| ({ purpose: "body"; documentId: string } & BodyEpochBound);

export type SemanticEpochScope =
	| { purpose: "root"; documentId: "root"; rootEpoch: SemanticEpoch }
	| { purpose: "body"; documentId: string; bodyEpoch: SemanticEpoch };

export type SemanticEpochFence =
	| { purpose: "root"; documentId: "root"; expectedRootEpoch: SemanticEpoch; receivedRootEpoch: SemanticEpoch }
	| { purpose: "body"; documentId: string; expectedBodyEpoch: SemanticEpoch; receivedBodyEpoch: SemanticEpoch };

export interface SemanticEpochMismatchPayload {
	error: typeof SEMANTIC_EPOCH_MISMATCH_CODE;
	purpose: "root" | "body";
	documentId: string;
	expectedEpoch: SemanticEpoch;
	receivedEpoch: SemanticEpoch;
	reset: "fetch_fresh_baseline";
}

export interface SemanticEpochResetFrame {
	type: "SEMANTIC_EPOCH_RESET_REQUIRED";
	code: typeof SEMANTIC_EPOCH_MISMATCH_CODE;
	purpose: "root" | "body";
	documentId: string;
	expectedEpoch: SemanticEpoch;
	receivedEpoch: SemanticEpoch;
}

export class SemanticEpochMismatchError extends Error {
	readonly code = SEMANTIC_EPOCH_MISMATCH_CODE;
	readonly status = SEMANTIC_EPOCH_MISMATCH_STATUS;

	constructor(readonly fence: SemanticEpochFence) {
		const { expectedEpoch, receivedEpoch } = epochPair(fence);
		if (!fence.documentId || (fence.purpose === "body") === (fence.documentId === "root")) {
			throw new Error("invalid semantic epoch fence identity");
		}
		if (expectedEpoch === receivedEpoch) throw new Error("semantic epoch fence requires a mismatch");
		super(`${fence.purpose} ${fence.documentId} semantic epoch ${receivedEpoch} is fenced; current epoch is ${expectedEpoch}`);
		this.name = "SemanticEpochMismatchError";
	}

	toPayload(): SemanticEpochMismatchPayload {
		const { expectedEpoch, receivedEpoch } = epochPair(this.fence);
		return {
			error: this.code,
			purpose: this.fence.purpose,
			documentId: this.fence.documentId,
			expectedEpoch,
			receivedEpoch,
			reset: "fetch_fresh_baseline",
		};
	}

	toSocketFrame(): SemanticEpochResetFrame {
		const payload = this.toPayload();
		return {
			type: "SEMANTIC_EPOCH_RESET_REQUIRED",
			code: payload.error,
			purpose: payload.purpose,
			documentId: payload.documentId,
			expectedEpoch: payload.expectedEpoch,
			receivedEpoch: payload.receivedEpoch,
		};
	}
}

export function parseSemanticEpoch(value: unknown, field = "semantic epoch"): SemanticEpoch {
	if (!Number.isSafeInteger(value) || (value as number) < INITIAL_SEMANTIC_EPOCH) {
		throw new Error(`invalid ${field}`);
	}
	return value as SemanticEpoch;
}

export function nextSemanticEpoch(current: SemanticEpoch): SemanticEpoch {
	const parsed = parseSemanticEpoch(current);
	if (parsed === Number.MAX_SAFE_INTEGER) throw new Error("semantic epoch exhausted");
	return parsed + 1;
}

export function semanticEpochOf(scope: SemanticEpochScope): SemanticEpoch {
	if (!scope.documentId || (scope.purpose === "body") === (scope.documentId === "root")) {
		throw new Error("invalid semantic epoch scope identity");
	}
	return scope.purpose === "root"
		? parseSemanticEpoch(scope.rootEpoch, "root epoch")
		: parseSemanticEpoch(scope.bodyEpoch, "body epoch");
}

export function semanticEpochHeaders(scope: SemanticEpochScope): Record<string, string> {
	return scope.purpose === "root"
		? { [ROOT_EPOCH_HEADER]: String(parseSemanticEpoch(scope.rootEpoch, "root epoch")) }
		: { [BODY_EPOCH_HEADER]: String(parseSemanticEpoch(scope.bodyEpoch, "body epoch")) };
}

export function parseSemanticEpochHeader(
	headers: Record<string, string | undefined> | { get(name: string): string | null },
	purpose: "root" | "body",
): SemanticEpoch {
	const name = purpose === "root" ? ROOT_EPOCH_HEADER : BODY_EPOCH_HEADER;
	const record = headers as Record<string, string | undefined>;
	const raw = "get" in headers && typeof headers.get === "function"
		? headers.get(name) ?? undefined
		: record[name] ?? record[name.replace(/^x/, "X").replace(/-([a-z])/g, (_match, letter: string) => `-${letter.toUpperCase()}`)];
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) throw new Error(`missing or invalid ${purpose} epoch header`);
	return parseSemanticEpoch(Number(raw), `${purpose} epoch header`);
}

export function assertSemanticEpoch(expected: SemanticEpochScope, received: SemanticEpochScope): void {
	if (expected.purpose !== received.purpose || expected.documentId !== received.documentId) {
		throw new Error("semantic epoch scope identity mismatch");
	}
	const expectedEpoch = semanticEpochOf(expected);
	const receivedEpoch = semanticEpochOf(received);
	if (expectedEpoch === receivedEpoch) return;
	if (expected.purpose === "root" && received.purpose === "root") {
		throw new SemanticEpochMismatchError({
			purpose: "root", documentId: "root",
			expectedRootEpoch: expectedEpoch, receivedRootEpoch: receivedEpoch,
		});
	}
	if (expected.purpose === "body" && received.purpose === "body") {
		throw new SemanticEpochMismatchError({
			purpose: "body", documentId: expected.documentId,
			expectedBodyEpoch: expectedEpoch, receivedBodyEpoch: receivedEpoch,
		});
	}
	throw new Error("semantic epoch scope identity mismatch");
}

export function parseSemanticEpochMismatchPayload(value: unknown): SemanticEpochMismatchPayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.error !== SEMANTIC_EPOCH_MISMATCH_CODE
		|| (record.purpose !== "root" && record.purpose !== "body")
		|| typeof record.documentId !== "string" || !record.documentId
		|| record.reset !== "fetch_fresh_baseline") return null;
	if ((record.purpose === "root") !== (record.documentId === "root")) return null;
	try {
		const expectedEpoch = parseSemanticEpoch(record.expectedEpoch, "expected semantic epoch");
		const receivedEpoch = parseSemanticEpoch(record.receivedEpoch, "received semantic epoch");
		if (expectedEpoch === receivedEpoch) return null;
		return {
			error: SEMANTIC_EPOCH_MISMATCH_CODE,
			purpose: record.purpose,
			documentId: record.documentId,
			expectedEpoch,
			receivedEpoch,
			reset: "fetch_fresh_baseline",
		};
	} catch {
		return null;
	}
}

export function parseSemanticEpochResetFrame(value: unknown): SemanticEpochResetFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "SEMANTIC_EPOCH_RESET_REQUIRED" || record.code !== SEMANTIC_EPOCH_MISMATCH_CODE) return null;
	const payload = parseSemanticEpochMismatchPayload({
		error: record.code,
		purpose: record.purpose,
		documentId: record.documentId,
		expectedEpoch: record.expectedEpoch,
		receivedEpoch: record.receivedEpoch,
		reset: "fetch_fresh_baseline",
	});
	return payload ? {
		type: "SEMANTIC_EPOCH_RESET_REQUIRED",
		code: payload.error,
		purpose: payload.purpose,
		documentId: payload.documentId,
		expectedEpoch: payload.expectedEpoch,
		receivedEpoch: payload.receivedEpoch,
	} : null;
}

function epochPair(fence: SemanticEpochFence): { expectedEpoch: SemanticEpoch; receivedEpoch: SemanticEpoch } {
	return fence.purpose === "root"
		? {
			expectedEpoch: parseSemanticEpoch(fence.expectedRootEpoch, "expected root epoch"),
			receivedEpoch: parseSemanticEpoch(fence.receivedRootEpoch, "received root epoch"),
		}
		: {
			expectedEpoch: parseSemanticEpoch(fence.expectedBodyEpoch, "expected body epoch"),
			receivedEpoch: parseSemanticEpoch(fence.receivedBodyEpoch, "received body epoch"),
		};
}
