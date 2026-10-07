/**
 * The sender's re-seal (e2ee-design §14.2 step 4). An outbox record sealed under an epoch below the newest winning
 * revoke, or not sealed at all (the copy of an own stale commit, sync/ingestRow.ts ownCommitCopy), is sealed again
 * under the current epoch before it is sent:
 *  - ns/cfg keep their id: the sender opens them only after the session's late-receipt reads, so one still in the
 *    outbox then never committed (and its frameNo stays, §8.2);
 *  - a copy keeps its id (fresh, never sent);
 *  - every other record takes a fresh id: its old one may have committed with other bytes, and a resend under it
 *    would be refused frame-id-conflict (R4). Yjs updates are idempotent, so a duplicate is harmless.
 * Runs only while the write gate is open (the gated crypto port refuses otherwise). The sender asks on every pump
 * until the record is replaced; requests for a record already being sealed are dropped.
 */

import { encodeBodyUpdateRef } from "../../core/codec/contents";
import { newClientFrameId } from "../../core/codec/ids";
import { bytesToHex } from "../../core/codec/lib0";
import { streamClass, type ClientFrameId, type ContentHash } from "../../core/types";
import { sealFrame } from "../ingest/envelope";
import type { OutboxRecord } from "../store/schema";
import type { EngineCtx } from "./context";

export class Resealer {
	private readonly busy = new Set<ClientFrameId>();

	constructor(private readonly c: EngineCtx) {}

	request(rec: OutboxRecord): void {
		if (this.busy.has(rec.clientFrameId) || this.c.gate() !== null || this.c.stopped) return;
		this.busy.add(rec.clientFrameId);
		void this.run(rec)
			.catch((e) => this.c.diag("frame-reseal-failed", { error: String(e) }))
			.finally(() => this.busy.delete(rec.clientFrameId));
	}

	private async run(rec: OutboxRecord): Promise<void> {
		const c = this.c;
		const cls = streamClass(rec.stream);
		const keep = rec.sealed.length === 0 || cls === "ns" || cls === "cfg";
		const clientFrameId = keep ? rec.clientFrameId : newClientFrameId(c.ports.random);
		let content = rec.content;
		if (rec.kind === "bodyUpdateRef") {
			// The record keeps the resolved update; the frame carries the ref (body/frames.ts).
			if (content.length === 0) {
				// A mirror recovery that could not resolve it (mirrorIo.ts): nothing to seal.
				c.diag("frame-poisoned", { why: "reseal-ref-content-missing" });
				c.applyOutboxResult(await c.repo.tOutbox([{ t: "state", clientFrameId: rec.clientFrameId, state: "poisoned" }]));
				return;
			}
			content = encodeBodyUpdateRef({ hash: bytesToHex(await c.ports.hash.sha256(content)) as ContentHash, size: content.length });
		}
		const s = await sealFrame(c.deps.crypto, c.opts.vaultId, {
			stream: rec.stream, deviceId: c.self, clientFrameId, kind: rec.kind, authorNsSeq: rec.authorNsSeq, flags: rec.flags, frameNo: rec.frameNo ?? 0, content,
		});
		if (c.stopped) return;
		if (s.keyEpoch < c.keyring.minSendEpoch()) {
			c.diag("frame-reseal-epoch", { keyEpoch: s.keyEpoch });
			return;
		}
		const res = await c.repo.tOutbox([{ t: "reseal", clientFrameId: rec.clientFrameId, fromEpoch: rec.keyEpoch, fromLength: rec.sealed.length, next: { clientFrameId, sealed: s.sealed, keyEpoch: s.keyEpoch } }]);
		c.applyOutboxResult(res);
		if (res.renamed.length > 0) c.diag("frame-resealed", { cls, fromEpoch: rec.keyEpoch, keyEpoch: s.keyEpoch, renamed: !keep });
	}
}
