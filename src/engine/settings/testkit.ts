/** Settings sync test kit: config dir, shared cfg log with LWW fold, device. */
import type { CfgFoldState, CfgOp, ConfigRelPath, DeviceId } from "../../core/types";
import { utf8Decode, utf8Encode } from "../../core/hash/utf8";
import type { ConfigDirPort } from "../../ports/vault";
import type { DiskSchema } from "../reconcile/store";
import { FakeBlobs, FakeClock } from "../reconcile/testkit/fakes";
import { FakeStorage } from "../reconcile/testkit/fakeStorage";
import { DB_SCHEMA_VERSION, STORE_SPECS } from "../store/schema";
import { cfgJsonKey } from "./allowlist";
import { CfgSync, type CfgLogPort, type CfgPassResult } from "./cfgSync";

export class FakeConfigDir implements ConfigDirPort {
	readonly files = new Map<string, Uint8Array>();
	writes = 0;
	/** Simulates another writer: applied right before the n-th read of `path`. */
	onRead: { path: string; atRead: number; bytes: Uint8Array } | null = null;
	private reads = new Map<string, number>();

	set(path: string, v: string | object): void {
		this.files.set(path, utf8Encode(typeof v === "string" ? v : JSON.stringify(v, null, 2)));
	}
	text(path: string): string | null {
		const b = this.files.get(path);
		return b ? utf8Decode(b) : null;
	}
	json(path: string): unknown {
		const t = this.text(path);
		return t === null ? null : JSON.parse(t);
	}
	async list(dir: string) {
		const prefix = dir ? `${dir}/` : "";
		const seen = new Map<string, boolean>();
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const cut = rest.indexOf("/");
			seen.set(cut < 0 ? rest : rest.slice(0, cut), cut >= 0 || seen.get(rest) === true);
		}
		return [...seen].map(([name, isFolder]) => ({ path: prefix + name, size: isFolder ? 0 : this.files.get(prefix + name)!.length, mtimeMs: 1, isFolder }));
	}
	async readBytes(path: string) {
		const n = (this.reads.get(path) ?? 0) + 1;
		this.reads.set(path, n);
		if (this.onRead && this.onRead.path === path && this.onRead.atRead === n) this.files.set(path, this.onRead.bytes);
		return this.files.get(path)?.slice() ?? null;
	}
	async writeBytes(path: string, bytes: Uint8Array) { this.writes++; this.files.set(path, bytes.slice()); }
	async remove(path: string) { this.files.delete(path); }
	resetReads(): void { this.reads.clear(); }
	readsOf(path: string): number { return this.reads.get(path) ?? 0; }
}

export function emptyFold(): CfgFoldState {
	return { formatVersion: 1, coversSeq: 0, recentFrames: new Map(), json: new Map(), files: new Map(), plugins: new Map() };
}

/** Shared relay + fold: every submitted op gets the next seq; later seq wins (LWW). */
export class SharedCfgLog {
	readonly fold = emptyFold();
	readonly submitted: { device: string; op: CfgOp }[] = [];
	private seq = 0;

	apply(device: string, ops: readonly CfgOp[]): void {
		const seq = ++this.seq;
		ops.forEach((op, index) => {
			this.submitted.push({ device, op });
			const version = { seq, index, deviceId: device as DeviceId };
			switch (op.t) {
				case "jsonSet": this.fold.json.set(cfgJsonKey(op.file, op.key), { value: op.valueJson, version }); break;
				case "jsonDel": this.fold.json.set(cfgJsonKey(op.file, op.key), { value: null, version }); break;
				case "filePut": this.fold.files.set(op.file, { value: { content: op.content, pluginVersion: op.pluginVersion }, version }); break;
				case "fileDel": this.fold.files.set(op.file, { value: null, version }); break;
				case "pluginSet": this.fold.plugins.set(op.pluginId, { value: op.enabled, version }); break;
				case "pluginDel": this.fold.plugins.set(op.pluginId, { value: null, version }); break;
			}
		});
		this.fold.coversSeq = seq;
	}
	port(device: string): CfgLogPort {
		return { view: () => this.fold, submitCfg: async (ops) => this.apply(device, ops) };
	}
	opsBy(device: string): CfgOp[] {
		return this.submitted.filter((s) => s.device === device).map((s) => s.op);
	}
}

export class Device {
	readonly config = new FakeConfigDir();
	readonly storage = new FakeStorage();
	readonly clock = new FakeClock();
	/** Notice codes, in order. */
	readonly notices: string[] = [];
	readonly warnings: { code: string; message: string }[] = [];
	private sync: CfgSync | null = null;

	constructor(readonly name: string, readonly log: SharedCfgLog, readonly blobs: FakeBlobs | null = null) {}
	plugin(id: string, version: string | null, data?: object): void {
		this.config.set(`plugins/${id}/manifest.json`, version === null ? "{" : { id, version });
		this.config.set(`plugins/${id}/main.js`, "code()");
		if (data) this.config.set(`plugins/${id}/data.json`, data);
	}
	async pass(): Promise<CfgPassResult> {
		if (!this.sync) {
			const db = await this.storage.open<DiskSchema>(`cfg-${this.name}`, DB_SCHEMA_VERSION, STORE_SPECS);
			this.sync = new CfgSync({ db, config: this.config, log: this.log.port(this.name), blobs: this.blobs, clock: this.clock, notice: (l, c, m) => {
				this.notices.push(c);
				if (l === "warn") this.warnings.push({ code: c, message: m ?? "" });
			} });
		}
		this.config.resetReads();
		return this.sync.pass();
	}
	bases(): ConfigRelPath[] {
		return (this.storage.dump(`cfg-${this.name}`, "cfgBase")).map((r) => (r as { file: string }).file).sort();
	}
}
