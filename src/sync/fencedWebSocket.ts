export interface TerminableWebSocket {
	readonly readyState: number;
	binaryType: BinaryType;
	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export type SocketSendData = string | ArrayBufferLike | Blob | ArrayBufferView;

/**
 * Per-socket send/receive hook. A tap owns every outgoing frame of its socket:
 * it may forward it unchanged, prefix it (relay envelopes), or hold and merge
 * it (send coalescing). `raw` returns false when the socket can no longer send.
 */
export interface SocketTap {
	send(data: SocketSendData): void;
	/** Every inbound message, before the provider's own listeners run. */
	onMessage(data: unknown): void;
	/** Last chance to send while the socket is still open (close/terminate). */
	beforeClose(): void;
	/** The socket closed or was abandoned; no further frames are delivered. */
	onClose(): void;
}
export type SocketTapFactory = (raw: (data: SocketSendData) => boolean) => SocketTap | null;

type WebSocketConstructor = new (url: string | URL, protocols?: string | string[]) => WebSocket;
export interface NativeSocketClose {
	readonly code: number;
	readonly reason: string;
}
type ExtendedWebSocket = WebSocket & {
	terminate?: () => void;
	accept?: () => void;
	serializeAttachment?: (attachment: unknown) => void;
	deserializeAttachment?: () => unknown | null;
};

function callListener(listener: EventListenerOrEventListenerObject, event: Event): void {
	if (typeof listener === "function") listener(event);
	else listener.handleEvent(event);
}

/** Fences late events and gives browser WebSockets a synchronous abandonment path. */
export function fencedWebSocketConstructor(
	Base: WebSocketConstructor,
	onNativeClose?: (event: NativeSocketClose) => void,
	tapFactory?: SocketTapFactory,
): typeof WebSocket {
	class FencedWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly CONNECTING = FencedWebSocket.CONNECTING;
		readonly OPEN = FencedWebSocket.OPEN;
		readonly CLOSING = FencedWebSocket.CLOSING;
		readonly CLOSED = FencedWebSocket.CLOSED;
		readonly url: string;
		readonly protocol = "";
		readonly extensions = "";
		bufferedAmount = 0;
		onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
		onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
		onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
		onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
		private readonly socket: ExtendedWebSocket;
		private readonly listeners = new Map<string, Map<EventListenerOrEventListenerObject, EventListener>>();
		private fenced = false;
		private readonly tap: SocketTap | null;

		constructor(url: string | URL, protocols?: string | string[]) {
			this.url = String(url);
			this.socket = new Base(url, protocols);
			this.tap = tapFactory?.((data) => this.rawSend(data)) ?? null;
			if (this.tap) {
				// Registered before any provider listener, so the tap sees a
				// control frame (VAULT_READY, BODY_COMMITTED) first.
				this.socket.addEventListener("message", (event) => {
					if (!this.fenced) this.tap?.onMessage((event as MessageEvent).data);
				});
			}
			this.socket.addEventListener("close", (event) => {
				const close = event as CloseEvent;
				this.tap?.onClose();
				onNativeClose?.({ code: close.code, reason: close.reason });
			});
		}

		private rawSend(data: SocketSendData): boolean {
			if (this.fenced || this.socket.readyState !== FencedWebSocket.OPEN) return false;
			try {
				this.socket.send(data);
				return true;
			} catch {
				return false;
			}
		}

		get readyState(): number { return this.fenced ? FencedWebSocket.CLOSED : this.socket.readyState; }
		get binaryType(): BinaryType { return this.socket.binaryType; }
		set binaryType(value: BinaryType) { this.socket.binaryType = value; }

		send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			if (this.fenced) throw new Error("WebSocket transport was superseded");
			if (this.tap) this.tap.send(data);
			else this.socket.send(data);
		}

		close(code?: number, reason?: string): void {
			if (this.fenced) return;
			this.tap?.beforeClose();
			this.socket.close(code, reason);
		}

		terminate(): void {
			if (this.fenced) return;
			this.tap?.beforeClose();
			this.fenced = true;
			this.tap?.onClose();
			const abandonmentErrorSink = (): void => undefined;
			const releaseAbandonmentSink = (): void => {
				this.socket.removeEventListener("error", abandonmentErrorSink);
			};
			this.socket.addEventListener("error", abandonmentErrorSink);
			this.socket.addEventListener("close", releaseAbandonmentSink, { once: true });
			const closeEvent = typeof CloseEvent === "function"
				? new CloseEvent("close", { code: 4000, reason: "transport superseded", wasClean: false })
				: new Event("close");
			for (const listener of this.listeners.get("close")?.keys() ?? []) callListener(listener, closeEvent);
			for (const [type, listeners] of this.listeners) {
				for (const wrapped of listeners.values()) this.socket.removeEventListener(type, wrapped);
			}
			this.listeners.clear();
			try {
				if (typeof this.socket.terminate === "function") this.socket.terminate();
				else this.socket.close(4000, "transport superseded");
			} catch { /* already abandoned */ }
		}

		addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
			const byListener = this.listeners.get(type) ?? new Map<EventListenerOrEventListenerObject, EventListener>();
			if (byListener.has(listener)) return;
			const wrapped: EventListener = (event) => {
				if (!this.fenced) callListener(listener, event);
			};
			byListener.set(listener, wrapped);
			this.listeners.set(type, byListener);
			this.socket.addEventListener(type, wrapped);
		}

		removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
			const byListener = this.listeners.get(type);
			const wrapped = byListener?.get(listener);
			if (!wrapped) return;
			this.socket.removeEventListener(type, wrapped);
			byListener!.delete(listener);
			if (byListener!.size === 0) this.listeners.delete(type);
		}

		dispatchEvent(event: Event): boolean {
			return !this.fenced && this.socket.dispatchEvent(event);
		}

		accept(): void {
			if (typeof this.socket.accept !== "function") throw new Error("WebSocket accept is unavailable");
			this.socket.accept();
		}

		serializeAttachment(attachment: unknown): void {
			if (typeof this.socket.serializeAttachment !== "function") {
				throw new Error("WebSocket attachment serialization is unavailable");
			}
			this.socket.serializeAttachment(attachment);
		}

		deserializeAttachment(): unknown | null {
			if (typeof this.socket.deserializeAttachment !== "function") {
				throw new Error("WebSocket attachment deserialization is unavailable");
			}
			return this.socket.deserializeAttachment();
		}
	}

	return FencedWebSocket;
}
