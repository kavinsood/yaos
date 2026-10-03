// Summarise a `wrangler tail --format json` capture (concatenated pretty JSON objects):
// outcome counts, non-ok events (time, kind, url), exceptions, close codes seen in logs.
// usage: node scripts/b3ckpt/tailsum.mjs <tail.jsonl> [--all]
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const events = [];
let depth = 0, start = -1, inString = false, escape = false;
for (let i = 0; i < text.length; i++) {
	const c = text[i];
	if (inString) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') inString = false; continue; }
	if (c === '"') inString = true;
	else if (c === "{") { if (depth++ === 0) start = i; }
	else if (c === "}" && --depth === 0) { try { events.push(JSON.parse(text.slice(start, i + 1))); } catch {} }
}
const counts = {};
const odd = [];
let exceptions = 0;
const closeCodes = {};
for (const e of events) {
	counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
	exceptions += e.exceptions?.length ?? 0;
	for (const l of e.logs ?? []) for (const m of l.message ?? []) {
		const s = typeof m === "string" ? m : JSON.stringify(m);
		for (const hit of s.matchAll(/\bclose[^0-9]{0,20}(10\d\d|4\d\d\d)\b/gi)) closeCodes[hit[1]] = (closeCodes[hit[1]] ?? 0) + 1;
	}
	if (e.outcome !== "ok" || e.exceptions?.length || process.argv.includes("--all")) {
		const ev = e.event ?? {};
		odd.push({ t: new Date(e.eventTimestamp).toISOString().slice(11, 19), outcome: e.outcome,
			kind: ev.request ? `${ev.request.method} ${new URL(ev.request.url).pathname.replace(/[0-9a-f-]{20,}/g, "*")}` : Object.keys(ev).join(",") || e.eventType,
			exc: e.exceptions?.map((x) => `${x.name}: ${String(x.message).slice(0, 80)}`) });
	}
}
const ts = events.map((e) => e.eventTimestamp).filter(Boolean);
console.log(JSON.stringify({ events: events.length, from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString(),
	counts, exceptions, closeCodes, nonOk: odd.slice(0, 20) }, null, 1));
