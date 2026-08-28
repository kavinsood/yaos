import { selectObsidianTarget } from "../../qa/controllers/obsidian-client.mjs";
import { suite } from "../harness.ts";

const s = suite("obsidian-client-target-selection");

s.test("prefers the live vault renderer over settings and worker targets", () => {
	const selected = selectObsidianTarget([
		{ type: "page", title: "Settings - vault - Obsidian", url: "about:blank", webSocketDebuggerUrl: "ws://settings" },
		{ type: "worker", title: "Metadata Cache Worker", url: "app://obsidian.md/worker.js", webSocketDebuggerUrl: "ws://worker" },
		{ type: "page", title: "New tab - vault - Obsidian", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://vault" },
	]);
	s.check(selected?.webSocketDebuggerUrl === "ws://vault", "vault renderer wins regardless of CDP target order");
});

s.test("rejects about:blank and worker-only target sets", () => {
	const selected = selectObsidianTarget([
		{ type: "page", title: "Settings - vault - Obsidian", url: "about:blank", webSocketDebuggerUrl: "ws://settings" },
		{ type: "worker", title: "Metadata Cache Worker", url: "app://obsidian.md/worker.js", webSocketDebuggerUrl: "ws://worker" },
	]);
	s.check(selected === null, "no non-renderer fallback is selected");
});

await s.done();
