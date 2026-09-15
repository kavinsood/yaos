import { strict as assert } from "node:assert";
import { ExcalidrawProjectionRouter } from "../../src/sync/excalidraw/projectionRouter";
import { suite } from "../harness.ts";

const s = suite("excalidraw-projection-router");

s.test("promoted autosaves remain semantic projections and ordinary files remain attachments", () => {
	const router = new ExcalidrawProjectionRouter();
	router.replaceCatalog([["Drawing.md", { documentId: "drawing1", kind: "excalidraw",
		format: "excalidraw-native", formatVersion: 1 }]]);
	assert.deepEqual(router.route("Drawing.md"), { kind: "semantic-projection", drawingId: "drawing1" });
	assert.equal(router.shouldPublishAsAttachment("Drawing.md"), false);
	assert.deepEqual(router.route("Note.md"), { kind: "attachment" });
	assert.equal(router.noteProjection("Drawing.md", { hash: "a", size: 10 }), true);
	assert.equal(router.isKnownProjection("Drawing.md", { hash: "a", size: 10 }), true);
	router.replaceCatalog([]);
	assert.equal(router.shouldPublishAsAttachment("Drawing.md"), true);
	assert.equal(router.isKnownProjection("Drawing.md", { hash: "a", size: 10 }), false);
});

s.test("catalog rename switches semantic exclusion atomically to the destination", () => {
	const router = new ExcalidrawProjectionRouter();
	const entry = { documentId: "drawing1", kind: "excalidraw" as const,
		format: "excalidraw-native" as const, formatVersion: 1 as const };
	router.replaceCatalog([["Board.excalidraw.md", entry]]);
	router.replaceCatalog([["Moved.excalidraw.md", entry]]);
	assert.equal(router.shouldPublishAsAttachment("Moved.excalidraw.md"), false);
	assert.equal(router.shouldPublishAsAttachment("Board.excalidraw.md"), true);
});

await s.done();
