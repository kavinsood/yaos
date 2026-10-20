// node:test reporter that names every failing test: each failure is printed the moment it is reported (so a run that
// is killed or whose output is cut still names it), and all of them again at the end. Used next to the dot
// reporter by scripts/client-test.mjs, which sends it to stderr.
import { inspect } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
const rel = (file) => (file?.startsWith("file://") ? new URL(file).pathname : (file ?? "?")).replace(ROOT, "");

function describeError(error) {
	const cause = error?.cause ?? error;
	const text = cause instanceof Error ? (cause.stack ?? String(cause)) : inspect(cause, { depth: 4 });
	return text.split("\n").slice(0, 12).join("\n");
}

export default async function* failuresReporter(source) {
	const failed = [];
	for await (const event of source) {
		if (event.type !== "test:fail") continue;
		const { data } = event;
		// A suite or test that failed only because a subtest did: the subtest is reported on its own.
		if (data.details?.error?.failureType === "subtestsFailed") continue;
		const line = `${rel(data.file)} > ${data.name}`;
		const detail = describeError(data.details?.error);
		failed.push({ line, detail });
		yield `\nFAIL ${line}\n${detail.replace(/^/gm, "    ")}\n`;
	}
	if (failed.length > 0) yield `\n${failed.length} failing test${failed.length === 1 ? "" : "s"}:\n${failed.map((f) => `  ${f.line}`).join("\n")}\n`;
}
