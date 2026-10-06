/** Shared run context handed to every test. Holds secrets only in memory (never serialized). */
import type { StreamSocket } from "./socket.ts";

export interface EnrollRecord { vaultKey: string; device: string; firstStatus: number; statuses: number[]; ok: boolean;
	bodyOk: boolean }

export interface Ctx {
	host: string;
	wsHost: string;
	label: string;
	stamp: string;
	operatorContextPath: string | undefined;
	skipSlow: boolean;
	/** Every secret seen this run (operator key, cookie, device tokens, tickets, pairing codes); scrubbed from output. */
	secrets: Set<string>;
	memo: Map<string, Promise<unknown>>;
	enrollLog: EnrollRecord[];
	capabilities: Record<string, unknown> | null;
	/** Sockets opened by the current test; closed after it finishes. */
	openSockets: Set<StreamSocket>;
	vaultSummaries: { key: string; vaultIdPrefix: string; devices: string[] }[];
}

export function secret(ctx: Ctx, value: string | null | undefined): void {
	if (typeof value === "string" && value.length >= 6) {
		ctx.secrets.add(value);
		ctx.secrets.add(encodeURIComponent(value));
	}
}

export function memo<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
	let value = ctx.memo.get(key) as Promise<T> | undefined;
	if (!value) {
		value = fn();
		ctx.memo.set(key, value);
		value.catch(() => ctx.memo.delete(key));
	}
	return value;
}

/** Replaces every registered secret in `text`. */
export function scrub(ctx: Ctx, text: string): string {
	let out = text;
	for (const value of [...ctx.secrets].sort((a, b) => b.length - a.length)) {
		if (out.includes(value)) out = out.split(value).join("<redacted>");
	}
	return out;
}
