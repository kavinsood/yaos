/**
 * Engine side of the engine -> main requests (DESIGN §g.2): the disk side's
 * DiskGateway, the ConfigDirPort used by settings sync and the SideFilePort
 * used by the outbox/synced mirrors and snapshots, all as rid-correlated
 * round trips over the one transport. Disk I/O itself runs on main (the
 * host's DiskExecutor); nothing here touches a file.
 */

import type { ConfigDirPort, SideFileName, SideFilePort } from "../../ports/vault";
import type { ProtocolError } from "../../protocol/errors";
import type { DiskOp, DiskReadRequest, DiskReadResult, EngineToMain, HostIoOp, HostIoResult, Lane, MainResultValue } from "../../protocol/messages";
import type { EngineTransport } from "../../protocol/transport";
import { owned, postOwned, TransferOwnershipError } from "../../protocol/workerTransport";
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
	/** Mirror bytes the host read before init (DESIGN §e.4), served once instead of a round trip. */
	private readonly seeded = new Map<SideFileName, Uint8Array | null>();

	constructor(private readonly transport: EngineTransport) {}

	post(message: EngineToMain): void {
		if (this.closed) return;
		try {
			postOwned(this.transport, message);
		} catch (e) {
			if (!(e instanceof TransferOwnershipError)) throw e;
			this.transport.post(message); // shared buffer: structured clone copies
		}
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

	get pendingCount(): number {
		return this.pending.size;
	}

	seedSideFiles(outbox: readonly (Uint8Array | null)[], synced: readonly (Uint8Array | null)[]): void {
		const names: SideFileName[] = ["outbox-a.bin", "outbox-b.bin"];
		names.forEach((n, i) => this.seeded.set(n, outbox[i] ?? null));
		(["synced-a.bin", "synced-b.bin"] as SideFileName[]).forEach((n, i) => this.seeded.set(n, synced[i] ?? null));
	}

	private async hostIo(op: HostIoOp): Promise<HostIoResult> {
		const r = await this.request({ t: "hostIo", op });
		if (r.t !== "hostIo") throw new Error(`unexpected hostIo answer ${r.t}`);
		return r.result;
	}

	readonly disk: DiskGateway = {
		read: async (reads: readonly DiskReadRequest[], _lane: Lane): Promise<readonly DiskReadResult[]> => {
			if (reads.length === 0) return [];
			const r = await this.request({ t: "readRequest", reads });
			if (r.t !== "reads") throw new Error(`unexpected read answer ${r.t}`);
			return r.results;
		},
		exec: async (ops: readonly DiskOp[], lane: Lane): Promise<readonly ExecResult[]> => {
			if (ops.length === 0) return [];
			// Main never hashes: fingerprint what each write puts on disk here, before posting (the bytes
			// are transferred, detached afterwards), and attach it to the host's ok outcome.
			const fps = fingerprintWrites(ops);
			// Write bytes are transferred: copy any view that does not own its buffer.
			const sent = ops.map((op) => (op.t === "write" && op.data.t === "bytes" ? { ...op, data: { t: "bytes" as const, bytes: owned(op.data.bytes) } } : op));
			const r = await this.request({ t: "diskOps", lane, ops: sent });
			if (r.t !== "diskOps") throw new Error(`unexpected diskOps answer ${r.t}`);
			return withFingerprints(ops, fps, r.results);
		},
	};

	readonly sideFiles: SideFilePort = {
		read: async (name) => {
			if (this.seeded.has(name)) {
				const b = this.seeded.get(name) ?? null;
				this.seeded.delete(name);
				return b;
			}
			const r = await this.request({ t: "sideFileRead", name });
			if (r.t !== "sideFile") throw new Error(`unexpected sideFileRead answer ${r.t}`);
			return r.bytes;
		},
		write: async (name, bytes) => {
			this.seeded.delete(name);
			// The message transfers its bytes: hand over a private copy.
			const r = await this.request({ t: "sideFileWrite", name, bytes: bytes.slice() });
			if (r.t !== "sideFileWritten") throw new Error(`unexpected sideFileWrite answer ${r.t}`);
		},
		remove: async (name) => {
			this.seeded.delete(name);
			await this.hostIo({ t: "sideFileRemove", name });
		},
		list: async (prefix) => {
			const r = await this.hostIo({ t: "sideFileList", prefix });
			return r.t === "sideFiles" ? r.names : [];
		},
	};

	readonly configDir: ConfigDirPort = {
		list: async (dir) => {
			const r = await this.hostIo({ t: "configList", dir });
			return r.t === "configListing" ? r.entries : [];
		},
		readBytes: async (path) => {
			const [res] = await this.disk.read([{ area: "config", path, maxBytes: CONFIG_READ_MAX }], 3);
			if (!res || !res.ok) {
				if (res && !res.ok && res.reason === "missing") return null;
				if (!res || res.reason === "io") throw new Error(`config read failed: ${path}`);
				return null;
			}
			return res.bytes;
		},
		writeBytes: async (path, bytes) => {
			const [res] = await this.disk.exec([{ t: "write", opId: 0, area: "config", path, data: { t: "bytes", bytes: bytes.slice() }, precondition: { t: "any" }, docId: null, purpose: "settings" }], 3);
			if (!res || res.t !== "write" || !res.outcome.ok) throw new Error(`config write failed: ${path}`);
		},
		remove: async (path) => {
			await this.hostIo({ t: "configRemove", path });
		},
	};
}
