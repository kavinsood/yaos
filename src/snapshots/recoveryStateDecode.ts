import * as Y from "yjs";
import { canonicalCanvasBytes } from "@shared/canvasCodec";
import { materializeCanvasDocument, validateCanvasDocument } from "@shared/canvasSemanticDocument";
import { MAX_RECOVERY_STATE_OBJECT_BYTES, parseRecoveryStateObject, type RecoveryStateObject } from "@shared/recoveryStateObject";

const encoder = new TextEncoder();

/**
 * Client-side decode of a format-4 recovery state object (b3 P2). The server
 * stores and serves the body's CRDT bytes opaquely; this applies them to an
 * empty document and derives the plaintext the manifest hashes: the Markdown
 * `body` text, or canonical Canvas JSON. The caller verifies size and sha256.
 * Throws on a malformed envelope, an update Yjs rejects, or an invalid canvas.
 */
export async function decodeRecoveryStateObject(bytes: Uint8Array): Promise<{ state: RecoveryStateObject; plain: Uint8Array }> {
	const state = parseRecoveryStateObject(bytes, MAX_RECOVERY_STATE_OBJECT_BYTES);
	const doc = new Y.Doc();
	try {
		for (const update of state.updates) Y.applyUpdate(doc, update, "recovery-state");
		if (state.kind === "markdown") return { state, plain: encoder.encode(doc.getText("body").toString()) };
		const error = await validateCanvasDocument(doc);
		if (error !== null) throw new Error(`recovery canvas state is invalid: ${error}`);
		return { state, plain: canonicalCanvasBytes(await materializeCanvasDocument(doc, false)) };
	} finally {
		doc.destroy();
	}
}
