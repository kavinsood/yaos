import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { requireLiveIdentity } from "./liveIdentity.ts";
import { bootstrapFromSql, createBody } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const mode = process.env.YAOS_TEST_MODE ?? "seed";
if (mode !== "seed" && mode !== "validate") throw new Error(`YAOS_TEST_MODE must be seed or validate, got ${mode}`);
const bodyId = "body_redeploy_durability_0001";
const path = "redeploy-test.md";
const content = `YAOS schema-${SCHEMA_VERSION} SQL redeploy durability\nvault=${identity.vaultId}`;

if (mode === "seed") {
	await createBody(identity, bodyId, path, content);
	console.log("Seeded one schema-4 root/catalog/body durability entry.");
}

const cold = await bootstrapFromSql(identity);
try {
	const entry = cold.entries.find((candidate) => candidate.bodyId === bodyId);
	if (!entry || entry.path !== path || entry.lifecycle !== "active") {
		throw new Error(`SQL catalog omitted durability entry: ${JSON.stringify(entry)}`);
	}
	if (cold.root.getMap<string>("pathToId").get(path) !== bodyId) {
		throw new Error("SQL root bootstrap omitted durability path publication");
	}
	if (cold.bodies.get(bodyId)?.getText("body").toString() !== content) {
		throw new Error("SQL body bootstrap did not reproduce durable content");
	}
	console.log(`${mode}: cold SQL bootstrap reproduced schema-4 root, catalog, and body.`);
} finally {
	cold.root.destroy();
	for (const body of cold.bodies.values()) body.destroy();
}
