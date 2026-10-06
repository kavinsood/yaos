export const CANVAS_LIMITS = Object.freeze({
	canonicalBytes: 1024 * 1024,
	nodes: 20_000,
	edges: 40_000,
	textBytes: 256 * 1024,
	aggregateTextBytes: 1024 * 1024,
	jsonDepth: 32,
	identifierBytes: 1024,
	rankBytes: 128,
	unknownValueBytes: 256 * 1024,
	resolvedConflicts: 1000,
});

export type CanvasLimitName = keyof typeof CANVAS_LIMITS;
