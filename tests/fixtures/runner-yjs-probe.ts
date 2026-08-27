import * as Y from "yjs";
import { VaultSyncServer } from "../../server/src/server";

if (typeof Y.Doc !== "function" || typeof VaultSyncServer !== "function") {
	throw new Error("runner alias probe did not load both product trees");
}
