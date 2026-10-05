import * as Y from "yjs";

export const BODY_RESIDENCY_ESTIMATOR_VERSION = "yaos-body-residency-v1" as const;

const BODY_METADATA_ESTIMATE_BYTES = 512;
const YJS_STRUCT_OVERHEAD_ESTIMATE_BYTES = 96;
const YJS_DELETED_STRUCT_EXTRA_ESTIMATE_BYTES = 24;
const YJS_CLIENT_BUCKET_ESTIMATE_BYTES = 64;
const PROVIDER_ESTIMATE_BYTES = 8 * 1024;
const SOCKET_ESTIMATE_BYTES = 16 * 1024;
const AWARENESS_PEER_ESTIMATE_BYTES = 256;
const RECONSTRUCTION_FIXED_ESTIMATE_BYTES = 1024;

export interface BodyExternalResourceSignals {
	localPendingBufferBytes: number;
	remotePendingBufferBytes: number;
	providerCount: number;
	socketCount: number;
	awarenessPeerCount: number;
}

export interface SharedResidencyResourceSignals {
	rootCatalogReportedBytes: number;
	pendingBufferBytes: number;
	providerCount: number;
	socketCount: number;
	awarenessPeerCount: number;
}

export const EMPTY_SHARED_RESIDENCY_RESOURCE_SIGNALS: SharedResidencyResourceSignals = {
	rootCatalogReportedBytes: 0,
	pendingBufferBytes: 0,
	providerCount: 0,
	socketCount: 0,
	awarenessPeerCount: 0,
};

export const EMPTY_BODY_EXTERNAL_RESOURCE_SIGNALS: BodyExternalResourceSignals = {
	localPendingBufferBytes: 0,
	remotePendingBufferBytes: 0,
	providerCount: 0,
	socketCount: 0,
	awarenessPeerCount: 0,
};

export interface BodyResidencyMeasurement {
	estimatorVersion: typeof BODY_RESIDENCY_ESTIMATOR_VERSION;
	/** Exact size of a freshly encoded full Yjs state; a serialization proxy, not retained heap. */
	encodedDocumentBytes: number;
	/** Exact JavaScript UTF-16 code-unit count for the materialized body text. */
	materializedTextCodeUnits: number;
	/** Exact UTF-8 size of the materialized body text. */
	materializedTextUtf8Bytes: number;
	/** Counts observed from Yjs's struct store. They characterize fragmentation, not bytes. */
	yjsStructCount: number;
	yjsDeletedStructCount: number;
	yjsClientBucketCount: number;
	/** Exact byte lengths of Yjs updates waiting on missing clocks/delete sets. */
	yjsPendingStructBytes: number;
	yjsPendingDeleteSetBytes: number;
	external: BodyExternalResourceSignals;
	estimatedComponents: {
		serializedStateProxyBytes: number;
		materializedTextPayloadBytes: number;
		yjsStructOverheadBytes: number;
		pendingBufferBytes: number;
		transportAndAwarenessBytes: number;
		bodyMetadataBytes: number;
	};
	estimatedResidentBytes: number;
	fragmentation: {
		structsPerThousandTextCodeUnits: number;
		deletedStructFraction: number;
	};
	claim: "heuristic-resident-estimate-not-heap-measurement";
}

export type BodyEvictionBlocker =
	| "dirty"
	| "unsettled-candidate"
	| "pending-local-update"
	| "pin"
	| "lease"
	| "projection-owner"
	| "synchronization"
	| "runtime-lifetime";

export type TemporaryResidencyKind =
	| "load-decode"
	| "server-reconstruction"
	| "server-replacement"
	| "merge"
	| "persistence-encode"
	| "recovery"
	| "other";

export interface TemporaryResidencyReservation {
	readonly reservationId: string;
	readonly kind: TemporaryResidencyKind;
	readonly ownerId: string;
	readonly estimatedBytes: number;
	readonly createdAt: number;
}

export interface BodyResidencyBodySnapshot {
	bodyId: string;
	estimatedResidentBytes: number;
	encodedDocumentBytes: number;
	materializedTextCodeUnits: number;
	yjsStructCount: number;
	yjsDeletedStructCount: number;
	fragmentation: BodyResidencyMeasurement["fragmentation"];
	providerCount: number;
	socketCount: number;
	awarenessPeerCount: number;
	localPendingBufferBytes: number;
	remotePendingBufferBytes: number;
	blockers: BodyEvictionBlocker[];
}

export interface NumericDistribution {
	count: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
}

export interface ColdLoadAdmissionEstimate {
	estimatorVersion: typeof BODY_RESIDENCY_ESTIMATOR_VERSION;
	encodedInputBytes: number;
	estimatedResidentBytes: number;
	reconstructionScratchBytes: number;
	estimatedPeakAdditionalBytes: number;
	claim: "pre-decode-heuristic-not-admission-proof";
	caveat: string;
}

export interface BodyResidencySnapshot {
	formatVersion: 1;
	estimatorVersion: typeof BODY_RESIDENCY_ESTIMATOR_VERSION;
	claim: "heuristic-resident-estimate-not-heap-measurement";
	capturedAt: number;
	residentBudget: {
		bytes: number;
		scope: "body-resident-estimates-only";
		includesTemporaryReservations: false;
		includesSharedRootAndCatalog: false;
	};
	totals: {
		loadedBodies: number;
		loadingBodies: number;
		estimatedResidentBytes: number;
		temporaryReservedBytes: number;
		sharedReportedBytes: number;
		accountedEstimatedBytes: number;
		evictableBodies: number;
		blockedBodies: number;
	};
	shared: SharedResidencyResourceSignals & { estimatedBytes: number };
	highWater: {
		estimatedResidentBytes: number;
		accountedEstimatedBytes: number;
		loadedBodies: number;
	};
	loads: {
		requests: number;
		cacheHits: number;
		joinedInFlight: number;
		coldLoads: number;
		failures: number;
		cacheHitRate: number | null;
		latencyMs: NumericDistribution;
	};
	evictions: {
		completed: number;
		blockedAttempts: number;
		blockerObservations: Partial<Record<BodyEvictionBlocker, number>>;
	};
	distributions: {
		estimatedResidentBytes: NumericDistribution;
		encodedDocumentBytes: NumericDistribution;
		yjsStructCount: NumericDistribution;
		structsPerThousandTextCodeUnits: NumericDistribution;
	};
	temporaryReservations: TemporaryResidencyReservation[];
	bodies: BodyResidencyBodySnapshot[];
	caveats: string[];
}

function nonNegativeSafeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
	return value;
}

function safeAdd(...values: number[]): number {
	let total = 0;
	for (const value of values) total = Math.min(Number.MAX_SAFE_INTEGER, total + value);
	return total;
}

export function normalizeBodyExternalResourceSignals(
	input: Partial<BodyExternalResourceSignals> = {},
): BodyExternalResourceSignals {
	return {
		localPendingBufferBytes: nonNegativeSafeInteger(input.localPendingBufferBytes ?? 0, "local pending buffer bytes"),
		remotePendingBufferBytes: nonNegativeSafeInteger(input.remotePendingBufferBytes ?? 0, "remote pending buffer bytes"),
		providerCount: nonNegativeSafeInteger(input.providerCount ?? 0, "provider count"),
		socketCount: nonNegativeSafeInteger(input.socketCount ?? 0, "socket count"),
		awarenessPeerCount: nonNegativeSafeInteger(input.awarenessPeerCount ?? 0, "awareness peer count"),
	};
}

export function normalizeSharedResidencyResourceSignals(
	input: Partial<SharedResidencyResourceSignals> = {},
): SharedResidencyResourceSignals {
	return {
		rootCatalogReportedBytes: nonNegativeSafeInteger(input.rootCatalogReportedBytes ?? 0, "root/catalog reported bytes"),
		pendingBufferBytes: nonNegativeSafeInteger(input.pendingBufferBytes ?? 0, "shared pending buffer bytes"),
		providerCount: nonNegativeSafeInteger(input.providerCount ?? 0, "shared provider count"),
		socketCount: nonNegativeSafeInteger(input.socketCount ?? 0, "shared socket count"),
		awarenessPeerCount: nonNegativeSafeInteger(input.awarenessPeerCount ?? 0, "shared awareness peer count"),
	};
}

export function estimateSharedResidencyBytes(input: SharedResidencyResourceSignals): number {
	return safeAdd(
		input.rootCatalogReportedBytes,
		input.pendingBufferBytes,
		input.providerCount * PROVIDER_ESTIMATE_BYTES,
		input.socketCount * SOCKET_ESTIMATE_BYTES,
		input.awarenessPeerCount * AWARENESS_PEER_ESTIMATE_BYTES,
	);
}

export function measureBodyResidency(
	doc: Y.Doc,
	encodedDocumentBytes: number,
	externalInput: Partial<BodyExternalResourceSignals> = {},
): BodyResidencyMeasurement {
	const external = normalizeBodyExternalResourceSignals(externalInput);
	const text = doc.getText("body").toJSON();
	let yjsStructCount = 0;
	let yjsDeletedStructCount = 0;
	for (const structs of doc.store.clients.values()) {
		yjsStructCount += structs.length;
		for (const struct of structs) if (struct.deleted) yjsDeletedStructCount++;
	}
	const yjsPendingStructBytes = doc.store.pendingStructs?.update.byteLength ?? 0;
	const yjsPendingDeleteSetBytes = doc.store.pendingDs?.byteLength ?? 0;
	const materializedTextPayloadBytes = Math.min(Number.MAX_SAFE_INTEGER, text.length * 2);
	const yjsStructOverheadBytes = safeAdd(
		yjsStructCount * YJS_STRUCT_OVERHEAD_ESTIMATE_BYTES,
		yjsDeletedStructCount * YJS_DELETED_STRUCT_EXTRA_ESTIMATE_BYTES,
		doc.store.clients.size * YJS_CLIENT_BUCKET_ESTIMATE_BYTES,
	);
	const pendingBufferBytes = safeAdd(
		yjsPendingStructBytes,
		yjsPendingDeleteSetBytes,
		external.localPendingBufferBytes,
		external.remotePendingBufferBytes,
	);
	const transportAndAwarenessBytes = safeAdd(
		external.providerCount * PROVIDER_ESTIMATE_BYTES,
		external.socketCount * SOCKET_ESTIMATE_BYTES,
		external.awarenessPeerCount * AWARENESS_PEER_ESTIMATE_BYTES,
	);
	const estimatedComponents = {
		serializedStateProxyBytes: nonNegativeSafeInteger(encodedDocumentBytes, "encoded document bytes"),
		materializedTextPayloadBytes,
		yjsStructOverheadBytes,
		pendingBufferBytes,
		transportAndAwarenessBytes,
		bodyMetadataBytes: BODY_METADATA_ESTIMATE_BYTES,
	};
	return {
		estimatorVersion: BODY_RESIDENCY_ESTIMATOR_VERSION,
		encodedDocumentBytes: estimatedComponents.serializedStateProxyBytes,
		materializedTextCodeUnits: text.length,
		materializedTextUtf8Bytes: new TextEncoder().encode(text).byteLength,
		yjsStructCount,
		yjsDeletedStructCount,
		yjsClientBucketCount: doc.store.clients.size,
		yjsPendingStructBytes,
		yjsPendingDeleteSetBytes,
		external,
		estimatedComponents,
		estimatedResidentBytes: safeAdd(...Object.values(estimatedComponents)),
		fragmentation: {
			structsPerThousandTextCodeUnits: text.length === 0 ? yjsStructCount * 1000 : (yjsStructCount * 1000) / text.length,
			deletedStructFraction: yjsStructCount === 0 ? 0 : yjsDeletedStructCount / yjsStructCount,
		},
		claim: "heuristic-resident-estimate-not-heap-measurement",
	};
}

export function estimateReconstructionReservation(
	incomingEncodedBytes: number,
	existing?: Pick<BodyResidencyMeasurement, "encodedDocumentBytes" | "estimatedComponents">,
): number {
	const incoming = nonNegativeSafeInteger(incomingEncodedBytes, "incoming encoded bytes");
	return safeAdd(
		RECONSTRUCTION_FIXED_ESTIMATE_BYTES,
		incoming * 2,
		existing?.encodedDocumentBytes ?? 0,
		existing?.estimatedComponents.materializedTextPayloadBytes ?? 0,
	);
}

/**
 * Pre-decode estimate for RFC 09 admission. Encoded bytes cannot reveal final
 * text size or struct fragmentation, so this deliberately reserves a coarse
 * decoded proxy without opening a second Y.Doc.
 */
export function estimateColdLoadAdmission(encodedInputBytes: number): ColdLoadAdmissionEstimate {
	const encoded = nonNegativeSafeInteger(encodedInputBytes, "cold-load encoded bytes");
	const estimatedResidentBytes = safeAdd(
		BODY_METADATA_ESTIMATE_BYTES,
		encoded,
		encoded * 2,
	);
	const reconstructionScratchBytes = estimateReconstructionReservation(encoded);
	return {
		estimatorVersion: BODY_RESIDENCY_ESTIMATOR_VERSION,
		encodedInputBytes: encoded,
		estimatedResidentBytes,
		reconstructionScratchBytes,
		estimatedPeakAdditionalBytes: safeAdd(estimatedResidentBytes, reconstructionScratchBytes),
		claim: "pre-decode-heuristic-not-admission-proof",
		caveat: "Encoded input cannot predict decoded text size or fragmented Yjs history; remeasure after the single real decode.",
	};
}

export function numericDistribution(values: readonly number[]): NumericDistribution {
	if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
	return {
		count: sorted.length,
		min: sorted[0]!,
		p50: percentile(0.5),
		p95: percentile(0.95),
		max: sorted[sorted.length - 1]!,
	};
}
