/**
 * XMLHttpRequest for the node e2e clients, over node:http / node:https: exactly the subset
 * src/engine/adapters/httpBlob.ts uses for a blob PUT (open, setRequestHeader, send(Blob), abort; readyState,
 * status, responseText; onreadystatechange, onprogress, onload, onerror, onabort, upload.onprogress,
 * upload.onload). Node has no XMLHttpRequest, and httpBlob has no fetch fallback for PUT (its header says why), so
 * a node caller passes `xhr: nodeXhr` in HttpBlobOptions.
 *
 * send() streams blob.stream() with Content-Length = blob.size in writes of at most WRITE_SLICE bytes (Node's
 * Blob.stream() hands a one-part Blob over as a single chunk: one write, one progress event at its end, would let
 * httpBlob's idle window cut an upload that is still moving), waits for 'drain' whenever write() reports a full
 * buffer, fires upload.onprogress {loaded, total, lengthComputable} from each write's callback (the bytes were
 * handed to the socket) and upload.onload once the whole body is written. Response bytes fire onprogress; the end
 * of the response fires onload. abort() destroys the request. No timeout (ontimeout never fires): httpBlob sets none.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

type Listener = (() => void) | null;

/** Largest write: progress granularity (views of the Blob's chunk, no copy). */
const WRITE_SLICE = 64 * 1024;

/** Resolves once `req` can take more bytes, or is gone. */
function drained(req: ClientRequest): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			req.off("drain", done);
			req.off("close", done);
			resolve();
		};
		req.on("drain", done);
		req.on("close", done);
	});
}

export class NodeXhr {
	readyState = 0;
	status = 0;
	responseText = "";
	onreadystatechange: Listener = null;
	onprogress: Listener = null;
	onload: Listener = null;
	onerror: Listener = null;
	ontimeout: Listener = null;
	onabort: Listener = null;
	readonly upload: {
		onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
		onload: Listener;
	} = { onprogress: null, onload: null };
	private method = "GET";
	private url = "";
	private readonly headers: Record<string, string> = {};
	private req: ClientRequest | null = null;
	/** Every byte of the body is queued on the request (req.end() called). */
	private queued = false;
	/** onload, onerror or onabort has fired (or is about to): no event after it. */
	private finished = false;

	open(method: string, url: string): void {
		this.method = method;
		this.url = url;
		this.state(1);
	}

	setRequestHeader(name: string, value: string): void {
		this.headers[name] = value;
	}

	send(body: Blob): void {
		const url = new URL(this.url);
		const request = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = request(url, { method: this.method, headers: { ...this.headers, "Content-Length": String(body.size) } });
		this.req = req;
		// Once the response has started, it alone decides (a relay may answer 413 and close before the body is written).
		req.on("error", () => { if (this.readyState < 2) this.fail(); });
		req.on("response", (res) => this.receive(req, res));
		this.pump(req, body).catch(() => this.fail());
	}

	abort(): void {
		if (this.finished) return;
		this.finished = true;
		this.req?.destroy();
		this.state(4);
		this.onabort?.();
		this.readyState = 0;
	}

	private state(n: number): void {
		this.readyState = n;
		this.onreadystatechange?.();
	}

	private fail(): void {
		if (this.finished) return;
		this.finished = true;
		this.req?.destroy();
		this.state(4);
		this.onerror?.();
	}

	private async pump(req: ClientRequest, body: Blob): Promise<void> {
		const total = body.size;
		const reader = body.stream().getReader();
		let loaded = 0;
		const gone = () => this.finished || req.destroyed;
		for (;;) {
			const chunk = await reader.read();
			if (gone()) {
				await reader.cancel().catch(() => undefined);
				return;
			}
			if (chunk.done) break;
			for (let at = 0; at < chunk.value.length; at += WRITE_SLICE) {
				const bytes = chunk.value.subarray(at, at + WRITE_SLICE);
				const more = req.write(bytes, (error) => {
					if (error || this.finished) return;
					loaded += bytes.length;
					this.upload.onprogress?.({ loaded, total, lengthComputable: true });
				});
				if (!more) await drained(req);
				if (gone()) {
					await reader.cancel().catch(() => undefined);
					return;
				}
			}
		}
		this.queued = true;
		req.end(() => { if (!this.finished) this.upload.onload?.(); });
	}

	private receive(req: ClientRequest, res: IncomingMessage): void {
		if (this.finished) {
			res.resume();
			return;
		}
		this.status = res.statusCode ?? 0;
		this.state(2);
		const chunks: Buffer[] = [];
		res.on("data", (chunk: Buffer) => {
			if (this.finished) return;
			chunks.push(chunk);
			if (this.readyState !== 3) this.state(3);
			this.onprogress?.();
		});
		res.on("end", () => {
			if (this.finished) return;
			this.finished = true;
			// Answered before the whole body was queued: the socket is mid-request, never reused.
			if (!this.queued) req.destroy();
			this.responseText = Buffer.concat(chunks).toString("utf8");
			this.state(4);
			this.onload?.();
		});
		res.on("error", () => this.fail());
		res.on("close", () => { if (!res.complete) this.fail(); });
	}
}

/** NodeXhr as the type HttpBlobOptions.xhr takes (it implements only the subset httpBlob uses). */
export const nodeXhr = NodeXhr as unknown as typeof XMLHttpRequest;
