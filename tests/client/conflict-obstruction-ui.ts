import { strict as assert } from "node:assert";
import type { App } from "obsidian";
import { ConflictListModal } from "../../src/ui/ConflictListModal";
import type { ConflictEpisode } from "../../src/sync/conflictEpisodes";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const tests = suite("conflict-obstruction-ui");

interface FakeElement {
	createDiv(): FakeElement;
	createEl(tag: string, options: { text: string }): FakeElement;
	addEventListener(): undefined;
	empty(): undefined;
}

tests.test("explicit review shows managed recovery parts and untouched obstruction paths", () => {
	const texts: string[] = [];
	const element: FakeElement = {
		createDiv: () => element,
		createEl: (_tag: string, options: { text: string }) => {
			texts.push(options.text);
			return element;
		},
		addEventListener: () => undefined,
		empty: () => undefined,
	};
	const episode: ConflictEpisode = {
		bodyId: "body", id: "episode", path: "Note.md", epoch: 1,
		parts: ["Note (YAOS conflict relocation episode part 1 1).md"],
		versions: [], latestDiskHash: "hash", baseHash: null, notified: true,
		error: null, obstructions: ["Note (YAOS conflict).md"],
		relocations: { "Note (YAOS conflict).md": "Note (YAOS conflict relocation episode part 1 1).md" },
	};
	const modal = new ConflictListModal(partialOf<App>({}), [episode], () => undefined);
	Object.defineProperty(modal, "titleEl", { value: { setText: (text: string) => texts.push(text) } });
	Object.defineProperty(modal, "contentEl", { value: element });
	modal.onOpen();
	assert.ok(texts.includes(episode.parts[0]!));
	assert.ok(texts.includes("Left untouched during artifact recovery: Note (YAOS conflict).md"));
	assert.ok(texts.some((text) => text.includes("Recovered artifact: Note (YAOS conflict).md → Note (YAOS conflict relocation episode part 1 1).md")));
	assert.equal(episode.error, null);
});

await tests.done();
