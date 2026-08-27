import { strict as assert } from "node:assert";
import {
	FreshBodyAdmissionLocalVaultImportSink,
	type FreshBodyAdmissionPort,
} from "../../src/onboarding/obsidianLocalVaultImport";
import type { LocalVaultImportSinkInput } from "../../src/onboarding/localVaultImport";
import { suite } from "../harness.ts";

const s = suite("local-vault-import-adapter");

function input(path: string, bodyId: string): LocalVaultImportSinkInput {
	return {
		path,
		bodyId,
		content: `content:${path}`,
		candidateId: `candidate:${bodyId}`,
		contentHash: "a".repeat(64),
	};
}

s.test("host adapter routes existing notes individually and fresh notes through bulk admission", async () => {
	const individual: Array<{ bodyId: string; path: string; lifecycle?: "create" }> = [];
	const freshBatches: Array<readonly { bodyId: string; path: string }[]> = [];
	const port: FreshBodyAdmissionPort = {
		getFileId: (path) => path === "existing.md" ? "active-body" : undefined,
		commitDiskBody: async (value) => { individual.push(value); },
		commitFreshBodies: async (values) => {
			freshBatches.push(values);
			return { results: values.map((value) => ({ bodyId: value.bodyId })) };
		},
	};
	const scheduled: string[][] = [];
	const sink = new FreshBodyAdmissionLocalVaultImportSink(
		() => port,
		async (paths, work) => {
			scheduled.push([...paths]);
			await work();
		},
	);
	const results = await sink.importFiles([
		input("existing.md", "unused-fresh-id"),
		input("fresh-a.md", "fresh-a"),
		input("fresh-b.md", "fresh-b"),
	]);

	assert.deepEqual(results, [
		{ bodyId: "active-body" },
		{ bodyId: "fresh-a" },
		{ bodyId: "fresh-b" },
	]);
	assert.deepEqual(scheduled, [["existing.md", "fresh-a.md", "fresh-b.md"]]);
	assert.deepEqual(individual.map(({ bodyId, path, lifecycle }) => ({ bodyId, path, lifecycle })), [
		{ bodyId: "active-body", path: "existing.md", lifecycle: undefined },
	]);
	assert.deepEqual(freshBatches.map((batch) => batch.map(({ bodyId, path }) => ({ bodyId, path }))), [[
		{ bodyId: "fresh-a", path: "fresh-a.md" },
		{ bodyId: "fresh-b", path: "fresh-b.md" },
	]]);
});

await s.done();
