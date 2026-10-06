/**
 * exportDiagnostics bundle (DESIGN §j.7). Every stream and path in the engine's diagnostics is
 * replaced by a pseudonym under a fresh random salt; the pseudonym -> path table is added only when
 * the user opted in. DiagnosticsBundle (src/protocol/status.ts) documents each field.
 */

import { newId } from "../../core/codec/ids";
import { bytesToHex, utf8Encode } from "../../core/codec/lib0";
import { streamClass, streamDocId, type DocId, type StreamName, type VaultPath } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import type { DiagnosticsBundle, DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";

export const PSEUDONYM_HEX_CHARS = 12;
export const DIAGNOSTICS_QUARANTINE_MAX = 200;

/** What the runtime collects; streams and paths are still real here. */
export interface DiagnosticsInput {
	readonly generatedAtMs: number;
	readonly clientVersion: string;
	readonly status: StatusSnapshot;
	readonly events: readonly DiagnosticsEvent[];
	readonly quarantine: readonly { readonly stream: string; readonly seq: number; readonly reason: string; readonly bytes: number }[];
	readonly frozen: readonly { readonly stream: string; readonly reason: string }[];
	readonly stores: DiagnosticsBundle["stores"];
	/** The vault path of a doc, when known. */
	pathOf(docId: DocId): VaultPath | null;
}

export async function buildDiagnosticsBundle(
	input: DiagnosticsInput,
	ports: { readonly random: RandomPort; readonly hash: HashPort },
	includePaths: boolean,
): Promise<DiagnosticsBundle> {
	const salt = newId(ports.random);
	const memo = new Map<string, string>();
	const known = new Map<string, VaultPath>();
	const pseudonym = async (key: string, path: VaultPath | null): Promise<string> => {
		let p = memo.get(key);
		if (p === undefined) {
			p = bytesToHex(await ports.hash.sha256(utf8Encode(`${salt}\u0000${key}`))).slice(0, PSEUDONYM_HEX_CHARS);
			memo.set(key, p);
		}
		if (path !== null) known.set(p, path);
		return p;
	};
	// "p:" and "s:" keep a path and a stream with the same spelling apart.
	const ofPath = (path: VaultPath): Promise<string> => pseudonym(`p:${path}`, path);
	const ofStream = async (stream: string): Promise<string> => {
		const s = stream as StreamName;
		const cls = streamClass(s);
		if (cls === "ns" || cls === "cfg") return stream;
		const docId = streamDocId(s);
		const path = docId ? input.pathOf(docId) : null;
		const p = path !== null ? await ofPath(path) : await pseudonym(`s:${stream}`, null);
		return cls === "other" ? p : `${stream.slice(0, 2)}${p}`;
	};

	const recentEvents: DiagnosticsEvent[] = [];
	for (const ev of input.events) {
		const { stream, path } = ev.fields;
		if (typeof stream !== "string" && typeof path !== "string") {
			recentEvents.push(ev);
			continue;
		}
		const fields = { ...ev.fields };
		if (typeof stream === "string") fields.stream = await ofStream(stream);
		if (typeof path === "string") fields.path = await ofPath(path as VaultPath);
		recentEvents.push({ ...ev, fields });
	}

	let status = input.status;
	if (status.brake) {
		const samplePaths: VaultPath[] = [];
		for (const p of status.brake.samplePaths) samplePaths.push((await ofPath(p)) as VaultPath);
		status = { ...status, brake: { ...status.brake, samplePaths } };
	}

	const quarantine: DiagnosticsBundle["quarantine"][number][] = [];
	for (const q of input.quarantine.slice(0, DIAGNOSTICS_QUARANTINE_MAX)) quarantine.push({ ...q, stream: await ofStream(q.stream) });
	const frozenDocs: DiagnosticsBundle["frozenDocs"][number][] = [];
	for (const f of input.frozen) frozenDocs.push({ stream: await ofStream(f.stream), reason: f.reason });

	return {
		generatedAtMs: input.generatedAtMs,
		clientVersion: input.clientVersion,
		status,
		recentEvents,
		quarantine,
		frozenDocs,
		stores: input.stores,
		paths: includePaths
			? [...known].map(([p, path]) => ({ pseudonym: p, path })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			: null,
	};
}
