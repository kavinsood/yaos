/**
 * Settings sync driver (DESIGN §j.3): detection + projection in one pass.
 *
 *   snapshot (ConfigDirPort list/read) -> planCfg(local, cfgBase, view)
 *   -> upload blob refs (failed upload: the file waits for the next pass)
 *   -> submitCfg(all ops)  (outbox + optimistic overlay before resolving)
 *   -> cfgBase for emit-only files
 *   -> per write: re-read, skip if the file moved since the snapshot, else
 *      download (blob refs) and writeBytes/remove, then cfgBase (T_cfg).
 *
 * Writes go through ConfigDirPort.writeBytes (atomic replace). A crash after a
 * write but before its cfgBase commit leaves local == view, which the next pass
 * records as in sync. A crash after submitCfg but before the base commit re-emits
 * the same ops (idempotent LWW values).
 */
import { exactFingerprint } from "../../core/hash/markdownLf";
import { utf8Decode } from "../../core/hash/utf8";
import type { CfgFoldState, CfgOp, ConfigRelPath, DocId } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { StorageDb } from "../../ports/storage";
import type { ConfigDirPort } from "../../ports/vault";
import type { BlobTransfer } from "../reconcile/context";
import type { DiskSchema } from "../reconcile/store";
import { STORE, type CfgBaseRecord } from "../store/schema";
import { CFG_JSON_FILES, CFG_PLUGINS_FILE, classifyConfigPath, isSyncablePluginId, manifestVersion } from "./allowlist";
import { planCfg, type CfgFileAction, type CfgLocalFile, type CfgLocalSnapshot, type CfgPlan } from "./cfgPlan";

/** The cfg side of the log runtime (WP-C). */
export interface CfgLogPort {
	/** Committed cfg fold with this device's unfolded ops applied optimistically. */
	view(): CfgFoldState;
	/** Frame the ops, put them in the outbox (T_edit) and the overlay before resolving. */
	submitCfg(ops: readonly CfgOp[]): Promise<void>;
}

export interface CfgSyncDeps {
	readonly db: StorageDb<DiskSchema>;
	readonly config: ConfigDirPort;
	readonly log: CfgLogPort;
	readonly blobs: BlobTransfer | null;
	readonly clock: ClockPort;
	readonly notice?: (level: "info" | "warn", code: string, detail?: string) => void;
}

export interface CfgPassResult {
	readonly plan: CfgPlan;
	readonly emitted: number;
	readonly written: readonly ConfigRelPath[];
	readonly deferred: readonly ConfigRelPath[];
}

/** BlobQueue rows need a doc id; cfg blobs use this sentinel. */
export const CFG_BLOB_DOC = "cfg" as DocId;

const decode = (b: Uint8Array): string | null => utf8Decode(b, true);

function join(dir: string, path: string): string {
	const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
	return dir ? `${dir}/${name}` : name;
}

export async function snapshotConfig(config: ConfigDirPort): Promise<CfgLocalSnapshot> {
	const files = new Map<ConfigRelPath, CfgLocalFile>();
	const installed = new Map<string, string | null>();
	const mtimes = new Map<string, number>();
	const read = async (path: string): Promise<void> => {
		if (!classifyConfigPath(path)) return;
		const bytes = await config.readBytes(path);
		if (bytes) files.set(path, { bytes, mtimeMs: mtimes.get(path) ?? 0 });
	};
	const list = async (dir: string) => {
		const out = await config.list(dir).catch(() => []);
		for (const e of out) mtimes.set(join(dir, e.path), e.mtimeMs);
		return out.map((e) => ({ path: join(dir, e.path), isFolder: e.isFolder }));
	};
	await list(""); // root mtimes
	for (const f of [...CFG_JSON_FILES, CFG_PLUGINS_FILE]) await read(f);
	for (const e of await list("snippets")) if (!e.isFolder) await read(e.path);
	for (const t of await list("themes")) {
		if (!t.isFolder) continue;
		await read(`${t.path}/theme.css`);
		await read(`${t.path}/manifest.json`);
	}
	for (const p of await list("plugins")) {
		if (!p.isFolder) continue;
		const id = p.path.slice("plugins/".length);
		if (!isSyncablePluginId(id)) continue;
		const manifest = await config.readBytes(`${p.path}/manifest.json`);
		if (manifest === null) continue;
		installed.set(id, manifestVersion(manifest, decode));
		await read(`${p.path}/data.json`);
	}
	return { files, installed };
}

export class CfgSync {
	private running: Promise<CfgPassResult> | null = null;

	constructor(private readonly deps: CfgSyncDeps) {}

	/** One detection + projection pass. Concurrent callers share the running pass. */
	pass(): Promise<CfgPassResult> {
		if (!this.running) this.running = this.run().finally(() => { this.running = null; });
		return this.running;
	}

	private async run(): Promise<CfgPassResult> {
		const { db, config, log, clock } = this.deps;
		const local = await snapshotConfig(config);
		const rows = await db.tx([STORE.cfgBase], "readonly", (tx) => tx.getAll(STORE.cfgBase));
		const base = new Map(rows.map((r) => [r.file, r]));
		const plan = planCfg({ local, base, view: log.view(), nowMs: clock.now() });
		const deferred: ConfigRelPath[] = [];
		const ready: CfgFileAction[] = [];
		for (const a of plan.actions) {
			if (a.upload) {
				const ok = this.deps.blobs
					? await this.deps.blobs.upload({ hash: a.upload.hash, docId: CFG_BLOB_DOC, path: a.file, bytes: a.upload.bytes }).catch(() => false)
					: false;
				if (!ok) { deferred.push(a.file); continue; }
			}
			ready.push(a);
		}
		const ops = ready.flatMap((a) => a.ops);
		if (ops.length > 0) await log.submitCfg(ops);
		const emitOnly = ready.filter((a) => !a.write);
		if (emitOnly.length > 0) await this.commitBases(emitOnly);
		const written: ConfigRelPath[] = [];
		let reload = false;
		for (const a of ready) {
			if (!a.write) continue;
			if (!(await this.applyWrite(a))) { deferred.push(a.file); continue; }
			await this.commitBases([a]);
			written.push(a.file);
			reload ||= a.reload;
		}
		if (reload) this.deps.notice?.("info", "settings-reload", written.join(", "));
		return { plan, emitted: ops.length, written, deferred };
	}

	private async applyWrite(a: CfgFileAction): Promise<boolean> {
		const { config } = this.deps;
		const cur = await config.readBytes(a.file);
		if ((cur ? exactFingerprint(cur) : null) !== a.expect) return false;
		const w = a.write!;
		if (w.t === "remove") {
			if (cur) await config.remove(a.file);
			return true;
		}
		let bytes: Uint8Array | null = w.t === "bytes" ? w.bytes : null;
		if (w.t === "blob") {
			bytes = this.deps.blobs
				? await this.deps.blobs.download({ hash: w.hash, docId: CFG_BLOB_DOC, path: a.file, size: w.size }).catch(() => null)
				: null;
			if (!bytes) return false;
		}
		await config.writeBytes(a.file, bytes!);
		return true;
	}

	private async commitBases(actions: readonly CfgFileAction[]): Promise<void> {
		await this.deps.db.tx([STORE.cfgBase], "readwrite", async (tx) => {
			for (const a of actions) {
				if (a.base) await tx.put(STORE.cfgBase, a.base satisfies CfgBaseRecord);
				else await tx.delete(STORE.cfgBase, a.file);
			}
		});
	}
}
