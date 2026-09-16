import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import type { YwasmCrdtDocument } from "./ywasmCrdtEngine";
import { validateFrontmatterSemanticSnapshots } from "./frontmatterSemanticSnapshots";

const FRONTMATTER_ROOT_FILTER = { prefixes: ["frontmatter:"] } as const;

/** Server adapter which snapshots and releases every Wasm wrapper before validation. */
export function validateFrontmatterSemanticRoots(doc: YwasmCrdtDocument): string | null {
	return validateFrontmatterSemanticSnapshots(crdtEngine.snapshotRoots(doc, FRONTMATTER_ROOT_FILTER));
}
