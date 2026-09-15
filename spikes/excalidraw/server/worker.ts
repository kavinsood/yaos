import {
	canonicalStringify,
	compareElements,
	type ActorIdentity,
	type AuthorityStamp,
	type MutationBatch,
	type NativeElementRecord,
	type PresencePayload,
} from "./room-core";

interface Environment {
	DRAWING_ROOMS: DurableObjectNamespace;
}

interface MetaRow {
	vault_generation: string;
	authorization_epoch: number;
	drawing_epoch: number;
	sequence: number;
}

interface ElementRow {
	element_data: string;
}

interface OperationRow {
	request_digest: string;
	receipt_json: string;
}

interface ChangeRow {
	sequence: number;
	change_json: string;
}

interface SocketAttachment {
	sessionId: string;
	identity: ActorIdentity;
	authority: AuthorityStamp;
}

interface RuntimeReceipt {
	operationId: string;
	sequence: number;
	acceptedElementIds: string[];
	staleElementIds: string[];
}

export default {
	fetch(request: Request, environment: Environment): Promise<Response> {
		const url = new URL(request.url);
		const drawingId = url.searchParams.get("drawing") ?? "default";
		const objectId = environment.DRAWING_ROOMS.idFromName(drawingId);
		return environment.DRAWING_ROOMS.get(objectId).fetch(request);
	},
};

export class DrawingRoomDO implements DurableObject {
	private readonly state: DurableObjectState;
	private readonly sql: SqlStorage;

	constructor(state: DurableObjectState) {
		this.state = state;
		this.sql = state.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				vault_generation TEXT NOT NULL,
				authorization_epoch INTEGER NOT NULL,
				drawing_epoch INTEGER NOT NULL,
				sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS elements (
				element_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				version_nonce INTEGER NOT NULL,
				deleted INTEGER NOT NULL,
				element_data TEXT NOT NULL,
				sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS operations (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				receipt_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS changes (
				sequence INTEGER PRIMARY KEY,
				operation_id TEXT NOT NULL,
				change_json TEXT NOT NULL
			);
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/initialize") return this.initialize(await request.json());
		if (request.method === "POST" && url.pathname === "/batch") return this.batch(await request.json() as MutationBatch);
		if (request.method === "POST" && url.pathname === "/authority") return this.replaceAuthority(await request.json());
		if (request.method === "POST" && url.pathname === "/compact") return this.compact();
		if (request.method === "GET" && url.pathname === "/snapshot") return this.snapshot();
		if (request.method === "GET" && url.pathname === "/replay") return this.replay(Number(url.searchParams.get("after") ?? "0"));
		if (request.method === "GET" && url.pathname === "/presence") return this.upgradePresence(request);
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		const attachment = socket.deserializeAttachment() as SocketAttachment | null;
		const meta = this.meta();
		if (!attachment || !meta || !authorityEquals(attachment.authority, fromMeta(meta))) {
			socket.close(4003, "stale authority");
			return;
		}
		try {
			const decoded = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as { type: string; payload: PresencePayload };
			if (decoded.type !== "presence") throw new TypeError("unsupported message");
			const payload = sanitizeRuntimePresence(decoded.payload);
			const frame = JSON.stringify({
				type: "presence",
				sessionId: attachment.sessionId,
				identity: attachment.identity,
				payload,
			});
			for (const peer of this.state.getWebSockets()) {
				if (peer !== socket) peer.send(frame);
			}
		} catch (error) {
			socket.send(JSON.stringify({ type: "error", error: String(error) }));
		}
	}

	webSocketClose(): void {}
	webSocketError(): void {}

	private initialize(value: unknown): Response {
		const authority = value as AuthorityStamp;
		validateAuthority(authority);
		this.state.storage.transactionSync(() => {
			const meta = this.meta();
			if (!meta) {
				this.sql.exec(
					"INSERT INTO room_meta(id, vault_generation, authorization_epoch, drawing_epoch, sequence) VALUES (1, ?, ?, ?, 0)",
					authority.vaultGeneration,
					authority.authorizationEpoch,
					authority.drawingEpoch,
				);
			} else if (!authorityEquals(authority, fromMeta(meta))) {
				throw new Error("already initialized with different authority");
			}
		});
		return Response.json({ ok: true });
	}

	private batch(batch: MutationBatch): Response {
		const requestDigest = canonicalStringify({
			actorId: batch.actorId,
			authority: batch.authority,
			elements: batch.elements,
			sessionId: batch.sessionId,
		});
		try {
			const receipt = this.state.storage.transactionSync(() => {
				const prior = this.sql.exec<OperationRow>(
					"SELECT request_digest, receipt_json FROM operations WHERE operation_id = ?",
					batch.operationId,
				).toArray()[0];
				if (prior) {
					if (prior.request_digest !== requestDigest) throw new Error("operation_equivocation");
					return JSON.parse(prior.receipt_json) as RuntimeReceipt;
				}
				const meta = this.meta();
				if (!meta) throw new Error("not_initialized");
				if (!authorityEquals(batch.authority, fromMeta(meta))) throw new Error("stale_authority");
				if (!Array.isArray(batch.elements) || batch.elements.length === 0 || batch.elements.length > 512) throw new Error("invalid_batch");

				const accepted: NativeElementRecord[] = [];
				const staleElementIds: string[] = [];
				const ids = new Set<string>();
				for (const incoming of batch.elements) {
					validateElement(incoming);
					if (ids.has(incoming.id)) throw new Error("duplicate_element_id");
					ids.add(incoming.id);
					const row = this.sql.exec<ElementRow>("SELECT element_data FROM elements WHERE element_id = ?", incoming.id).toArray()[0];
					const existing = row ? JSON.parse(row.element_data) as NativeElementRecord : null;
					if (!existing || compareElements(incoming, existing) > 0) accepted.push(incoming);
					else staleElementIds.push(incoming.id);
				}

				const sequence = accepted.length > 0 ? meta.sequence + 1 : meta.sequence;
				for (const element of accepted) {
					this.sql.exec(
						`INSERT INTO elements(element_id, version, version_nonce, deleted, element_data, sequence)
						 VALUES (?, ?, ?, ?, ?, ?)
						 ON CONFLICT(element_id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce,
						 deleted = excluded.deleted, element_data = excluded.element_data, sequence = excluded.sequence`,
						element.id,
						element.version,
						element.versionNonce,
						element.isDeleted ? 1 : 0,
						canonicalStringify(element),
						sequence,
					);
				}
				if (accepted.length > 0) {
					this.sql.exec("UPDATE room_meta SET sequence = ? WHERE id = 1", sequence);
					this.sql.exec(
						"INSERT INTO changes(sequence, operation_id, change_json) VALUES (?, ?, ?)",
						sequence,
						batch.operationId,
						canonicalStringify({ sequence, operationId: batch.operationId, actorId: batch.actorId, elements: accepted }),
					);
				}
				const receipt: RuntimeReceipt = {
					operationId: batch.operationId,
					sequence,
					acceptedElementIds: accepted.map((element) => element.id),
					staleElementIds,
				};
				this.sql.exec("INSERT INTO operations(operation_id, request_digest, receipt_json) VALUES (?, ?, ?)", batch.operationId, requestDigest, JSON.stringify(receipt));
				return receipt;
			});
			return Response.json(receipt);
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 409 });
		}
	}

	private replaceAuthority(value: unknown): Response {
		const authority = value as AuthorityStamp;
		validateAuthority(authority);
		this.state.storage.transactionSync(() => {
			const meta = this.meta();
			if (!meta) throw new Error("not_initialized");
			this.sql.exec(
				"UPDATE room_meta SET vault_generation = ?, authorization_epoch = ?, drawing_epoch = ? WHERE id = 1",
				authority.vaultGeneration,
				authority.authorizationEpoch,
				authority.drawingEpoch,
			);
		});
		const sockets = this.state.getWebSockets();
		for (const socket of sockets) socket.close(4003, "authority changed");
		return Response.json({ ok: true, socketsClosed: sockets.length });
	}

	private snapshot(): Response {
		const meta = this.meta();
		if (!meta) return Response.json({ error: "not_initialized" }, { status: 409 });
		const elements = this.sql.exec<ElementRow>("SELECT element_data FROM elements ORDER BY element_id").toArray()
			.map((row) => JSON.parse(row.element_data) as NativeElementRecord);
		return Response.json({ sequence: meta.sequence, authority: fromMeta(meta), elements });
	}

	private replay(after: number): Response {
		if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "invalid_sequence" }, { status: 400 });
		const rows = this.sql.exec<ChangeRow>("SELECT sequence, change_json FROM changes WHERE sequence > ? ORDER BY sequence", after).toArray();
		return Response.json({ events: rows.map((row) => JSON.parse(row.change_json)) });
	}

	private compact(): Response {
		const meta = this.meta();
		if (!meta) return Response.json({ error: "not_initialized" }, { status: 409 });
		const deleted = this.sql.exec("DELETE FROM changes WHERE sequence <= ?", meta.sequence).rowsWritten;
		return Response.json({ compactedThrough: meta.sequence, deletedEvents: deleted });
	}

	private upgradePresence(request: Request): Response {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
		const meta = this.meta();
		if (!meta) return new Response("not initialized", { status: 409 });
		const url = new URL(request.url);
		const attachment: SocketAttachment = {
			sessionId: required(url, "sessionId"),
			identity: {
				actorId: required(url, "actorId"),
				displayName: required(url, "displayName"),
				color: required(url, "color"),
				deviceId: required(url, "deviceId"),
			},
			authority: fromMeta(meta),
		};
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.serializeAttachment(attachment);
		this.state.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	private meta(): MetaRow | null {
		return this.sql.exec<MetaRow>("SELECT vault_generation, authorization_epoch, drawing_epoch, sequence FROM room_meta WHERE id = 1").toArray()[0] ?? null;
	}
}

function required(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (!value) throw new TypeError(`missing ${name}`);
	return value;
}

function fromMeta(meta: MetaRow): AuthorityStamp {
	return { vaultGeneration: meta.vault_generation, authorizationEpoch: meta.authorization_epoch, drawingEpoch: meta.drawing_epoch };
}

function authorityEquals(left: AuthorityStamp, right: AuthorityStamp): boolean {
	return left.vaultGeneration === right.vaultGeneration
		&& left.authorizationEpoch === right.authorizationEpoch
		&& left.drawingEpoch === right.drawingEpoch;
}

function validateAuthority(authority: AuthorityStamp): void {
	if (!authority || typeof authority.vaultGeneration !== "string" || !Number.isSafeInteger(authority.authorizationEpoch) || !Number.isSafeInteger(authority.drawingEpoch)) {
		throw new TypeError("invalid authority");
	}
}

function validateElement(element: NativeElementRecord): void {
	if (!element || typeof element.id !== "string" || element.id.length === 0 || !Number.isSafeInteger(element.version) || !Number.isSafeInteger(element.versionNonce)) {
		throw new TypeError("invalid element");
	}
}

function sanitizeRuntimePresence(payload: PresencePayload): PresencePayload {
	const encoded = JSON.stringify(payload);
	if (encoded.length > 32_768) throw new TypeError("presence frame too large");
	if (payload.pointer && (!Number.isFinite(payload.pointer.x) || !Number.isFinite(payload.pointer.y))) throw new TypeError("invalid pointer");
	if (payload.selectedElementIds && payload.selectedElementIds.length > 512) throw new TypeError("too many selections");
	return payload;
}
