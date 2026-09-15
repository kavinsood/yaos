import { canonicalExcalidrawJson, validateExcalidrawElement as validateSharedElement } from "@shared/excalidrawProtocol";
import { sha256TextHex } from "../../utils/sha256";
import type { ExcalidrawElementRecord, ExcalidrawElementRevision } from "./types";

export { canonicalExcalidrawJson };

export function validateExcalidrawElement(value: unknown): ExcalidrawElementRecord {
	validateSharedElement(value);
	return JSON.parse(canonicalExcalidrawJson(value)) as ExcalidrawElementRecord;
}

export async function revisionOf(element: ExcalidrawElementRecord): Promise<ExcalidrawElementRevision> {
	const canonicalHash = await sha256TextHex(canonicalExcalidrawJson(element));
	return { elementId: element.id, version: element.version, versionNonce: element.versionNonce,
		isDeleted: element.isDeleted, canonicalHash };
}

export function revisionKey(revision: ExcalidrawElementRevision): string {
	return `${revision.elementId}\u0000${revision.version}\u0000${revision.versionNonce}\u0000${revision.isDeleted ? 1 : 0}\u0000${revision.canonicalHash}`;
}

export async function operationHash(input: Omit<import("./types").ExcalidrawBatchRequest, "requestDigest">): Promise<string> {
	return sha256TextHex(canonicalExcalidrawJson(input));
}
