import * as Y from "yjs";
import { collectLiveBlobHashes } from "../server/src/blobGc";

const doc = new Y.Doc();
doc.transact(() => {
	doc.getMap("pathToBlob").set("img/a.png", { hash: "a".repeat(64), size: 10 });
	doc.getMap("pathToBlob").set("img/b.png", { hash: "b".repeat(64), size: 20 });
});
const hashes = collectLiveBlobHashes(doc);
if (hashes.length !== 2 || !hashes.includes("a".repeat(64))) {
	console.error("FAIL: collectLiveBlobHashes");
	process.exit(1);
}
console.log("PASS: collectLiveBlobHashes");
