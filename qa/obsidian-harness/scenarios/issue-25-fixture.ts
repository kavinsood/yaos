/**
 * Issue #25 shared fixture builder.
 *
 * Produces a realistic daily-note replica with:
 *   - Checkbox work list (editable section above the tasks blocks)
 *   - ~30k char filler to approximate the reporter's note size
 *   - Two structurally similar ```tasks blocks with shared anchors
 *     (```tasks, short mode, ```) — the exact anchor pattern that
 *     produced the 57-char Frankenstein chunk in the original report
 *   - A ```base block (present in the reporter's vault)
 *
 * Both S06a (forced-recovery) and S06b (natural) use this fixture.
 */

export const ISSUE_25_TASKS_ANCHOR_1 = "sort by priority";
export const ISSUE_25_TASKS_ANCHOR_2 = "sort by due";

export function buildIssue25Fixture(opts: { fillerLines?: number } = {}): string {
	const fillerLines = opts.fillerLines ?? 400; // ~400 lines ≈ 30k chars

	const header = [
		"# Daily Note",
		"",
		"## Work",
		"- [ ] morning review",
		"- [ ] send weekly update",
		"- [ ] ",
		"- [ ] review PRs",
		"- [ ] plan next sprint",
		"",
	].join("\n");

	// Filler to approximate 28–30k char note size from the report.
	const filler = Array.from({ length: fillerLines })
		.map((_, i) =>
			i % 10 === 0
				? `\n### Section ${Math.floor(i / 10) + 1}\n`
				: `- [ ] task ${i + 1} — lorem ipsum dolor sit amet consectetur adipiscing elit`,
		)
		.join("\n");

	// Two ```tasks blocks with shared anchors (```tasks, short mode, ```) —
	// exactly the pattern that caused the mis-aligned diff in the report.
	const focusBlock = [
		"## Today's Focus",
		"```tasks",
		"(scheduled on 2026-04-20) OR (due on 2026-04-20)",
		ISSUE_25_TASKS_ANCHOR_1,
		"short mode",
		"```",
		"",
	].join("\n");

	const overdueBlock = [
		"## Overdue",
		"```tasks",
		"not done",
		"(due before 2026-04-20) OR (scheduled before 2026-04-20)",
		ISSUE_25_TASKS_ANCHOR_2,
		"short mode",
		"```",
		"",
	].join("\n");

	// Base block — present in the reporter's vault alongside the tasks blocks.
	const baseBlock = [
		"## Base View",
		"```base",
		"filters:",
		'  - type: "task"',
		'  - status: "open"',
		"sort:",
		'  - field: "priority"',
		"```",
		"",
	].join("\n");

	return [header, filler, "", focusBlock, overdueBlock, baseBlock].join("\n");
}

/**
 * Generate a unique path for a scenario run.
 * Uses crypto.getRandomValues for uniqueness across parallel or repeated runs.
 */
export function issue25UniquePath(): string {
	const arr = new Uint32Array(2);
	crypto.getRandomValues(arr);
	const hex = Array.from(arr).map((n) => n.toString(16).padStart(8, "0")).join("");
	return `QA-issue-25/${hex}-daily.md`;
}
