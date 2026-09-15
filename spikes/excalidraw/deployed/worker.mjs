import { DurableObject } from "cloudflare:workers";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
	status,
	headers: { "content-type": "application/json" },
});

const readJson = async (request, maximumBytes = 950_000) => {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > maximumBytes) throw new Error("payload_too_large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error("payload_too_large");
	return JSON.parse(text);
};

const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const first = (cursor) => cursor.toArray()[0] ?? null;

const elementWins = (candidate, current) => {
	if (!current) return true;
	if (candidate.version !== current.version) return candidate.version > current.version;
	return candidate.versionNonce < current.versionNonce;
};

const normalizeElement = (value) => {
	if (!value || typeof value !== "object" || !validId(value.id)) throw new Error("invalid_element_id");
	if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error("invalid_element_version");
	if (!Number.isSafeInteger(value.versionNonce) || value.versionNonce < 0) throw new Error("invalid_element_nonce");
	return {
		...value,
		isDeleted: value.isDeleted === true,
		index: typeof value.index === "string" ? value.index : "",
	};
};

export class AuthoritySpike extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS actors (
				actor_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL,
				revoked INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS reservations (
				operation_id TEXT PRIMARY KEY,
				actor_id TEXT NOT NULL,
				actor_revision INTEGER NOT NULL,
				allowed INTEGER NOT NULL,
				reason TEXT,
				permit_id TEXT
			);
		`);
	}

	actor(actorId) {
		const current = first(this.ctx.storage.sql.exec(
			"SELECT revision, revoked FROM actors WHERE actor_id = ?",
			actorId,
		));
		return current ?? { revision: 1, revoked: 0 };
	}

	async fetch(request) {
		try {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/reset") {
				const body = await readJson(request);
				if (!validId(body.actorId)) return json({ error: "invalid_actor" }, 400);
				this.ctx.storage.sql.exec(
					"INSERT INTO actors(actor_id, revision, revoked) VALUES (?, 1, 0) ON CONFLICT(actor_id) DO UPDATE SET revision = 1, revoked = 0",
					body.actorId,
				);
				return json({ actorId: body.actorId, revision: 1, revoked: false });
			}
			if (request.method === "POST" && url.pathname === "/fence") {
				const body = await readJson(request);
				if (!validId(body.actorId)) return json({ error: "invalid_actor" }, 400);
				const current = this.actor(body.actorId);
				const revision = current.revision + 1;
				this.ctx.storage.sql.exec(
					"INSERT INTO actors(actor_id, revision, revoked) VALUES (?, ?, 1) ON CONFLICT(actor_id) DO UPDATE SET revision = excluded.revision, revoked = 1",
					body.actorId,
					revision,
				);
				return json({ actorId: body.actorId, revision, revoked: true });
			}
			if (request.method === "POST" && url.pathname === "/reserve") {
				const body = await readJson(request);
				if (!validId(body.operationId) || !validId(body.actorId) || !Number.isSafeInteger(body.actorRevision)) {
					return json({ error: "invalid_reservation" }, 400);
				}
				const replay = first(this.ctx.storage.sql.exec(
					"SELECT allowed, reason, permit_id FROM reservations WHERE operation_id = ?",
					body.operationId,
				));
				if (replay) return json({ allowed: replay.allowed === 1, reason: replay.reason, permitId: replay.permit_id, replay: true });
				const actor = this.actor(body.actorId);
				const allowed = actor.revoked === 0 && actor.revision === body.actorRevision;
				const reason = allowed ? null : actor.revoked === 1 ? "actor_revoked" : "actor_revision_superseded";
				const permitId = allowed ? crypto.randomUUID() : null;
				this.ctx.storage.sql.exec(
					"INSERT INTO reservations(operation_id, actor_id, actor_revision, allowed, reason, permit_id) VALUES (?, ?, ?, ?, ?, ?)",
					body.operationId,
					body.actorId,
					body.actorRevision,
					allowed ? 1 : 0,
					reason,
					permitId,
				);
				return json({ allowed, reason, permitId, replay: false });
			}
			return json({ error: "not_found" }, 404);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	}
}

export class ExcalidrawRoomSpike extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;
		this.env = env;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sequence INTEGER NOT NULL);
			INSERT OR IGNORE INTO room_meta(singleton, sequence) VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS elements (
				element_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				version_nonce INTEGER NOT NULL,
				deleted INTEGER NOT NULL,
				element_index TEXT NOT NULL,
				payload TEXT NOT NULL,
				sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS changes (
				sequence INTEGER NOT NULL,
				element_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				PRIMARY KEY(sequence, element_id)
			);
			CREATE TABLE IF NOT EXISTS receipts (
				operation_id TEXT PRIMARY KEY,
				response TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS injected_failures (operation_id TEXT PRIMARY KEY);
		`);
	}

	async apply(request) {
		const body = await readJson(request);
		if (!validId(body.vaultId) || !validId(body.operationId) || !validId(body.actorId)
			|| !Number.isSafeInteger(body.actorRevision) || !Array.isArray(body.elements) || body.elements.length > 2_000) {
			return json({ error: "invalid_operation" }, 400);
		}
		const receipt = first(this.ctx.storage.sql.exec(
			"SELECT response FROM receipts WHERE operation_id = ?",
			body.operationId,
		));
		if (receipt) return json({ ...JSON.parse(receipt.response), receiptReplay: true });

		const authority = this.env.AUTHORITY.get(this.env.AUTHORITY.idFromName(body.vaultId));
		const reservationResponse = await authority.fetch("https://authority/reserve", {
			method: "POST",
			body: JSON.stringify({ operationId: body.operationId, actorId: body.actorId, actorRevision: body.actorRevision }),
		});
		const reservation = await reservationResponse.json();
		if (!reservation.allowed) return json({ error: reservation.reason, reserved: false }, 403);

		if (body.injectFailureAfterReserve === true) {
			const prior = first(this.ctx.storage.sql.exec(
				"SELECT operation_id FROM injected_failures WHERE operation_id = ?",
				body.operationId,
			));
			if (!prior) {
				this.ctx.storage.sql.exec("INSERT INTO injected_failures(operation_id) VALUES (?)", body.operationId);
				return json({ error: "injected_after_reserve", permitId: reservation.permitId }, 503);
			}
		}

		const normalized = body.elements.map(normalizeElement);
		let response;
		this.ctx.storage.transactionSync(() => {
			const racedReceipt = first(this.ctx.storage.sql.exec(
				"SELECT response FROM receipts WHERE operation_id = ?",
				body.operationId,
			));
			if (racedReceipt) {
				response = { ...JSON.parse(racedReceipt.response), receiptReplay: true };
				return;
			}
			const winners = [];
			for (const candidate of normalized) {
				const row = first(this.ctx.storage.sql.exec(
					"SELECT version, version_nonce, payload FROM elements WHERE element_id = ?",
					candidate.id,
				));
				const current = row ? { version: row.version, versionNonce: row.version_nonce } : null;
				if (elementWins(candidate, current)) winners.push(candidate);
			}
			const currentSequence = this.ctx.storage.sql.exec("SELECT sequence FROM room_meta WHERE singleton = 1").one().sequence;
			const sequence = winners.length > 0 ? currentSequence + 1 : currentSequence;
			if (winners.length > 0) this.ctx.storage.sql.exec("UPDATE room_meta SET sequence = ? WHERE singleton = 1", sequence);
			for (const winner of winners) {
				const payload = JSON.stringify(winner);
				this.ctx.storage.sql.exec(
					`INSERT INTO elements(element_id, version, version_nonce, deleted, element_index, payload, sequence)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(element_id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce,
					 deleted = excluded.deleted, element_index = excluded.element_index, payload = excluded.payload, sequence = excluded.sequence`,
					winner.id,
					winner.version,
					winner.versionNonce,
					winner.isDeleted ? 1 : 0,
					winner.index,
					payload,
					sequence,
				);
				this.ctx.storage.sql.exec(
					"INSERT INTO changes(sequence, element_id, payload) VALUES (?, ?, ?)",
					sequence,
					winner.id,
					payload,
				);
			}
			response = { operationId: body.operationId, sequence, accepted: winners, permitId: reservation.permitId, receiptReplay: false };
			this.ctx.storage.sql.exec(
				"INSERT INTO receipts(operation_id, response) VALUES (?, ?)",
				body.operationId,
				JSON.stringify(response),
			);
		});
		return json(response);
	}

	snapshot() {
		const sequence = this.ctx.storage.sql.exec("SELECT sequence FROM room_meta WHERE singleton = 1").one().sequence;
		const rows = this.ctx.storage.sql.exec(
			"SELECT payload FROM elements ORDER BY element_index ASC, element_id ASC",
		).toArray();
		return json({ sequence, elements: rows.map((row) => JSON.parse(row.payload)) });
	}

	replay(url) {
		const after = Number(url.searchParams.get("after") ?? 0);
		if (!Number.isSafeInteger(after) || after < 0) return json({ error: "invalid_cursor" }, 400);
		const rows = this.ctx.storage.sql.exec(
			"SELECT sequence, element_id, payload FROM changes WHERE sequence > ? ORDER BY sequence ASC, element_id ASC LIMIT 5000",
			after,
		).toArray();
		return json({ after, changes: rows.map((row) => ({ sequence: row.sequence, elementId: row.element_id, element: JSON.parse(row.payload) })) });
	}

	connect(url) {
		const sessionId = url.searchParams.get("sessionId");
		const actorId = url.searchParams.get("actorId");
		const displayName = url.searchParams.get("displayName") ?? "Anonymous";
		if (!validId(sessionId) || !validId(actorId)) return json({ error: "invalid_session" }, 400);
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.serializeAttachment({ sessionId, actorId, displayName: displayName.slice(0, 80) });
		this.ctx.acceptWebSocket(server, ["room"]);
		return new Response(null, { status: 101, webSocket: client });
	}

	async fetch(request) {
		try {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/apply") return this.apply(request);
			if (request.method === "GET" && url.pathname === "/snapshot") return this.snapshot();
			if (request.method === "GET" && url.pathname === "/replay") return this.replay(url);
			if (request.method === "GET" && url.pathname === "/ws") return this.connect(url);
			return json({ error: "not_found" }, 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return json({ error: message }, message === "payload_too_large" ? 413 : 400);
		}
	}

	webSocketMessage(websocket, message) {
		const attachment = websocket.deserializeAttachment();
		try {
			const parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
			if (parsed.type !== "presence" || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return;
			const authoritative = JSON.stringify({
				type: "presence",
				sessionId: attachment.sessionId,
				actorId: attachment.actorId,
				displayName: attachment.displayName,
				x: Math.max(-10_000_000, Math.min(10_000_000, parsed.x)),
				y: Math.max(-10_000_000, Math.min(10_000_000, parsed.y)),
				tool: parsed.tool === "laser" ? "laser" : "pointer",
			});
			for (const peer of this.ctx.getWebSockets("room")) if (peer !== websocket) peer.send(authoritative);
		} catch {
			websocket.close(1003, "invalid_presence");
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, experiment: "native-excalidraw-room" });
		const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)(\/.*)$/);
		if (roomMatch) {
			const room = env.DRAWING.get(env.DRAWING.idFromName(roomMatch[1]));
			const forwarded = new URL(request.url);
			forwarded.pathname = roomMatch[2];
			return room.fetch(new Request(forwarded, request));
		}
		const authorityMatch = url.pathname.match(/^\/authorities\/([^/]+)(\/.*)$/);
		if (authorityMatch) {
			const authority = env.AUTHORITY.get(env.AUTHORITY.idFromName(authorityMatch[1]));
			const forwarded = new URL(request.url);
			forwarded.pathname = authorityMatch[2];
			return authority.fetch(new Request(forwarded, request));
		}
		return json({ error: "not_found" }, 404);
	},
};
