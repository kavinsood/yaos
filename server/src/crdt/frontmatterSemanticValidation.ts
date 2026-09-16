import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import type { YwasmCrdtDocument } from "./ywasmCrdtEngine";
import { validateFrontmatterSemanticSnapshots } from "./frontmatterSemanticSnapshots";

/** Server adapter which snapshots and releases every Wasm wrapper before validation. */
export function validateFrontmatterSemanticRoots(doc: YwasmCrdtDocument): string | null {
	return validateFrontmatterSemanticSnapshots(crdtEngine.snapshotRoots(doc));
}
