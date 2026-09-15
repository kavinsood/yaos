import {
	EXCALIDRAW_PRESENCE_SURFACE,
	MAX_PRESENCE_INPUT_FRAMES_PER_SECOND,
	MAX_PRESENCE_SOCKET_BUFFER_BYTES,
	PRESENCE_MIN_BROADCAST_INTERVAL_MS,
	PRESENCE_PROTOCOL_VERSION,
	PRESENCE_TTL_MS,
	presenceColors,
	type ExcalidrawPresenceState,
	type AudienceSafePresenceSnapshotFrame,
	type AudienceSafePresenceStateFrame,
	type PresenceEntry,
	type PresenceLeaveFrame,
	type PresenceSnapshotFrame,
	type PresenceStateFrame,
	type ProjectedPresenceEntry,
} from "./shared/presenceProtocol";

export interface PresenceSocketAttachment {
	sessionId: string;
	principalId: string;
	deviceId: string;
	displayName: string;
	colorSeed: string;
	presence?: ExcalidrawPresenceState;
	presenceClientSequence?: number;
	presenceUpdatedAt?: number;
	presenceLastBroadcastAt?: number;
	presenceLastBroadcastSequence?: number;
	presenceRateWindowStartedAt?: number;
	presenceRateWindowCount?: number;
}

export interface PresenceSocketPort<Attachment extends PresenceSocketAttachment> {
	readonly bufferedAmount?: number;
	send(message: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(attachment: Attachment): void;
	deserializeAttachment(): unknown;
}

export interface PresenceKernelOptions<
	Attachment extends PresenceSocketAttachment,
	Socket extends PresenceSocketPort<Attachment>,
> {
	sockets: () => readonly Socket[];
	isAuthoritative: (attachment: Attachment) => boolean;
	authorityCloseCode: number;
	authorityCloseReason: string;
	now?: () => number;
	schedule?: (delayMs: number, callback: () => void) => void;
	projectEntry?: (entry: PresenceEntry, source: Attachment, recipient: Attachment) => ProjectedPresenceEntry;
	projectSessionId?: (sessionId: string, source: Attachment, recipient: Attachment) => string;
}

/** Ephemeral, session-scoped awareness independent of every durable document model. */
export class PresenceKernel<
	Attachment extends PresenceSocketAttachment,
	Socket extends PresenceSocketPort<Attachment>,
> {
	private readonly pendingFlushes = new Set<string>();

	constructor(private readonly options: PresenceKernelOptions<Attachment, Socket>) {}

	authoritativeSockets(): Socket[] {
		const result: Socket[] = [];
		for (const socket of this.options.sockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (attachment && this.options.isAuthoritative(attachment)) result.push(socket);
			else {
				try { socket.close(this.options.authorityCloseCode, this.options.authorityCloseReason); }
				catch { /* already closed */ }
			}
		}
		return result;
	}

	hasSession(sessionId: string): boolean { return this.socketForSession(sessionId) !== null; }

	snapshotFrame(recipient?: Attachment): PresenceSnapshotFrame | AudienceSafePresenceSnapshotFrame {
		this.sweepExpired();
		const presences: ProjectedPresenceEntry[] = [];
		for (const socket of this.authoritativeSockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (attachment?.presence && attachment.presenceUpdatedAt !== undefined) {
				const entry = this.entry(attachment);
				presences.push(recipient && this.options.projectEntry
					? this.options.projectEntry(entry, attachment, recipient) : entry);
			}
		}
		presences.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
		return { type: "presence.snapshot", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, presences } as PresenceSnapshotFrame | AudienceSafePresenceSnapshotFrame;
	}

	acceptUpdate(socket: Socket, attachment: Attachment, clientSequence: number,
		state: ExcalidrawPresenceState | null): void {
		const now = this.now();
		this.sweepExpired();
		this.flushDue();
		if (clientSequence <= (attachment.presenceClientSequence ?? 0)) return;
		if (attachment.presenceRateWindowStartedAt === undefined
			|| now - attachment.presenceRateWindowStartedAt >= 1_000) {
			attachment.presenceRateWindowStartedAt = now;
			attachment.presenceRateWindowCount = 1;
		} else attachment.presenceRateWindowCount = (attachment.presenceRateWindowCount ?? 0) + 1;
		if (attachment.presenceRateWindowCount > MAX_PRESENCE_INPUT_FRAMES_PER_SECOND) {
			socket.serializeAttachment(attachment);
			this.remove(socket, "closed");
			socket.close(1008, "presence rate exceeded");
			return;
		}
		attachment.presenceClientSequence = clientSequence;
		if (state === null) {
			const hadPresence = attachment.presence !== undefined;
			delete attachment.presence;
			delete attachment.presenceUpdatedAt;
			socket.serializeAttachment(attachment);
			if (hadPresence) this.broadcast(this.leaveFrame(attachment.sessionId, "client"));
			return;
		}
		attachment.presence = state;
		attachment.presenceUpdatedAt = now;
		socket.serializeAttachment(attachment);
		if (attachment.presenceLastBroadcastAt === undefined
			|| now - attachment.presenceLastBroadcastAt >= PRESENCE_MIN_BROADCAST_INTERVAL_MS) {
			this.publish(socket, attachment);
			return;
		}
		this.scheduleFlush(attachment.sessionId,
			PRESENCE_MIN_BROADCAST_INTERVAL_MS - (now - attachment.presenceLastBroadcastAt));
	}

	sweepExpired(): void {
		const now = this.now();
		const expired: string[] = [];
		for (const socket of this.authoritativeSockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (!attachment?.presence || attachment.presenceUpdatedAt === undefined
				|| now < attachment.presenceUpdatedAt + PRESENCE_TTL_MS) continue;
			expired.push(attachment.sessionId);
			delete attachment.presence;
			delete attachment.presenceUpdatedAt;
			socket.serializeAttachment(attachment);
		}
		for (const sessionId of expired) this.broadcast(this.leaveFrame(sessionId, "expired"));
	}

	flushDue(): void {
		const now = this.now();
		for (const socket of this.authoritativeSockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (!attachment?.presence || attachment.presenceUpdatedAt === undefined
				|| attachment.presenceClientSequence === attachment.presenceLastBroadcastSequence) continue;
			if (now - (attachment.presenceLastBroadcastAt ?? 0) >= PRESENCE_MIN_BROADCAST_INTERVAL_MS) {
				this.publish(socket, attachment);
			}
		}
	}

	remove(socket: Socket, reason: PresenceLeaveFrame["reason"]): void {
		const attachment = socket.deserializeAttachment() as Attachment | null;
		if (!attachment?.presence) return;
		delete attachment.presence;
		delete attachment.presenceUpdatedAt;
		socket.serializeAttachment(attachment);
		this.broadcast(this.leaveFrame(attachment.sessionId, reason));
	}

	sendSnapshot(socket: Socket): boolean {
		const attachment = socket.deserializeAttachment() as Attachment | null;
		return this.send(socket, JSON.stringify(this.snapshotFrame(attachment ?? undefined)));
	}

	private scheduleFlush(sessionId: string, delayMs: number): void {
		if (this.pendingFlushes.has(sessionId)) return;
		this.pendingFlushes.add(sessionId);
		const callback = (): void => {
			this.pendingFlushes.delete(sessionId);
			this.sweepExpired();
			const socket = this.socketForSession(sessionId);
			if (!socket) return;
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (!attachment?.presence || attachment.presenceUpdatedAt === undefined) return;
			const elapsed = this.now() - (attachment.presenceLastBroadcastAt ?? 0);
			if (elapsed < PRESENCE_MIN_BROADCAST_INTERVAL_MS) {
				this.scheduleFlush(sessionId, PRESENCE_MIN_BROADCAST_INTERVAL_MS - elapsed);
				return;
			}
			if (attachment.presenceClientSequence !== attachment.presenceLastBroadcastSequence) {
				this.publish(socket, attachment);
			}
		};
		if (this.options.schedule) this.options.schedule(Math.max(0, delayMs), callback);
		else setTimeout(callback, Math.max(0, delayMs));
	}

	private publish(socket: Socket, attachment: Attachment): void {
		if (!attachment.presence || attachment.presenceClientSequence === undefined
			|| attachment.presenceUpdatedAt === undefined) return;
		attachment.presenceLastBroadcastAt = this.now();
		attachment.presenceLastBroadcastSequence = attachment.presenceClientSequence;
		socket.serializeAttachment(attachment);
		const frame: PresenceStateFrame = { type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, presence: this.entry(attachment) };
		this.broadcastState(frame, attachment);
	}

	private entry(attachment: Attachment): PresenceEntry {
		const expiresInMs = Math.floor(Math.max(0, Math.min(PRESENCE_TTL_MS,
			attachment.presenceUpdatedAt! + PRESENCE_TTL_MS - this.now())));
		return { sessionId: attachment.sessionId, clientSequence: attachment.presenceClientSequence!, expiresInMs,
			identity: { principalId: attachment.principalId, deviceId: attachment.deviceId,
				displayName: attachment.displayName, ...presenceColors(attachment.colorSeed) },
			state: attachment.presence! };
	}

	private leaveFrame(sessionId: string, reason: PresenceLeaveFrame["reason"]): PresenceLeaveFrame {
		return { type: "presence.leave", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, sessionId, reason };
	}

	private socketForSession(sessionId: string): Socket | null {
		for (const socket of this.authoritativeSockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (attachment?.sessionId === sessionId) return socket;
		}
		return null;
	}

	private broadcast(value: PresenceStateFrame | PresenceLeaveFrame): void {
		for (const socket of this.authoritativeSockets()) {
			const recipient = socket.deserializeAttachment() as Attachment | null;
			if (!recipient) continue;
			if (value.type === "presence.leave" && this.options.projectSessionId) {
				const source = this.attachmentForSession(value.sessionId);
				const sessionId = source ? this.options.projectSessionId(value.sessionId, source, recipient) : value.sessionId;
				this.send(socket, JSON.stringify({ ...value, sessionId }));
			} else this.send(socket, JSON.stringify(value));
		}
	}

	private broadcastState(value: PresenceStateFrame, source: Attachment): void {
		for (const socket of this.authoritativeSockets()) {
			const recipient = socket.deserializeAttachment() as Attachment | null;
			if (!recipient) continue;
			const frame = (this.options.projectEntry
				? { ...value, presence: this.options.projectEntry(value.presence, source, recipient) }
				: value) as PresenceStateFrame | AudienceSafePresenceStateFrame;
			this.send(socket, JSON.stringify(frame));
		}
	}

	private attachmentForSession(sessionId: string): Attachment | null {
		for (const socket of this.options.sockets()) {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (attachment?.sessionId === sessionId) return attachment;
		}
		return null;
	}

	private send(socket: Socket, frame: string): boolean {
		if ((socket.bufferedAmount ?? 0) > MAX_PRESENCE_SOCKET_BUFFER_BYTES) return false;
		try { socket.send(frame); return true; } catch { return false; }
	}

	private now(): number { return this.options.now?.() ?? Date.now(); }
}
