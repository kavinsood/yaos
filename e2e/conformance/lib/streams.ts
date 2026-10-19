/** Stream HTTP helpers shared by tests. */
import type { Ctx } from "./context.ts";
import type { BinaryReadPage } from "./codec.ts";
import { brief, http } from "./http.ts";
import type { HttpOptions, HttpResult } from "./http.ts";

export type Row = BinaryReadPage["rows"][number];

/**
 * A single GET /streams/read: on 200 `value` is the one page of the binary reply (relay-wire §7.2) with the reply's
 * vaultEpoch and head; on an error it is the JSON error body.
 */
export async function readPage(ctx: Ctx, path: string, options: HttpOptions = {}): Promise<HttpResult> {
	const result = await http(ctx, "GET", path, options);
	const pages = result.value?.pages;
	if (result.status === 200 && Array.isArray(pages) && pages.length === 1) {
		result.value = { vaultEpoch: result.value.vaultEpoch, head: result.value.head, ...pages[0] };
	}
	return result;
}

/** Pages `read` to the end. Throws on a non-200 page. */
export async function readAll(ctx: Ctx, path: string, token: string, stream: string, after = 0, extra = ""):
	Promise<{ rows: Row[]; first: any; pages: number }> {
	const rows: Row[] = [];
	let cursor = after;
	let first: any = null;
	let pages = 0;
	for (; pages < 200; ) {
		const page = await readPage(ctx, `${path}/streams/read?stream=${encodeURIComponent(stream)}&after=${cursor}&maxBytes=4194304${extra}`,
			{ token });
		pages++;
		if (page.status !== 200) throw new Error(`read ${JSON.stringify(brief(page))}`);
		first ??= page.value;
		rows.push(...page.value.rows);
		if (page.value.nextAfter === null || page.value.nextAfter === undefined) break;
		cursor = page.value.nextAfter;
	}
	return { rows, first, pages };
}

export function checkpointPath(path: string, stream: string, coversSeq: number, expected: number, extra = ""): string {
	return `${path}/streams/checkpoint?stream=${encodeURIComponent(stream)}&coversSeq=${coversSeq}&expectedCoversSeq=${expected}${extra}`;
}
