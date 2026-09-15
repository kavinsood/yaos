import type { ExcalidrawBatchRequest, ExcalidrawElementRecord,
	ExcalidrawResourceManifest } from "@shared/excalidrawProtocol";

export type { ExcalidrawBatchReceipt, ExcalidrawBatchRequest, ExcalidrawDrawingEpoch,
	ExcalidrawElementRecord, ExcalidrawReplayPage, ExcalidrawResourceManifest,
	ExcalidrawResourceManifestEntry, ExcalidrawRoomEvent, ExcalidrawSceneMetadata,
	ExcalidrawSnapshot, ExcalidrawInitializeRequest, ExcalidrawPromotionPrepareRequest,
	ExcalidrawPromotionPrepareReceipt, ExcalidrawPromotionFinalizeRequest,
	ExcalidrawPromotionFinalizeReceipt, ExcalidrawLifecycleRequest, ExcalidrawLifecycleReceipt,
	ExcalidrawSourceAuthority } from "@shared/excalidrawProtocol";

export interface ExcalidrawElementRevision {
	elementId: string;
	version: number;
	versionNonce: number;
	isDeleted: boolean;
	canonicalHash: string;
}

export interface ExcalidrawNativeFile {
	id: string;
	dataURL: string;
	mimeType: string;
	created: number;
	lastRetrieved?: number;
	[key: string]: unknown;
}

export interface StoredExcalidrawOutboxOperation {
	drawingId: string;
	operation: ExcalidrawBatchRequest;
	createdAt: number;
	attempts: number;
	lastAttemptAt: number | null;
}

export interface StoredExcalidrawProjection {
	format: 1;
	drawingId: string;
	drawingEpoch: number;
	sequence: number;
	elements: ExcalidrawElementRecord[];
	metadata: { resourceManifest: ExcalidrawResourceManifest; appState?: Record<string, unknown>; plugin?: Record<string, unknown> };
	updatedAt: number;
}

export interface ExcalidrawResourceResolution {
	files: ExcalidrawNativeFile[];
	unavailable: Array<{ resourceId: string; reason: string }>;
}

export interface StoredExcalidrawPromotionIntent {
	drawingId: string;
	path: string;
	prepare: import("@shared/excalidrawProtocol").ExcalidrawPromotionPrepareRequest;
	initialize: import("@shared/excalidrawProtocol").ExcalidrawInitializeRequest;
	finalize: import("@shared/excalidrawProtocol").ExcalidrawPromotionFinalizeRequest;
	stage: "captured" | "prepared" | "initialized";
	createdAt: number;
	updatedAt: number;
}

export interface StoredExcalidrawLifecycleIntent {
	request: import("@shared/excalidrawProtocol").ExcalidrawLifecycleRequest;
	createdAt: number;
	attempts: number;
	lastAttemptAt: number | null;
}

export interface StoredExcalidrawProjectionPlan {
	operationId: string;
	drawingId: string;
	path: string;
	expectedFileId: string;
	expectedDiskHash: string;
	targetBytes: ArrayBuffer;
	targetBytesHash: string;
	targetCanonicalSceneHash: string;
	targetSequence: number;
	createdAt: number;
	attempts: number;
}

export interface StoredExcalidrawAlternative {
	alternativeId: string;
	drawingId: string;
	reason: "drawing_epoch_superseded" | "authority_superseded";
	operation: ExcalidrawBatchRequest;
	fromDrawingEpoch: number;
	currentDrawingEpoch: number;
	preservedAt: number;
}
