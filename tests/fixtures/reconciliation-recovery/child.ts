import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_ID, decodeText, openRecovery, readDisk, readRemote, readState, RECOVERY_AUTHORITY } from "./fixture.ts";
import { applyDiffToYText } from "../../../src/sync/diff";
import { ORIGIN_EDITOR_HEALTH_HEAL } from "../../../src/sync/origins";

const [root, operation, target = "", acceptedText = ""] = process.argv.slice(2);
if (!root || !operation) throw new Error("recovery child requires directory and operation");
let injectEditorUpdate: (() => void) | undefined;
const checkpoint = async (name: string) => {
	if (name === "before-candidate-persistence" && injectEditorUpdate) {
		const inject = injectEditorUpdate;
		injectEditorUpdate = undefined;
		await new Promise<void>((resolve) => setImmediate(resolve));
		inject();
	}
	if (target === "after-local-acceptance" && name === "before-remote-effect") {
		setInterval(() => {}, 1_000);
		await new Promise<void>(() => {});
	}
	if (name !== target) return;
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(`CHECKPOINT ${name} ${process.pid}\n`, (error) => error ? reject(error) : resolve());
	});
	setInterval(() => {}, 1_000);
	await new Promise<void>(() => {});
};
const fixture = await openRecovery(root, { checkpoint, initialize: operation.startsWith("recover"),
	authority: operation === "recover-authority-changed" ? { ...RECOVERY_AUTHORITY, membershipRevision: 2 } : undefined });
if (operation === "commit" || operation === "accept") {
	await fixture.commit(acceptedText, fixture.runtime.bodies.get(BODY_ID)!.doc.getText("body").toString(), operation === "commit");
	if (operation === "accept") await checkpoint("after-local-acceptance");
} else if (operation === "editor" || operation === "editor-concurrent") {
	const body = fixture.runtime.bodies.get(BODY_ID)!;
	const session = fixture.runtime["createBodySession"](body);
	fixture.runtime["sessions"].set(BODY_ID, session);
	if (operation === "editor-concurrent") {
		injectEditorUpdate = () => applyDiffToYText(body.doc.getText("body"), body.doc.getText("body").toString(), `${acceptedText}Newer concurrent editor input 🪸.\n`, ORIGIN_EDITOR_HEALTH_HEAL);
	}
	applyDiffToYText(body.doc.getText("body"), body.doc.getText("body").toString(), acceptedText, ORIGIN_EDITOR_HEALTH_HEAL);
	await new Promise<void>(() => {});
} else if (operation === "episode") {
	await fixture.episodes.preserve({ bodyId: BODY_ID, path: "Recovery.md", disk: readDisk(root),
		body: fixture.runtime.bodies.get(BODY_ID)!.doc.getText("body").toString(), device: "recovery-device" });
} else if (operation !== "project" && operation !== "recover" && operation !== "recover-authority-changed") throw new Error(`unknown operation ${operation}`);
const outcome = operation === "episode" ? "episode" : await fixture.reconcile();
const report = { outcome, pid: process.pid, counts: fixture.counts(), disk: readDisk(root),
	storedBody: decodeText(readState(root).documents[BODY_ID]!.encodedState), remote: readRemote(root), state: readState(root) };
writeFileSync(join(root, "report.json"), JSON.stringify(report));
await fixture.close();
process.stdout.write(`COMPLETE ${process.pid}\n`, () => process.exit(0));
