/**
 * Engine side of the engine -> main requests (DESIGN §g.2): the disk side's
 * DiskGateway, the ConfigDirPort used by settings sync and the SideFilePort
 * used by the outbox/synced mirrors and snapshots, all as rid-correlated
 * round trips over the one transport. Disk I/O itself runs on main (the
 * host's DiskExecutor); nothing here touches a file.
 */

import type { HashPort } from "../../ports/crypto";
import type { ConfigDirPort, SideFileName, SideFilePath, SideFilePort } from "../../ports/vault";
import type { ProtocolError } from "../../protocol/errors";
import { LANE, type DiskOp, type DiskReadRequest, type DiskReadResult, type EngineToMain, type HostIoOp, type HostIoResult, type Lane, type MainResultValue } from "../../protocol/messages";
import type { EngineTransport } from "../../protocol/transport";
import { owned, postOwned, TransferOwnershipError, wipeSecrets } from "../../protocol/workerTransport";
import type { DiskGateway, ExecResult } from "../reconcile/deps";
import { fingerprintWrites, withFingerprints } from "./hashService";

type WithRid = Extract<EngineToMain, { readonly rid: number }>;
type Body<T> = T extends unknown ? Omit<T, "rid"> : never;
export type HostRequestBody = Body<WithRid>;

export class HostRequestFailed extends Error {
	constructor(readonly error: ProtocolError) {
		super(`host request failed: ${error.code}: ${error.message}`);
	}
}

const CONFIG_READ_MAX = 16 * 1024 * 1024;

export class HostLink {
	private nextRid = 1;
	private readonly pending = new Map<number, { resolve(v: MainResultValue): void; reject(e: Error): void }>();
	private closed = false;
	/** The last status snapshot posted (JSON), to drop identical re-posts. */
	private lastStatus: string | null = null;
	/**
	 * The store dir every side-file call addresses, `state/<deviceId>/` (identity-per-store §5.2): set by the composed
	 * engine once it knows the store's identity, before a runtime starts. null: no store yet (calls fail).
	 */
	sideDir: string | null = null;

	/** `hash`: the engine ports' HashPort (null before init: no disk op runs then). */
	constructor(private readonly transport: EngineTransport, private readonly hash: () => HashPort | null) {}

	post(message: EngineToMain): void {
		try {
			if (this.closed) return;
			if (message.t === "status") {
				// Only a changed snapshot crosses to main: an idle engine re-posts the same one on every maintenance tick.
				const json = JSON.stringify(message.status);
				if (json === this.lastStatus) return;
				this.lastStatus = json;
			}
			try {
				postOwned(this.transport, message);
			} catch (e) {
				if (!(e instanceof TransferOwnershipError)) throw e;
				this.transport.post(message); // shared buffer: structured clone copies
			}
		} finally {
			wipeSecrets(message); // e2ee-design §6.3: the sender keeps no key bytes, transferred or not
		}
	}

	/**
	 * e2ee-design §18.4 persist-before-use: post the keys and winning records main must store, and resolve only once
	 * main answered `keyringStored` for this rid (it wrote SecretStorage first). The key buffers are transferred, or
	 * zero-filled after a copy: the caller must not use them afterwards.
	 */
	async keyringChanged(change: { readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[]; readonly pending: number | null }): Promise<void> {
		const v = await this.request({ t: "keyringChanged", keys: change.keys, records: change.records, pending: change.pending });
		if (v.t !== "keyringStored") throw new Error(`keyringChanged: unexpected answer ${v.t}`);
	}

	request(body: HostRequestBody): Promise<MainResultValue> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new HostRequestFailed({ code: "aborted", message: "engine closed", retryable: true }));
			const rid = this.nextRid++;
			this.pending.set(rid, { resolve, reject });
			this.post({ ...body, rid } as EngineToMain);
		});
	}

	/** `result` / `error` from main for one of our requests. */
	settle(re: number, value: MainResultValue | null, error: ProtocolError | null): void {
		const p = this.pending.get(re);
		if (!p) return;
		this.pending.delete(re);
		if (error) p.reject(new HostRequestFailed(error));
		else p.resolve(value as MainResultValue);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const all = [...this.pending.values()];
		this.pending.clear();
		for (const p of all) p.reject(new HostRequestFailed({ code: "aborted", message: "engine closed", retryable: true }));
	}

	/** The current store's dir, or a not-ready failure (no store identity yet). */
	private currentDir(): string {
		const dir = this.sideDir;
		if (dir === null) throw new HostRequestFailed({ code: "not-ready", message: "no store identity yet", retryable: true });
		return dir;
	}

	private async hostIo(op: HostIoOp): Promise<HostIoResult> {
		const r = await this.request({ t: "hostIo", op });
		if (r.t !== "hostIo") throw new Error(`unexpected hostIo answer ${r.t}`);
		return r.result;
	}

	readonly disk: DiskGateway = {
		read: async (reads: readonly DiskReadRequest[]): Promise<readonly DiskReadResult[]> => {
			if (reads.length === 0) return [];
			const r = await this.request({ t: "readRequest", reads });
			if (r.t !== "reads") throw new Error(`unexpected read answer ${r.t}`);
			return r.results;
		},
		exec: async (ops: readonly DiskOp[], lane: Lane): Promise<readonly ExecResult[]> => {
			if (ops.length === 0) return [];
			// Main never hashes: fingerprint what each write puts on disk here, before posting (the bytes
			// are transferred, detached afterwards), and attach it to the host's ok outcome.
			const hash = this.hash();
			if (!hash) throw new HostRequestFailed({ code: "not-ready", message: "engine ports not ready", retryable: true });
			const fps = await fingerprintWrites(hash, ops);
			// Write bytes are transferred: copy any view that does not own its buffer.
			const sent = ops.map((op) => (op.t === "write" && op.data.t === "bytes" ? { ...op, data: { t: "bytes" as const, bytes: owned(op.data.bytes) } } : op));
			const r = await this.request({ t: "diskOps", lane, ops: sent });
			if (r.t !== "diskOps") throw new Error(`unexpected diskOps answer ${r.t}`);
			return withFingerprints(ops, fps, r.results);
		},
	};

	/** The side files of one store dir, `state/<dir>/` (`dir` read per call). */
	private sideFilesIn(dirOf: () => string): SideFilePort {
		return {
			read: async (name) => {
				const r = await this.request({ t: "sideFileRead", name: `${dirOf()}/${name}` as SideFilePath });
				if (r.t !== "sideFile") throw new Error(`unexpected sideFileRead answer ${r.t}`);
				return r.bytes;
			},
			write: async (name, bytes) => {
				// The message transfers its bytes: hand over a private copy.
				const r = await this.request({ t: "sideFileWrite", name: `${dirOf()}/${name}` as SideFilePath, bytes: bytes.slice() });
				if (r.t !== "sideFileWritten") throw new Error(`unexpected sideFileWrite answer ${r.t}`);
			},
			remove: async (name) => {
				await this.hostIo({ t: "sideFileRemove", name: `${dirOf()}/${name}` as SideFilePath });
			},
			list: async (prefix) => {
				const dir = dirOf();
				const r = await this.hostIo({ t: "sideFileList", prefix: `${dir}/${prefix}` });
				if (r.t !== "sideFiles") return [];
				// Back to the store's own names (the host lists only that dir).
				const out: SideFileName[] = [];
				for (const p of r.names) if (p.startsWith(`${dir}/`)) out.push(p.slice(dir.length + 1) as SideFileName);
				return out;
			},
		};
	}

	/** The current store's side files (identity-per-store §5.2: a store reads and writes its own dir). */
	readonly sideFiles: SideFilePort = this.sideFilesIn(() => this.currentDir());

	/**
	 * A lineage predecessor's dir, `state/<deviceId>/` (identity-per-store §5.2: read during recovery, removed once this
	 * store's mirrors replace it). The engine names only this install's earlier stores; never a foreign dir.
	 */
	sideFilesOf(deviceId: string): SideFilePort {
		if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) throw new Error("not a store dir");
		return this.sideFilesIn(() => deviceId);
	}

	readonly configDir: ConfigDirPort = {
		list: async (dir) => {
			const r = await this.hostIo({ t: "configList", dir });
			return r.t === "configListing" ? r.entries : [];
		},
		readBytes: async (path) => {
			const [res] = await this.disk.read([{ area: "config", path, maxBytes: CONFIG_READ_MAX }]);
			if (!res || !res.ok) {
				if (res && !res.ok && res.reason === "missing") return null;
				if (!res || res.reason === "io") throw new Error(`config read failed: ${path}`);
				return null;
			}
			return res.bytes;
		},
		writeBytes: async (path, bytes) => {
			const [res] = await this.disk.exec([{ t: "write", opId: 0, area: "config", path, data: { t: "bytes", bytes: bytes.slice() }, precondition: { t: "any" }, docId: null, purpose: "settings" }], LANE.background);
			if (!res || res.t !== "write" || !res.outcome.ok) throw new Error(`config write failed: ${path}`);
		},
		remove: async (path) => {
			await this.hostIo({ t: "configRemove", path });
		},
	};
}
