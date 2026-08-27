import { MarkdownView, type TFile, type Workspace } from "obsidian";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("editor-binding-health-regressions");

s.section("Test 1: active-view checks use the public Workspace API");
{
	let activeView: MarkdownView | null = null;
	let requestedViewType: unknown = null;
	const workspace = partialOf<Workspace>({
		getActiveViewOfType: ((viewType: unknown) => {
			requestedViewType = viewType;
			return activeView;
		}) as Workspace["getActiveViewOfType"],
	});
	const manager = new EditorBindingManager(
		partialOf<VaultSync>({}),
		workspace,
		false,
	);
	const active = partialOf<MarkdownView>({
		file: partialOf<TFile>({ path: "active.md" }),
	});
	const inactive = partialOf<MarkdownView>({
		file: partialOf<TFile>({ path: "inactive.md" }),
	});
	const detached = partialOf<MarkdownView>({ file: null });

	activeView = active;
	s.check(
		manager["isAuditActionable"](active, ["missing-file"]),
		"active view remains actionable for otherwise deferrable health issues",
	);
	s.check(
		requestedViewType === MarkdownView,
		"active-view lookup requests the public MarkdownView type",
	);
	s.check(
		!manager["isAuditActionable"](inactive, ["missing-file", "missing-collab-info"]),
		"inactive view defers non-actionable health issues",
	);
	s.check(
		manager["isAuditActionable"](inactive, ["missing-sync-facet"]),
		"inactive view still repairs substantive health issues",
	);
	s.check(
		!manager["isAuditActionable"](detached, ["missing-sync-facet"]),
		"detached view is never actionable",
	);
}

await s.done();
