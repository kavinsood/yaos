import * as Y from "yjs";

export function collectLiveBlobHashes(doc: Y.Doc): string[] {
	const pathToBlob = doc.getMap<{ hash: string; size: number }>("pathToBlob");
	const live = new Set<string>();
	pathToBlob.forEach((ref) => {
		if (ref?.hash) live.add(ref.hash);
	});
	return [...live];
}
