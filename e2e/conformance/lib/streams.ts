/** Stream HTTP helpers shared by tests. */
import type { Ctx } from "./context.ts";
import { brief, http } from "./http.ts";

export interface Row { seq: number; deviceId: string; clientFrameId: string; payload: string }

/** Pages `read` to the end. Throws on a non-200 page. */
export async function readAll(ctx: Ctx, path: string, token: string, stream: string, after = 0, extra = ""):
	Promise<{ rows: Row[]; first: any; pages: number }> {
	const rows: Row[] = [];
	let cursor = after;
	let first: any = null;
	let pages = 0;
	for (; pages < 200; ) {
		const page = await http(ctx, "GET", `${path}/streams/read?stream=${encodeURIComponent(stream)}&after=${cursor}&maxBytes=4194304${extra}`,
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
