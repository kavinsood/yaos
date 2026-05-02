import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

const vaultRoot = process.argv[2] ?? "/home/kavin/garden";
const rounds = Math.max(40, Number.parseInt(process.argv[3] ?? "120", 10));
const maxFileBytes = Math.max(256 * 1024, Number.parseInt(process.argv[4] ?? `${2 * 1024 * 1024}`, 10));
const profile = (process.argv[5] ?? "all").trim();
const writeMode = (process.argv[6] ?? "atomic").trim().toLowerCase();
const qaDir = path.join(vaultRoot, "yaos", "qa-stress");
const reportPath = path.join(
	"/tmp",
	`yaos-stress-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);

const ICONS = ["🔺", "🔹", "🔸", "🔻"];
const ICON_BURST_LIMIT = 24;
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const filePaths = {
	frontmatter: path.join(qaDir, "frontmatter-edge.md"),
	inline: path.join(qaDir, "inline-task-edge.md"),
	mixed: path.join(qaDir, "mixed-edge.md"),
	crlf: path.join(qaDir, "crlf-edge.md"),
};

const stats = {
	startedAt: new Date().toISOString(),
	vaultRoot,
	qaDir,
	rounds,
	profile,
	writeMode,
	ops: {
		frontmatter: 0,
		inlineIcons: 0,
		inlineAdjacent: 0,
		mixed: 0,
		crlf: 0,
	},
	errors: [],
};

let stopReason = null;

const profileFlags = {
	inlineOnly: profile === "inline-only",
	noTypeFlip: profile === "inline-only" || profile === "stable-frontmatter",
	singleInlineWriter: profile === "inline-single-writer",
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function maybeStop(workerName, reason) {
	if (stopReason) return;
	stopReason = `${workerName}: ${reason}`;
	stats.errors.push(stopReason);
}

function longestIconRun(content) {
	let longest = 0;
	for (const pattern of [/🔺+/gu, /🔹+/gu, /🔸+/gu, /🔻+/gu]) {
		const matches = content.match(pattern) ?? [];
		for (const token of matches) longest = Math.max(longest, Array.from(token).length);
	}
	return longest;
}

function guardContentHealth(workerName, filePath, content) {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > maxFileBytes) {
		maybeStop(workerName, `file growth breach (${path.basename(filePath)}=${bytes} bytes, limit=${maxFileBytes})`);
		return false;
	}
	const iconRun = longestIconRun(content);
	if (iconRun > ICON_BURST_LIMIT) {
		maybeStop(workerName, `icon burst breach (${path.basename(filePath)} run=${iconRun}, limit=${ICON_BURST_LIMIT})`);
		return false;
	}
	return true;
}

async function readText(filePath) {
	return fs.readFile(filePath, "utf8");
}

async function writeText(filePath, content) {
	if (writeMode === "direct") {
		await fs.writeFile(filePath, content, "utf8");
		return;
	}
	const dir = path.dirname(filePath);
	const tmpPath = path.join(
		dir,
		`.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await fs.writeFile(tmpPath, content, "utf8");
	await fs.rename(tmpPath, filePath);
}

function extractFrontmatter(content) {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return null;
	const lines = normalized.split("\n");
	let endLine = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i] === "---" || lines[i] === "...") {
			endLine = i;
			break;
		}
	}
	if (endLine < 0) return null;
	const frontmatterText = lines.slice(1, endLine).join("\n");
	const bodyText = lines.slice(endLine + 1).join("\n");
	return { frontmatterText, bodyText };
}

function renderFrontmatterBody(frontmatterObject, bodyText, { duplicateTaskSource = false } = {}) {
	const lines = ["---"];
	lines.push(`title: ${frontmatterObject.title}`);
	lines.push("tags:");
	for (const tag of frontmatterObject.tags ?? []) lines.push(`  - ${tag}`);
	lines.push("aliases:");
	for (const alias of frontmatterObject.aliases ?? []) lines.push(`  - ${alias}`);
	lines.push(`timeEstimate: ${frontmatterObject.timeEstimate}`);
	lines.push(`taskSourceType: ${frontmatterObject.taskSourceType}`);
	if (duplicateTaskSource) {
		lines.push(`taskSourceType: ${frontmatterObject.taskSourceType}`);
	}
	if (Array.isArray(frontmatterObject.complete_instances)) {
		lines.push("complete_instances:");
		for (const item of frontmatterObject.complete_instances) {
			lines.push(`  - ${item}`);
		}
	}
	lines.push("---");
	return `${lines.join("\n")}\n${bodyText}`;
}

function seedFrontmatter() {
	const fmObject = {
		title: "QA Frontmatter Edge",
		tags: ["qa", "sync", "frontmatter"],
		aliases: ["qa-frontmatter-edge"],
		timeEstimate: 25,
		taskSourceType: "tasks",
		complete_instances: [yesterday, today],
	};
	const body = [
		"# QA Frontmatter Edge",
		"",
		"- this note is intentionally mutated by stress script",
		"",
		"body-control: baseline",
		"",
	].join("\n");
	return renderFrontmatterBody(fmObject, body);
}

function seedInline() {
	return [
		"---",
		"title: QA Inline Task Edge",
		"tags:",
		"  - qa",
		"  - inline",
		"---",
		"# QA Inline Task Edge",
		"",
		"- [ ] 🔺 task alpha",
		"adjacent-control: alpha-0",
		"- [ ] 🔹 task beta",
		"adjacent-control: beta-0",
		"",
		"## Heading Zone",
		"inline-control: 0",
		"",
	].join("\n");
}

function seedMixed() {
	return [
		"---",
		"title: QA Mixed Edge",
		"tags:",
		"  - qa",
		"  - mixed",
		"timeEstimate: 30",
		"taskSourceType: tasks",
		"---",
		"# QA Mixed Edge",
		"",
		"## Sweep 0",
		"- [ ] 🔺 mix task",
		"adjacent-control: mix-0",
		"",
		"### Nested 0",
		"body-control: baseline",
		"",
	].join("\n");
}

function seedCrlf() {
	const unix = [
		"---",
		"title: QA CRLF Edge",
		"tags:",
		"  - qa",
		"  - crlf",
		"timeEstimate: 10",
		"taskSourceType: tasks",
		"---",
		"# QA CRLF Edge",
		"",
		"- [ ] 🔸 crlf task",
		"adjacent-control: crlf-0",
		"",
	].join("\n");
	return unix.replace(/\n/g, "\r\n");
}

async function ensureQaNotes() {
	await fs.mkdir(qaDir, { recursive: true });
	await writeText(filePaths.frontmatter, seedFrontmatter());
	await writeText(filePaths.inline, seedInline());
	await writeText(filePaths.mixed, seedMixed());
	await writeText(filePaths.crlf, seedCrlf());
}

function parseFrontmatterLoose(content) {
	const block = extractFrontmatter(content);
	if (!block) {
		return { parsed: null, error: "missing-frontmatter", block };
	}
	try {
		return { parsed: yaml.load(block.frontmatterText) ?? {}, error: null, block };
	} catch (error) {
		return {
			parsed: null,
			error: error instanceof Error ? error.message : String(error),
			block,
		};
	}
}

function countDuplicateTopLevelKeys(frontmatterText) {
	const counts = new Map();
	for (const raw of frontmatterText.split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#") || /^\s/.test(raw)) continue;
		const match = /^([A-Za-z0-9_-][A-Za-z0-9_-]*)\s*:/.exec(trimmed);
		if (!match) continue;
		const key = match[1];
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
}

async function frontmatterWorker() {
	if (profileFlags.inlineOnly) return;
	for (let i = 0; i < rounds; i += 1) {
		if (stopReason) break;
		try {
			const content = await readText(filePaths.frontmatter);
			if (!guardContentHealth("frontmatterWorker", filePaths.frontmatter, content)) break;
			const { parsed, block } = parseFrontmatterLoose(content);
			const bodyText = block?.bodyText ?? "body-control: regenerated\n";
			const current = parsed && typeof parsed === "object" ? parsed : {};
			const completeInstances = Array.isArray(current.complete_instances)
				? [...current.complete_instances]
				: [yesterday, today];
			if (i % 2 === 0 && completeInstances.length > 0) completeInstances.pop();
			if (i % 2 === 1) completeInstances.push(today);
			const next = {
				title: typeof current.title === "string" ? current.title : "QA Frontmatter Edge",
				tags: Array.isArray(current.tags) ? current.tags.slice(0, 4) : ["qa", "sync", "frontmatter"],
				aliases: Array.isArray(current.aliases) ? current.aliases.slice(0, 3) : ["qa-frontmatter-edge"],
				timeEstimate: i % 3 === 0 ? 20 + (i % 11) : 25 + (i % 7),
				taskSourceType: "tasks",
				complete_instances: completeInstances,
			};
			const injectDuplicate = !profileFlags.noTypeFlip && i % 12 === 6;
			await writeText(
				filePaths.frontmatter,
				renderFrontmatterBody(next, bodyText, { duplicateTaskSource: injectDuplicate }),
			);
			stats.ops.frontmatter += 1;
		} catch (error) {
			stats.errors.push(`frontmatterWorker: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(randInt(20, 70));
	}
}

async function inlineIconWorker() {
	for (let i = 0; i < rounds * 2; i += 1) {
		if (stopReason) break;
		try {
			const content = await readText(filePaths.inline);
			if (!guardContentHealth("inlineIconWorker", filePaths.inline, content)) break;
			const lines = content.split("\n");
			const taskIndexes = [];
			for (let idx = 0; idx < lines.length; idx += 1) {
				if (/^- \[[ xX]\]\s/.test(lines[idx])) taskIndexes.push(idx);
			}
			if (taskIndexes.length > 0) {
				const target = taskIndexes[i % taskIndexes.length];
				const nextIcon = ICONS[i % ICONS.length];
				lines[target] = lines[target].replace(/(🔺|🔹|🔸|🔻)/gu, nextIcon);
			}
			const markerIdx = lines.findIndex((line) => line.startsWith("inline-control:"));
			if (markerIdx >= 0) {
				lines[markerIdx] = `inline-control: ${i}`;
			}
			await writeText(filePaths.inline, lines.join("\n"));
			stats.ops.inlineIcons += 1;
		} catch (error) {
			stats.errors.push(`inlineIconWorker: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(randInt(18, 52));
	}
}

async function inlineAdjacentWorker() {
	for (let i = 0; i < rounds * 2; i += 1) {
		if (stopReason) break;
		try {
			const base = await readText(filePaths.inline);
			if (!guardContentHealth("inlineAdjacentWorker", filePaths.inline, base)) break;
			await sleep(randInt(5, 28));
			const lines = base.split("\n");
			for (let idx = 0; idx < lines.length; idx += 1) {
				if (lines[idx].startsWith("adjacent-control: alpha")) {
					lines[idx] = `adjacent-control: alpha-${i}`;
				}
				if (lines[idx].startsWith("adjacent-control: beta")) {
					lines[idx] = `adjacent-control: beta-${i}`;
				}
			}
			await writeText(filePaths.inline, lines.join("\n"));
			stats.ops.inlineAdjacent += 1;
		} catch (error) {
			stats.errors.push(`inlineAdjacentWorker: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(randInt(24, 60));
	}
}

async function mixedWorker() {
	if (profileFlags.inlineOnly) return;
	for (let i = 0; i < rounds; i += 1) {
		if (stopReason) break;
		try {
			const content = await readText(filePaths.mixed);
			if (!guardContentHealth("mixedWorker", filePaths.mixed, content)) break;
			const parsed = parseFrontmatterLoose(content);
			const fm = parsed.parsed && typeof parsed.parsed === "object" ? parsed.parsed : {};
			const body = parsed.block?.bodyText ?? "# QA Mixed Edge\n";
			const bodyLines = body.split("\n");
			const headingIdx = bodyLines.findIndex((line) => line.startsWith("## Sweep"));
			if (headingIdx >= 0) bodyLines[headingIdx] = `## Sweep ${i}`;
			const nestedIdx = bodyLines.findIndex((line) => line.startsWith("### Nested"));
			if (nestedIdx >= 0) bodyLines[nestedIdx] = `### Nested ${i % 9}`;
			const bodyControlIdx = bodyLines.findIndex((line) => line.startsWith("body-control:"));
			if (bodyControlIdx >= 0) bodyLines[bodyControlIdx] = `body-control: mixed-${i}`;
			const next = {
				title: typeof fm.title === "string" ? fm.title : "QA Mixed Edge",
				tags: Array.isArray(fm.tags) ? fm.tags : ["qa", "mixed"],
				timeEstimate:
					!profileFlags.noTypeFlip && i % 10 === 0 ? [30, 35] : 20 + (i % 30),
				taskSourceType: "tasks",
			};
			const lines = ["---"];
			lines.push(`title: ${next.title}`);
			lines.push("tags:");
			for (const tag of next.tags) lines.push(`  - ${tag}`);
			if (Array.isArray(next.timeEstimate)) {
				lines.push("timeEstimate:");
				for (const val of next.timeEstimate) lines.push(`  - ${val}`);
			} else {
				lines.push(`timeEstimate: ${next.timeEstimate}`);
			}
			lines.push(`taskSourceType: ${next.taskSourceType}`);
			lines.push("---");
			await writeText(filePaths.mixed, `${lines.join("\n")}\n${bodyLines.join("\n")}`);
			stats.ops.mixed += 1;
		} catch (error) {
			stats.errors.push(`mixedWorker: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(randInt(20, 75));
	}
}

async function crlfWorker() {
	for (let i = 0; i < rounds; i += 1) {
		if (stopReason) break;
		try {
			const content = await readText(filePaths.crlf);
			if (!guardContentHealth("crlfWorker", filePaths.crlf, content)) break;
			const unix = content.replace(/\r\n/g, "\n");
			const parsed = parseFrontmatterLoose(unix);
			const fm = parsed.parsed && typeof parsed.parsed === "object" ? parsed.parsed : {};
			const body = (parsed.block?.bodyText ?? "").split("\n").map((line) => {
				if (line.startsWith("adjacent-control:")) return `adjacent-control: crlf-${i}`;
				return line;
			}).join("\n");
			const lines = ["---"];
			lines.push(`title: ${typeof fm.title === "string" ? fm.title : "QA CRLF Edge"}`);
			lines.push("tags:");
			for (const tag of Array.isArray(fm.tags) ? fm.tags : ["qa", "crlf"]) lines.push(`  - ${tag}`);
			lines.push(`timeEstimate: ${20 + (i % 5)}`);
			lines.push("taskSourceType: tasks");
			lines.push("---");
			const renderedUnix = `${lines.join("\n")}\n${body}`;
			await writeText(filePaths.crlf, renderedUnix.replace(/\n/g, "\r\n"));
			stats.ops.crlf += 1;
		} catch (error) {
			stats.errors.push(`crlfWorker: ${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(randInt(22, 68));
	}
}

function analyzeInline(content) {
	const lines = content.split(/\r?\n/);
	let mergedAdjacentIntoTaskLine = false;
	for (const line of lines) {
		if (/^- \[[ xX]\].*adjacent-control:/.test(line)) {
			mergedAdjacentIntoTaskLine = true;
			break;
		}
	}
	const iconBurst = /(🔺){2,}|(🔹){2,}|(🔸){2,}|(🔻){2,}/u.test(content);
	const adjacentLineCount = lines.filter((line) => line.startsWith("adjacent-control:")).length;
	return { mergedAdjacentIntoTaskLine, iconBurst, adjacentLineCount };
}

async function analyzeFile(filePath) {
	const content = await readText(filePath);
	const fm = extractFrontmatter(content.replace(/\r\n/g, "\n"));
	const duplicateKeys = fm ? countDuplicateTopLevelKeys(fm.frontmatterText) : [];
	let yamlError = null;
	if (fm) {
		try {
			yaml.load(fm.frontmatterText);
		} catch (error) {
			yamlError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		path: filePath,
		bytes: Buffer.byteLength(content, "utf8"),
		hasFrontmatter: !!fm,
		duplicateKeys,
		yamlError,
		inlineSignals: analyzeInline(content),
	};
}

async function readQuarantineState() {
	const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "yaos", "data.json");
	try {
		const raw = await readText(pluginDataPath);
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed?._frontmatterQuarantine) ? parsed._frontmatterQuarantine : [];
		const reasonCounts = new Map();
		for (const entry of entries) {
			if (!Array.isArray(entry?.reasons)) continue;
			for (const reason of entry.reasons) {
				reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
			}
		}
		return {
			entryCount: entries.length,
			topReasons: [...reasonCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([reason, count]) => ({ reason, count })),
		};
	} catch (error) {
		return {
			entryCount: null,
			topReasons: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function main() {
	console.log(`[stress] vault root: ${vaultRoot}`);
	console.log(`[stress] qa dir: ${qaDir}`);
	console.log(`[stress] rounds: ${rounds}`);
	console.log(`[stress] profile: ${profile}`);
	console.log(`[stress] write mode: ${writeMode}`);
	await ensureQaNotes();
	console.log("[stress] created qa notes");

	const jobs = [frontmatterWorker(), inlineIconWorker(), mixedWorker(), crlfWorker()];
	if (!profileFlags.singleInlineWriter) {
		jobs.push(inlineAdjacentWorker());
	}
	await Promise.all(jobs);

	const analyses = {
		frontmatter: await analyzeFile(filePaths.frontmatter),
		inline: await analyzeFile(filePaths.inline),
		mixed: await analyzeFile(filePaths.mixed),
		crlf: await analyzeFile(filePaths.crlf),
	};
	const quarantine = await readQuarantineState();

	const report = {
		...stats,
		finishedAt: new Date().toISOString(),
		stopReason,
		maxFileBytes,
		files: filePaths,
		analyses,
		quarantine,
	};
	await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

	console.log("[stress] done");
	console.log(`[stress] report: ${reportPath}`);
	console.log(`[stress] ops: ${JSON.stringify(stats.ops)}`);
	console.log(`[stress] errors: ${stats.errors.length}`);
	if (stopReason) console.log(`[stress] stopped early: ${stopReason}`);
	console.log(`[stress] quarantine entries: ${quarantine.entryCount}`);
}

await main();
