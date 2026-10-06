/** Minimal HTTP helper (global fetch). Never logs headers or bodies. */
import type { Ctx } from "./context.ts";
import { now, round } from "./util.ts";

export interface HttpResult { status: number; value: any; headers: Headers; ms: number }

export interface HttpOptions {
	token?: string;
	cookie?: string;
	json?: unknown;
	body?: Uint8Array;
	timeoutMs?: number;
}

export async function http(ctx: Ctx, method: string, path: string, options: HttpOptions = {}): Promise<HttpResult> {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.cookie) headers.Cookie = options.cookie;
	// D5: operator writes and /claim need a same-origin Origin. A browser sends it on every non-GET fetch; Node's
	// fetch never does, so the console's request is reproduced here.
	if ((options.cookie || path === "/claim") && method !== "GET") headers.Origin = new URL(ctx.host).origin;
	let body: BodyInit | undefined;
	if (options.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.json); }
	if (options.body) { headers["Content-Type"] = "application/octet-stream"; body = options.body; }
	const t0 = now();
	const response = await fetch(`${ctx.host}${path}`, { method, headers, body, redirect: "manual",
		signal: AbortSignal.timeout(options.timeoutMs ?? 60000) });
	const text = await response.text();
	let value: any = null;
	try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text.slice(0, 120) }; }
	return { status: response.status, value, headers: response.headers, ms: round(now() - t0) };
}

/** Secret-free digest of a response for result files. */
export function brief(result: HttpResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const error = result.value && typeof result.value === "object" ? result.value.error : undefined;
	return { status: result.status, ...(error !== undefined ? { error } : {}), ms: result.ms, ...extra };
}

/** A Worker-level 404 (no route): today's body is {"error":"not found"}. */
export function isRouteMissing(result: HttpResult): boolean {
	return result.status === 404 && (result.value?.error === "not found" || result.value === null);
}

export function vaultPath(vaultId: string): string { return `/vault/${encodeURIComponent(vaultId)}`; }
