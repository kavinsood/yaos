import * as Y from "yjs";
import * as sync from "y-protocols/sync";

// y-protocols imports yjs itself; the runner's yjs and y-protocols aliases must
// resolve both to one runtime, or Yjs logs "Yjs was already imported".
if (typeof Y.Doc !== "function" || typeof sync.writeUpdate !== "function") {
	throw new Error("runner alias probe did not load yjs and y-protocols");
}
