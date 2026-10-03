/**
 * b3-m-typing: list the recovery state objects of one vault in R2 (CF REST API, wrangler OAuth token, never printed).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/b3/r2list.ts --vault <vaultId> --generation <gen>
 *        [--bucket yaos-relay2-idle] [--hashes h1,h2] [--out file.json]
 *
 * Key layout (design-projection.md): vault/<vaultId>/<gen>/recovery-v2/state/sha256/<h2>/<hash>.ystate
 */
import { writeFileSync } from "node:fs";
import { token } from "../gql";
import { flagStr, parseArgs } from "../lib/common";

async function main() {
	const args = parseArgs();
	const acct = process.env.CLOUDFLARE_ACCOUNT_ID!;
	const bucket = flagStr(args, "bucket", "yaos-relay2-idle")!;
	const prefix = `vault/${encodeURIComponent(flagStr(args, "vault")!)}/${encodeURIComponent(flagStr(args, "generation")!)}/recovery-v2/`;
	const tok = token();
	const objects: Array<{ key: string; size: number; uploaded: string }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 50; page++) {
		const qs = new URLSearchParams({ prefix, per_page: "1000", ...(cursor ? { cursor } : {}) });
		const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets/${bucket}/objects?${qs}`, { headers: { authorization: `Bearer ${tok}` } });
		const v = await r.json() as { success?: boolean; result?: Array<{ key: string; size: number; last_modified?: string; uploaded?: string }>; result_info?: { cursor?: string; is_truncated?: boolean }; errors?: unknown };
		if (!r.ok || v.success === false) { console.error(`r2 list ${r.status} ${JSON.stringify(v.errors).slice(0, 200)}`); process.exit(1); }
		for (const o of v.result ?? []) objects.push({ key: o.key.slice(prefix.length), size: o.size, uploaded: o.last_modified ?? o.uploaded ?? "" });
		cursor = v.result_info?.cursor;
		if (!v.result_info?.is_truncated || !cursor) break;
	}
	const hashes = (flagStr(args, "hashes") ?? "").split(",").filter(Boolean);
	const found = Object.fromEntries(hashes.map((h) => { const o = objects.find((x) => x.key.endsWith(`/${h}.ystate`)); return [h, o ? { size: o.size, uploaded: o.uploaded } : null]; }));
	const state = objects.filter((o) => o.key.startsWith("state/"));
	console.log(`objects=${objects.length} state=${state.length}${hashes.length ? ` hashesFound=${Object.values(found).filter(Boolean).length}/${hashes.length}` : ""}`);
	const file = flagStr(args, "out");
	if (file) writeFileSync(file, JSON.stringify({ bucket, prefixPattern: "vault/<vaultId>/<gen>/recovery-v2/", listedAt: new Date().toISOString(), count: objects.length, found, objects }, null, 1) + "\n");
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
