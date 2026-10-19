/** Canvas ranks for tests and the reconcile testkit. Never shipped. */

import type { CanvasRanked, CanvasSemanticData } from "../canvasCanonical";
import { initialCanvasRanks } from "../canvasOrdering";

/** Initial ranks in file order, for a canvas that carries no ranks. */
export function rankCanvasInFileOrder(data: CanvasSemanticData): CanvasRanked {
	return { data, nodeRanks: initialCanvasRanks(data.nodeOrder), edgeRanks: initialCanvasRanks(data.edgeOrder) };
}
