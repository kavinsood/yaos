/**
 * Headless end-to-end smoke of the opaque streams relay (docs/client-remake/relay-wire.md).
 *
 *   node e2e/relay/smoke.ts --host http://127.0.0.1:8787 [--label local]
 *   node e2e/relay/smoke.ts --host https://<worker>.workers.dev --label deployed [--operator-context <file>]
 *
 * Standalone: global fetch + WebSocket and a private lib0-compatible codec; imports nothing from src/
 * or server/. Every run uses a FRESH vault: an unclaimed server is claimed (the operator recovery
 * key is kept in a 0600 context file under the log dir); a claimed one is entered through operator login
 * (key from that context file or --operator-context <json with operatorRecoveryKey>) and gets a new vault.
 *
 * Steps: enroll A + B, streams tickets, sockets, VAULT_READY; append ns + b:<doc> from A (B sees
 * PROVISIONAL -> COMMIT_NOTICE and COMMITTED with seqs, A gets receipts); append->receipt latency series;
 * reconnect A + resend (deduped receipts, same seqs, no re-delivery) + id conflict; ping/pong; bulk append
 * (segment seal); feed paging; catch-up read paging; checkpoint CAS ok / 409 conflict / GC / read with checkpoint
 * / advancing CAS. Results (pass/fail + latencies, no secrets) go to <log dir>/client-e2e-smoke-<label>-<ts>.json.
 * Exit code 1 when any check fails.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- args
function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index > 0 ? process.argv[index + 1] : undefined;
}
const HOST = (arg("host") ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const LABEL = arg("label") ?? (HOST.includes("127.0.0.1") || HOST.includes("localhost") ? "local" : "deployed");
const LOG_DIR = arg("log-dir") ?? process.env.YAOS_E2E_LOG_DIR ?? "/Users/kavin/personal/obsidiansync/experiments/logs";
const OPERATOR_CONTEXT = arg("operator-context");
const LATENCY_SAMPLES = Number(arg("samples") ?? 8);
const WS_HOST = HOST.replace(/^http/, "ws");
const STARTED = new Date();
const STAMP = STARTED.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// ---------------------------------------------------------------- lib0-compatible codec
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

class Writer {
	bytes: number[] = [];
	u8(value: number) { this.bytes.push(value & 0xff); return this; }
	varUint(value: number) {
		let n = value;
		while (n > 0x7f) { this.bytes.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); }
		this.bytes.push(n);
		return this;
	}
	varBytes(value: Uint8Array) { this.varUint(value.byteLength); for (const b of value) this.bytes.push(b); return this; }
	varString(value: string) { return this.varBytes(utf8.encode(value)); }
	done() { return new Uint8Array(this.bytes); }
}

class Reader {
	pos = 0;
	buf: Uint8Array;
	constructor(buf: Uint8Array) { this.buf = buf; }
	u8() { if (this.pos >= this.buf.byteLength) throw new Error("eof"); return this.buf[this.pos++]!; }
	varUint() {
		let result = 0;
		let mult = 1;
		for (;;) {
			const b = this.u8();
			result += (b & 0x7f) * mult;
			if (b < 0x80) return result;
			mult *= 128;
		}
	}
	varBytes() {
		const length = this.varUint();
		if (this.pos + length > this.buf.byteLength) throw new Error("eof");
		const out = this.buf.slice(this.pos, this.pos + length);
		this.pos += length;
		return out;
	}
	varString() { return utf8d.decode(this.varBytes()); }
}

const APPEND = 0x01;
const PROVISIONAL = 0x10;
const COMMITTED = 0x11;
const NOTICE = 0x12;

function encodeAppend(stream: string, clientFrameId: string, payload: Uint8Array): Uint8Array {
	return new Writer().u8(APPEND).varString(stream).varString(clientFrameId).varBytes(payload).done();
}

interface Frame {
	kind: "provisional" | "committed" | "notice";
	seq: number | null;
	stream: string;
	deviceId: string;
	clientFrameId: string;
	payload: Uint8Array | null;
}

function decodeServerFrame(bytes: Uint8Array): Frame {
	const r = new Reader(bytes);
	const kind = r.u8();
	if (kind === PROVISIONAL) {
		return { kind: "provisional", seq: null, stream: r.varString(), deviceId: r.varString(), clientFrameId: r.varString(),
			payload: r.varBytes() };
	}
	if (kind === COMMITTED || kind === NOTICE) {
		const seq = r.varUint();
		const stream = r.varString();
		const deviceId = r.varString();
		const clientFrameId = r.varString();
		return kind === COMMITTED
			? { kind: "committed", seq, stream, deviceId, clientFrameId, payload: r.varBytes() }
			: { kind: "notice", seq, stream, deviceId, clientFrameId, payload: null };
	}
	throw new Error(`unknown server frame kind ${kind}`);
}

// ---------------------------------------------------------------- results
interface Check { step: string; name: string; ok: boolean; detail?: unknown }
const checks: Check[] = [];
const latencies: Record<string, number[]> = {};
let currentStep = "setup";

function step(name: string) { currentStep = name; console.log(`-- ${name}`); }
function check(name: string, ok: boolean, detail?: unknown) {
	checks.push({ step: currentStep, name, ok, ...(detail === undefined ? {} : { detail }) });
	console.log(`   ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? " " + JSON.stringify(detail).slice(0, 400) : ""}`);
	return ok;
}
function record(name: string, ms: number) { (latencies[name] ??= []).push(Math.round(ms * 10) / 10); }
const now = () => performance.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (bytes = 12) => randomBytes(bytes).toString("base64url");
function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array) {
	return !!a && a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}
const b64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
function payloadOf(label: string, size = 0): Uint8Array {
	const head = utf8.encode(`${label}|`);
	const out = new Uint8Array(Math.max(head.byteLength, size));
	out.set(head);
	for (let i = head.byteLength; i < out.byteLength; i++) out[i] = (i * 31 + label.length) & 0xff;
	return out;
}

// ---------------------------------------------------------------- http
async function http(method: string, path: string, options: { token?: string; cookie?: string; json?: unknown;
	body?: Uint8Array; timing?: string } = {}): Promise<{ status: number; value: any; headers: Headers }> {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.cookie) headers.Cookie = options.cookie;
	let body: BodyInit | undefined;
	if (options.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.json); }
	if (options.body) { headers["Content-Type"] = "application/octet-stream"; body = options.body; }
	const t0 = now();
	const response = await fetch(`${HOST}${path}`, { method, headers, body });
	const text = await response.text();
	if (options.timing) record(options.timing, now() - t0);
	let value: any = null;
	try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text.slice(0, 200) }; }
	return { status: response.status, value, headers: response.headers };
}

// ---------------------------------------------------------------- vault setup (fresh vault, two devices)
interface Device { name: string; deviceId: string; deviceToken: string }
interface Vault { vaultId: string; vaultGeneration: string; a: Device; b: Device; via: "claim" | "operator" }

function contextPath() { return join(LOG_DIR, `client-e2e-context-${new URL(HOST).host.replace(/[^a-z0-9.-]/gi, "_")}.json`); }
function saveContext(value: unknown) {
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(contextPath(), JSON.stringify(value, null, 2));
	chmodSync(contextPath(), 0o600);
}
function loadContext(): { operatorRecoveryKey?: string; vaults?: unknown[] } {
	return existsSync(contextPath()) ? JSON.parse(readFileSync(contextPath(), "utf8")) : {};
}

async function enroll(pairingCode: string, name: string): Promise<{ device: Device; vaultId: string; vaultGeneration: string }> {
	const device = { name, deviceId: id(16), deviceToken: id(32) };
	const body = { pairingCode, enrollmentRequestId: id(16), deviceId: device.deviceId, deviceToken: device.deviceToken,
		deviceName: `client-e2e-${name}` };
	for (let attempt = 0; attempt < 10; attempt++) {
		const response = await http("POST", "/enroll", { json: body, timing: "enroll_ms" });
		if (response.status === 202) { await sleep(1000); continue; }
		if (response.status !== 200 || response.value?.deviceId !== device.deviceId) {
			throw new Error(`enroll ${name} failed ${response.status} ${String(response.value?.error ?? "")}`);
		}
		return { device, vaultId: response.value.vaultId, vaultGeneration: response.value.vaultGeneration };
	}
	throw new Error(`enroll ${name}: authorization fence still pending`);
}

async function operatorLogin(key: string): Promise<string> {
	const response = await fetch(`${HOST}/operator/login`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey: key }) });
	await response.arrayBuffer();
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!response.ok || !cookie) throw new Error(`operator login failed (${response.status})`);
	return cookie;
}

async function setupVault(): Promise<Vault> {
	const caps = await http("GET", "/api/capabilities");
	const context = loadContext();
	let pairingCode: string;
	let via: Vault["via"];
	if (caps.value?.claimed === false) {
		const operatorRecoveryKey = id(32);
		const claimed = await http("POST", "/claim", { json: { operatorRecoveryKey }, timing: "claim_ms" });
		if (claimed.status !== 200 || typeof claimed.value?.pairingCode !== "string") {
			throw new Error(`claim failed ${claimed.status} ${String(claimed.value?.error ?? "")}`);
		}
		saveContext({ host: HOST, operatorRecoveryKey, vaults: [] });
		pairingCode = claimed.value.pairingCode;
		via = "claim";
	} else {
		let key = context.operatorRecoveryKey;
		if (!key && OPERATOR_CONTEXT) key = JSON.parse(readFileSync(OPERATOR_CONTEXT, "utf8")).operatorRecoveryKey;
		if (!key) throw new Error(`${HOST} is claimed and no operator key is known (pass --operator-context <file>)`);
		if (!context.operatorRecoveryKey) saveContext({ host: HOST, operatorRecoveryKey: key, vaults: context.vaults ?? [] });
		const cookie = await operatorLogin(key);
		const created = await http("POST", "/operator/vaults", { cookie, json: { name: `client-e2e-${LABEL}-${STAMP}` },
			timing: "create_vault_ms" });
		const vaultId = created.value?.vault?.vaultId;
		if (!created.status.toString().startsWith("2") || typeof vaultId !== "string") {
			throw new Error(`create vault failed ${created.status} ${String(created.value?.error ?? "")}`);
		}
		const code = await http("POST", `/operator/vaults/${encodeURIComponent(vaultId)}/owner-code`, { cookie,
			json: { purpose: "owner-bootstrap" } });
		if (typeof code.value?.pairingCode !== "string") throw new Error(`owner-code failed ${code.status} ${String(code.value?.error ?? "")}`);
		pairingCode = code.value.pairingCode;
		via = "operator";
	}
	const a = await enroll(pairingCode, "A");
	const pairing = await http("POST", `/vault/${encodeURIComponent(a.vaultId)}/auth/pairing-code`, { token: a.device.deviceToken,
		json: { purpose: "device" } });
	if (typeof pairing.value?.pairingCode !== "string") throw new Error(`pairing code failed ${pairing.status}`);
	const b = await enroll(pairing.value.pairingCode, "B");
	if (b.vaultId !== a.vaultId || b.vaultGeneration !== a.vaultGeneration) throw new Error("device B joined a different vault");
	const saved = loadContext();
	saveContext({ ...saved, vaults: [...(saved.vaults ?? []), { label: LABEL, vaultId: a.vaultId, createdAt: new Date().toISOString(),
		devices: { A: a.device, B: b.device } }] });
	return { vaultId: a.vaultId, vaultGeneration: a.vaultGeneration, a: a.device, b: b.device, via };
}

// ---------------------------------------------------------------- streams socket
interface Event { at: number; control?: any; frame?: Frame }

class StreamSocket {
	name: string;
	ws: WebSocket;
	events: Event[] = [];
	ready: any = null;
	closed: { code: number; reason: string } | null = null;
	private wake: (() => void) | null = null;

	constructor(name: string, ws: WebSocket) {
		this.name = name;
		this.ws = ws;
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (event: MessageEvent) => {
			const at = now();
			if (typeof event.data === "string") {
				if (!event.data.startsWith("__YPS:")) return;
				this.events.push({ at, control: JSON.parse(event.data.slice(6)) });
			} else {
				this.events.push({ at, frame: decodeServerFrame(new Uint8Array(event.data as ArrayBuffer)) });
			}
			this.wake?.();
		});
		ws.addEventListener("close", (event: CloseEvent) => { this.closed = { code: event.code, reason: event.reason }; this.wake?.(); });
	}

	static async open(vault: Vault, device: Device, name: string): Promise<StreamSocket> {
		const t0 = now();
		const ticket = await http("POST", `/vault/${encodeURIComponent(vault.vaultId)}/auth/ticket`, { token: device.deviceToken,
			json: { purpose: "streams" }, timing: "ticket_ms" });
		if (ticket.status !== 200 || typeof ticket.value?.ticket !== "string") throw new Error(`ticket failed ${ticket.status}`);
		const t1 = now();
		const ws = new WebSocket(`${WS_HOST}/vault/${encodeURIComponent(vault.vaultId)}/ws/streams?ticket=${
			encodeURIComponent(ticket.value.ticket)}&streamsVersion=1`);
		const socket = new StreamSocket(name, ws);
		const ready = await socket.waitFor((e) => e.control?.type === "VAULT_READY" ? e.control : undefined, 15000, "VAULT_READY");
		socket.ready = ready.value;
		record("socket_connect_ms", ready.at - t1);
		record("ticket_plus_connect_ms", ready.at - t0);
		return socket;
	}

	mark() { return this.events.length; }
	append(stream: string, clientFrameId: string, payload: Uint8Array) { this.ws.send(encodeAppend(stream, clientFrameId, payload)); return now(); }
	control(value: unknown) { this.ws.send(`__YPS:${JSON.stringify(value)}`); return now(); }

	async waitFor<T>(match: (event: Event) => T | undefined, timeoutMs: number, what: string, from = 0): Promise<{ value: T; at: number }> {
		const deadline = now() + timeoutMs;
		for (let index = from; ; ) {
			while (index < this.events.length) {
				const event = this.events[index++]!;
				const value = match(event);
				if (value !== undefined) return { value, at: event.at };
			}
			if (this.closed) throw new Error(`${this.name}: socket closed ${this.closed.code} ${this.closed.reason} waiting for ${what}`);
			const left = deadline - now();
			if (left <= 0) throw new Error(`${this.name}: timeout waiting for ${what}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { this.wake = null; resolve(); }, left);
				this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
			});
		}
	}

	/** Waits until receipts for every id arrived after `from`; returns id -> receipt + arrival time. */
	async receipts(ids: string[], from: number, timeoutMs = 10000) {
		const out = new Map<string, { stream: string; seq: number; deduped: boolean; at: number; head: number }>();
		let index = from;
		while (out.size < ids.length) {
			const got = await this.waitFor((e) => e.control?.type === "STREAM_RECEIPTS" || e.control?.type === "STREAM_APPEND_REJECTED"
				|| e.control?.type === "VAULT_ERROR" ? e : undefined, timeoutMs, `receipts ${ids.join(",")}`, index);
			index = this.events.indexOf(got.value) + 1;
			const control = got.value.control;
			if (control.type !== "STREAM_RECEIPTS") throw new Error(`${this.name}: ${control.type} ${JSON.stringify(control).slice(0, 300)}`);
			for (const receipt of control.receipts) {
				if (ids.includes(receipt.clientFrameId)) out.set(receipt.clientFrameId, { ...receipt, at: got.at, head: control.head });
			}
		}
		return out;
	}

	frames(from = 0) { return this.events.slice(from).filter((e) => e.frame).map((e) => e.frame!); }
	close() { try { this.ws.close(1000, "smoke done"); } catch { /* closed */ } }
}

// ---------------------------------------------------------------- run
async function main() {
	console.log(`streams relay smoke: ${HOST} (${LABEL})`);
	step("capabilities");
	const caps = await http("GET", "/api/capabilities", { timing: "capabilities_ms" });
	check("capabilities 200", caps.status === 200, caps.status);
	check("streams capability = 1", caps.value?.streams === 1, caps.value?.streams);

	step("claim/enroll fresh vault + 2 devices");
	const vault = await setupVault();
	check(`vault ready via ${vault.via}`, typeof vault.vaultId === "string" && vault.vaultId.length > 0);
	const vaultPath = `/vault/${encodeURIComponent(vault.vaultId)}`;

	step("tickets + sockets");
	let a = await StreamSocket.open(vault, vault.a, "A");
	const b = await StreamSocket.open(vault, vault.b, "B");
	for (const [socket, device] of [[a, vault.a], [b, vault.b]] as const) {
		const ready = socket.ready;
		check(`${socket.name} VAULT_READY shape`, ready.documentId === "streams" && ready.vaultId === vault.vaultId
			&& ready.vaultEpoch === vault.vaultGeneration && ready.head === 0 && ready.capabilities?.streams === 1
			&& ready.canWrite === true && ready.deviceId === device.deviceId && typeof ready.runtimeEpoch === "string"
			&& ready.limits?.maxPayloadBytes === 1024 * 1024 && typeof ready.socketSessionId === "string",
		{ documentId: ready.documentId, head: ready.head, vaultEpochMatches: ready.vaultEpoch === vault.vaultGeneration,
			capabilities: ready.capabilities, canWrite: ready.canWrite, runtimeEpoch: typeof ready.runtimeEpoch });
	}

	step("append ns + b:<doc> from A");
	const doc = `b:${id(9)}`;
	const sent = new Map<string, Uint8Array>();
	const nsPayload = payloadOf("ns-1 rename note.md -> other.md", 300);
	const bPayload = payloadOf("b-1 yjs-update-bytes", 2000);
	sent.set("a-ns-1", nsPayload); sent.set("a-b-1", bPayload);
	let fromA = a.mark(); let fromB = b.mark();
	const t0 = a.append("ns", "a-ns-1", nsPayload);
	a.append(doc, "a-b-1", bPayload);
	const provisional = await b.waitFor((e) => e.frame?.kind === "provisional" && e.frame.clientFrameId === "a-b-1" ? e.frame : undefined,
		10000, "B provisional", fromB);
	record("append_to_peer_provisional_ms", provisional.at - t0);
	check("B PROVISIONAL b:<doc> carries A's payload, no seq", provisional.value.stream === doc && provisional.value.seq === null
		&& provisional.value.deviceId === vault.a.deviceId && bytesEqual(provisional.value.payload, bPayload));
	const receipts1 = await a.receipts(["a-ns-1", "a-b-1"], fromA);
	const nsReceipt = receipts1.get("a-ns-1")!; const bReceipt = receipts1.get("a-b-1")!;
	record("append_to_receipt_ms", nsReceipt.at - t0);
	const committed = await b.waitFor((e) => e.frame?.kind === "committed" && e.frame.clientFrameId === "a-ns-1" ? e.frame : undefined,
		10000, "B committed ns", fromB);
	const notice = await b.waitFor((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === "a-b-1" ? e.frame : undefined,
		10000, "B notice", fromB);
	record("append_to_peer_committed_ms", committed.at - t0);
	record("append_to_peer_notice_ms", notice.at - t0);
	check("receipts: seq 1 (ns), 2 (b:), deduped false", nsReceipt.seq === 1 && bReceipt.seq === 2 && !nsReceipt.deduped
		&& !bReceipt.deduped && nsReceipt.head === 2, { ns: nsReceipt, b: bReceipt });
	check("B COMMITTED ns with receipt seq + payload", committed.value.seq === nsReceipt.seq && committed.value.stream === "ns"
		&& bytesEqual(committed.value.payload, nsPayload));
	check("B COMMIT_NOTICE b:<doc> with receipt seq", notice.value.seq === bReceipt.seq && notice.value.stream === doc);
	check("A got no broadcast of its own frames", a.frames(fromA).length === 0, a.frames(fromA).length);
	check("B saw provisional before notice", provisional.at <= notice.at);

	step("append -> receipt latency series");
	let lastSeq = bReceipt.seq;
	for (let i = 0; i < LATENCY_SAMPLES; i++) {
		const cfid = `a-lat-${i}`;
		const payload = payloadOf(cfid, 512);
		sent.set(cfid, payload);
		fromA = a.mark(); fromB = b.mark();
		const ts = a.append(doc, cfid, payload);
		const got = await a.receipts([cfid], fromA);
		const r = got.get(cfid)!;
		record("append_to_receipt_ms", r.at - ts);
		const n = await b.waitFor((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === cfid ? e : undefined, 10000, "notice", fromB);
		record("append_to_peer_notice_ms", n.at - ts);
		if (r.seq !== lastSeq + 1) check(`${cfid} seq contiguous`, false, { seq: r.seq, expected: lastSeq + 1 });
		lastSeq = r.seq;
	}
	check(`${LATENCY_SAMPLES} sequential appends, contiguous seqs`, lastSeq === 2 + LATENCY_SAMPLES, lastSeq);

	step("ping/pong");
	fromA = a.mark();
	const tp = a.control({ type: "VAULT_PING", probeId: `p-${id(6)}` });
	const pong = await a.waitFor((e) => e.control?.type === "VAULT_PONG" ? e : undefined, 5000, "pong", fromA);
	record("ping_pong_ms", pong.at - tp);
	check("VAULT_PONG head = last seq", pong.value.control.head === lastSeq && pong.value.control.documentId === "streams",
		pong.value.control);

	step("reconnect A + resend (dedupe) + id conflict");
	a.close();
	await sleep(200);
	a = await StreamSocket.open(vault, vault.a, "A2");
	check("A2 VAULT_READY head = last seq", a.ready.head === lastSeq, a.ready.head);
	fromA = a.mark(); fromB = b.mark();
	const tr = a.append("ns", "a-ns-1", nsPayload);
	a.append(doc, "a-b-1", bPayload);
	const resent = await a.receipts(["a-ns-1", "a-b-1"], fromA);
	record("resend_to_receipt_ms", resent.get("a-ns-1")!.at - tr);
	check("resend receipts deduped with original seqs", resent.get("a-ns-1")!.deduped && resent.get("a-ns-1")!.seq === nsReceipt.seq
		&& resent.get("a-b-1")!.deduped && resent.get("a-b-1")!.seq === bReceipt.seq, Object.fromEntries(resent));
	await sleep(600);
	const bAfterResend = b.frames(fromB);
	check("B: no COMMITTED re-delivery of the deduped ns frame", !bAfterResend.some((f) => f.kind === "committed"), bAfterResend.map((f) => f.kind));
	check("B: re-sent provisional is settled by a notice with the original seq",
		!bAfterResend.some((f) => f.kind === "provisional") || bAfterResend.some((f) => f.kind === "notice" && f.seq === bReceipt.seq),
		bAfterResend.map((f) => `${f.kind}:${f.seq ?? ""}`));
	fromA = a.mark();
	a.append("ns", "a-ns-1", payloadOf("different bytes"));
	const rejected = await a.waitFor((e) => e.control?.type === "STREAM_APPEND_REJECTED" ? e.control : undefined, 10000, "conflict", fromA);
	check("reused clientFrameId with different bytes -> client_frame_id_conflict", rejected.value.code === "client_frame_id_conflict"
		&& rejected.value.seq === nsReceipt.seq, rejected.value);

	step("bulk append (group commit by bytes, segment seal)");
	const bulkIds: string[] = [];
	fromA = a.mark();
	const tb = now();
	for (let i = 0; i < 12; i++) {
		const cfid = `a-bulk-${i}`;
		const payload = payloadOf(cfid, 8 * 1024);
		sent.set(cfid, payload); bulkIds.push(cfid);
		a.append(doc, cfid, payload);
	}
	const bulk = await a.receipts(bulkIds, fromA);
	const bulkSeqs = bulkIds.map((cfid) => bulk.get(cfid)!.seq);
	record("bulk_12x8KiB_to_last_receipt_ms", Math.max(...[...bulk.values()].map((r) => r.at)) - tb);
	check("bulk receipts contiguous", bulkSeqs.every((seq, index) => seq === lastSeq + 1 + index), bulkSeqs);
	const receiptMessages = new Set([...bulk.values()].map((r) => r.at)).size;
	check("bulk committed in >= 2 group commits (64 KiB trigger)", receiptMessages >= 2, receiptMessages);
	lastSeq = bulkSeqs.at(-1)!;

	step("feed");
	const feed = await http("GET", `${vaultPath}/streams/feed?after=0`, { token: vault.b.deviceToken, timing: "feed_ms" });
	const changes = new Map<string, number>((feed.value?.changes ?? []).map((c: any) => [c.stream, c.lastSeq]));
	check("feed after=0: ns + b:<doc> with lastSeq, head", feed.status === 200 && changes.get("ns") === nsReceipt.seq
		&& changes.get(doc) === lastSeq && feed.value.head === lastSeq && feed.value.nextAfter === null
		&& feed.value.vaultEpoch === vault.vaultGeneration, feed.value);
	const page1 = await http("GET", `${vaultPath}/streams/feed?after=0&limit=1`, { token: vault.b.deviceToken, timing: "feed_ms" });
	const page2 = await http("GET", `${vaultPath}/streams/feed?after=${page1.value?.nextAfter}&limit=1`, { token: vault.b.deviceToken,
		timing: "feed_ms" });
	check("feed paging limit=1", page1.value?.changes?.length === 1 && page1.value.changes[0].stream === "ns"
		&& page1.value.nextAfter === nsReceipt.seq && page2.value?.changes?.[0]?.stream === doc && page2.value.nextAfter === null,
	{ page1: page1.value, page2: page2.value });
	const empty = await http("GET", `${vaultPath}/streams/feed?after=${lastSeq}`, { token: vault.b.deviceToken });
	check("feed after=head is empty", empty.value?.changes?.length === 0, empty.value);

	step("catch-up read (paged)");
	const rows: any[] = [];
	let after = 0;
	let pages = 0;
	for (;;) {
		const page = await http("GET", `${vaultPath}/streams/read?stream=${encodeURIComponent(doc)}&after=${after}&maxBytes=20000`,
			{ token: vault.b.deviceToken, timing: "read_page_ms" });
		pages++;
		if (page.status !== 200) { check("read page 200", false, page); break; }
		rows.push(...page.value.rows);
		if (page.value.nextAfter === null) break;
		after = page.value.nextAfter;
		if (pages > 50) break;
	}
	const expected = ["a-b-1", ...Array.from({ length: LATENCY_SAMPLES }, (_, i) => `a-lat-${i}`), ...bulkIds];
	check("read returns every b:<doc> row once, ascending, unmerged", rows.length === expected.length
		&& rows.every((row, index) => row.clientFrameId === expected[index] && bytesEqual(b64(row.payload), sent.get(row.clientFrameId)!)
			&& (index === 0 || row.seq > rows[index - 1].seq) && row.deviceId === vault.a.deviceId),
	{ rows: rows.length, expected: expected.length, first: rows[0]?.clientFrameId });
	check("read paginated by maxBytes", pages >= 4, pages);

	step("checkpoint CAS + GC");
	const ckpt = payloadOf("checkpoint state vector + merged doc", 4096);
	const tc = now();
	const put = await http("PUT", `${vaultPath}/streams/checkpoint?stream=${encodeURIComponent(doc)}&coversSeq=${lastSeq}&expectedCoversSeq=0`,
		{ token: vault.a.deviceToken, body: ckpt });
	record("checkpoint_put_ms", now() - tc);
	check("checkpoint PUT ok, GC deleted sealed segment(s)", put.status === 200 && put.value.coversSeq === lastSeq
		&& put.value.deletedSegments >= 1 && put.value.gcSeq > 0 && put.value.gcSeq <= lastSeq, put.value);
	const conflict = await http("PUT", `${vaultPath}/streams/checkpoint?stream=${encodeURIComponent(doc)}&coversSeq=${lastSeq}&expectedCoversSeq=0`,
		{ token: vault.b.deviceToken, body: ckpt });
	check("stale CAS -> 409 checkpoint_conflict with current coversSeq", conflict.status === 409
		&& conflict.value?.error === "checkpoint_conflict" && conflict.value?.current?.coversSeq === lastSeq, conflict);
	const afterGc = await http("GET", `${vaultPath}/streams/read?stream=${encodeURIComponent(doc)}&after=0`, { token: vault.b.deviceToken,
		timing: "read_page_ms" });
	check("read after=0 post-GC returns the checkpoint (rows start after it)", afterGc.status === 200
		&& afterGc.value.checkpoint?.coversSeq === lastSeq && bytesEqual(b64(afterGc.value.checkpoint.bytes), ckpt)
		&& afterGc.value.rows.every((row: any) => row.seq > lastSeq) && afterGc.value.gcSeq === put.value.gcSeq,
	{ checkpoint: afterGc.value?.checkpoint?.coversSeq, rows: afterGc.value?.rows?.length, gcSeq: afterGc.value?.gcSeq });
	fromA = a.mark();
	const tail = payloadOf("post-checkpoint", 256);
	sent.set("a-tail-1", tail);
	a.append(doc, "a-tail-1", tail);
	const tailSeq = (await a.receipts(["a-tail-1"], fromA)).get("a-tail-1")!.seq;
	const resume = await http("GET", `${vaultPath}/streams/read?stream=${encodeURIComponent(doc)}&after=0`, { token: vault.b.deviceToken });
	check("checkpoint + tail rows", resume.value?.checkpoint?.coversSeq === lastSeq && resume.value.rows.length === 1
		&& resume.value.rows[0].seq === tailSeq && resume.value.lastSeq === tailSeq, { rows: resume.value?.rows?.length });
	const incremental = await http("GET", `${vaultPath}/streams/read?stream=${encodeURIComponent(doc)}&after=${lastSeq}`,
		{ token: vault.b.deviceToken });
	check("read after=coversSeq skips the checkpoint", incremental.value?.checkpoint === null && incremental.value.rows.length === 1,
		{ checkpoint: incremental.value?.checkpoint, rows: incremental.value?.rows?.length });
	const advance = await http("PUT", `${vaultPath}/streams/checkpoint?stream=${encodeURIComponent(doc)}&coversSeq=${tailSeq}&expectedCoversSeq=${lastSeq}`,
		{ token: vault.a.deviceToken, body: payloadOf("checkpoint 2", 1024) });
	check("advancing CAS ok", advance.status === 200 && advance.value.coversSeq === tailSeq, advance.value);

	a.close(); b.close();
	return vault;
}

let vaultInfo: Vault | null = null;
let fatal: string | null = null;
try {
	vaultInfo = await main();
} catch (error) {
	fatal = error instanceof Error ? error.message : String(error);
	check("run completed", false, fatal);
}

function summary(values: number[]) {
	const sorted = [...values].sort((x, y) => x - y);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]!;
	return { n: sorted.length, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}
let serverSha: string | null = null;
try { serverSha = execFileSync("git", ["-C", new URL("../..", import.meta.url).pathname, "rev-parse", "--short", "HEAD"]).toString().trim(); }
catch { /* not a checkout */ }
const failed = checks.filter((c) => !c.ok);
const result = {
	label: LABEL,
	host: HOST,
	startedAt: STARTED.toISOString(),
	durationMs: Math.round(now()),
	sha: serverSha,
	vault: vaultInfo ? { vaultIdPrefix: vaultInfo.vaultId.slice(0, 8), via: vaultInfo.via } : null,
	passed: checks.length - failed.length,
	failed: failed.length,
	fatal,
	latencyMs: Object.fromEntries(Object.entries(latencies).map(([name, values]) => [name, { ...summary(values), samples: values }])),
	checks,
};
mkdirSync(LOG_DIR, { recursive: true });
const out = join(LOG_DIR, `client-e2e-smoke-${LABEL}-${STAMP}.json`);
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log("\nlatency ms (min / p50 / p90 / max, n):");
for (const [name, values] of Object.entries(latencies)) {
	const s = summary(values);
	console.log(`  ${name.padEnd(34)} ${s.min} / ${s.p50} / ${s.p90} / ${s.max}  (${s.n})`);
}
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${result.passed}/${checks.length} checks -> ${out}`);
setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 50);
