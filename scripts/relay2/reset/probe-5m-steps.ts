/** Relay v2 spike probe: bisect the ywasm trap in the server's semantic reset on large bodies. */
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { loadFixture } from "./fixtures";
const { state } = loadFixture(process.argv[2] ?? "sized-5m");
const order = (process.argv[3] ?? "stats,encode,stats,stats").split(",");
const doc = crdtEngine.openDocument("p", state);
for (const step of order) {
	try {
		if (step === "stats") console.log(step, JSON.stringify(crdtEngine.documentStats(doc)));
		else if (step === "encode") console.log(step, crdtEngine.encodeStateAsUpdate(doc).byteLength);
		else if (step === "text") console.log(step, crdtEngine.readText(doc, "body").length);
		else if (step.startsWith("fresh")) {
			const size = Number(step.slice(5) || "5000000");
			const fresh = crdtEngine.createDocument(`f${Math.random()}`);
			crdtEngine.applyRootOperations(fresh, [{ kind: "text-replace", root: "body", value: "x".repeat(size) }], "probe");
			console.log(step, crdtEngine.documentStats(fresh).encodedStateBytes);
		} else if (step === "gc") { (globalThis as any).gc?.(); console.log("gc"); }
	} catch (e) { console.log(step, "TRAP", String(e).slice(0, 60)); }
}
