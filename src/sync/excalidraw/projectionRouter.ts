export interface ExcalidrawSemanticCatalogEntry {
	documentId: string;
	kind: "excalidraw";
	format: "excalidraw-native";
	formatVersion: 1;
}

export type ExcalidrawDiskRoute =
	| { kind: "attachment" }
	| { kind: "semantic-projection"; drawingId: string };

export interface ExcalidrawProjectionFingerprint {
	hash: string;
	size: number;
}

/**
 * Authority switch used by the generic disk pipeline. Promoted paths are never
 * republished as opaque attachment writes when the plugin autosaves a scene.
 */
export class ExcalidrawProjectionRouter {
	private readonly catalog = new Map<string, ExcalidrawSemanticCatalogEntry>();
	private readonly fingerprints = new Map<string, ExcalidrawProjectionFingerprint>();

	replaceCatalog(entries: Iterable<[string, ExcalidrawSemanticCatalogEntry]>): void {
		const next = new Map<string, ExcalidrawSemanticCatalogEntry>();
		for (const [path, entry] of entries) {
			if (entry.kind === "excalidraw" && entry.format === "excalidraw-native" && entry.formatVersion === 1) {
				next.set(path, entry);
			}
		}
		this.catalog.clear();
		for (const [path, entry] of next) this.catalog.set(path, entry);
		for (const path of this.fingerprints.keys()) if (!next.has(path)) this.fingerprints.delete(path);
	}

	route(path: string): ExcalidrawDiskRoute {
		const entry = this.catalog.get(path);
		return entry ? { kind: "semantic-projection", drawingId: entry.documentId } : { kind: "attachment" };
	}

	shouldPublishAsAttachment(path: string): boolean { return !this.catalog.has(path); }

	noteProjection(path: string, fingerprint: ExcalidrawProjectionFingerprint): boolean {
		if (!this.catalog.has(path)) return false;
		this.fingerprints.set(path, { ...fingerprint });
		return true;
	}

	isKnownProjection(path: string, fingerprint: ExcalidrawProjectionFingerprint): boolean {
		const known = this.fingerprints.get(path);
		return !!known && known.hash === fingerprint.hash && known.size === fingerprint.size;
	}
}
