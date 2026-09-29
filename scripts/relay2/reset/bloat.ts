/**
 * Small deterministic "edited history" generator for unit tests (the K2
 * fixtures in fixtures.ts are too big for the unit suite).
 */
import * as Y from "yjs";

export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

export interface BloatOptions {
	guid: string;
	seed?: number;
	/** Initial body text. */
	initial?: string;
	edits: number;
	/** Probability an edit is a delete (else insert). */
	deleteBias?: number;
	clients?: number;
	frontmatter?: boolean;
}

/** Random small inserts/deletes from rotating client ids → many (deleted) structs. */
export function bloatedDoc(options: BloatOptions): Y.Doc {
	const random = mulberry32(options.seed ?? 1);
	const doc = new Y.Doc({ guid: options.guid });
	const text = doc.getText("body");
	const clients = options.clients ?? 3;
	doc.clientID = 1_000;
	text.insert(0, options.initial ?? "---\ntitle: bloat\n---\n# Note\n\n" + "lorem ipsum dolor sit amet ".repeat(40));
	if (options.frontmatter !== false) {
		doc.getMap<number>("frontmatter:meta").set("format", 1);
		doc.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "bloat" });
	}
	const protectedPrefix = 32;
	const alphabet = "abcdefghijklmnopqrstuvwxyz \n";
	for (let index = 0; index < options.edits; index++) {
		doc.clientID = 2_000 + (Math.floor(index / 17) % clients);
		const length = text.length;
		const position = protectedPrefix + Math.floor(random() * Math.max(1, length - protectedPrefix));
		if (random() < (options.deleteBias ?? 0.48) && length > protectedPrefix + 8) {
			const count = 1 + Math.floor(random() * 4);
			text.delete(Math.min(position, length - count), count);
		} else {
			let insert = "";
			const count = 1 + Math.floor(random() * 6);
			for (let char = 0; char < count; char++) insert += alphabet[Math.floor(random() * alphabet.length)];
			text.insert(Math.min(position, length), insert);
		}
	}
	return doc;
}
