// The console imports qrcode-generator's browser build as text (server/wrangler.toml's Text rule). Node has no such
// loader, so tests/run-typescript.mjs aliases the import here: the same file's text, read from server/node_modules.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
export default readFileSync(serverRequire.resolve("qrcode-generator"), "utf8");
