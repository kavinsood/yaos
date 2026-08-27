import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildManifest as buildManifestCore,
	classifyManifestPath,
	compareManifests,
} from "../../qa/manifest";
import { buildVaultManifest } from "../../qa/obsidian-harness/manifest-builder";
import { buildManifest as buildNodeManifest } from "../../qa/scripts/manifest";
import { suite } from "../harness.ts";

const s = suite("manifest-core");

s.section("Node and Obsidian adapters produce one comparable manifest");
{
	const root = await mkdtemp(join(tmpdir(), "yaos-manifest-"));
	try {
		await mkdir(join(root, "Notes"), { recursive: true });
		await mkdir(join(root, ".obsidian", "plugins", "yaos"), { recursive: true });
		await writeFile(join(root, "Notes", "café.md"), "hello", "utf8");
		await writeFile(join(root, "diagram.svg"), "<svg/>", "utf8");
		await writeFile(join(root, ".obsidian", "plugins", "yaos", "data.json"), "{}", "utf8");

		const nodeManifest = await buildNodeManifest(root);
		const encoder = new TextEncoder();
		const rendererFiles = [
			{ path: "Notes/cafe\u0301.md", content: "hello" },
			{ path: "diagram.svg", content: "<svg/>" },
			{ path: ".obsidian/plugins/yaos/data.json", content: "{}" },
		];
		const rendererManifest = await buildVaultManifest({
			vault: {
				getFiles: () => rendererFiles,
				readBinary: async (file: { content: string }) => encoder.encode(file.content).buffer,
			},
		} as never);

		const diff = compareManifests(nodeManifest, rendererManifest);
		s.check(diff.match, "filesystem and Obsidian adapters produce equal comparable bodies");
		s.check(nodeManifest.vaultPath === root, "vault path remains optional execution metadata");
		s.check(rendererManifest.vaultPath === undefined, "renderer manifest omits execution metadata");
		s.check(nodeManifest.fileCount === 2, "shared exclusion policy removes plugin internals");
		s.check(nodeManifest.files.find((entry) => entry.path === "diagram.svg")?.kind === "attachment", "shared classifier identifies attachments");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

s.section("Comparison canonicalizes paths and ignores metadata");
{
	const encoder = new TextEncoder();
	const left = await buildManifestCore([{ path: "./Folder\\note.md", bytes: encoder.encode("same") }], {
		generatedAt: "left",
		vaultPath: "/left",
	});
	const right = await buildManifestCore([{ path: "/Folder/note.md", bytes: encoder.encode("same") }], {
		generatedAt: "right",
		vaultPath: "/right",
	});
	s.check(compareManifests(left, right).match, "comparison ignores execution metadata and separator aliases");
	s.check(classifyManifestPath(".trash/deleted.md") === null, "shared policy excludes trash");
}

await s.done();
