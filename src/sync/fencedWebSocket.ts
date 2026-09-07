export interface TerminableWebSocket {
	readonly readyState: number;
	binaryType: BinaryType;
	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

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

		constructor(url: string | URL, protocols?: string | string[]) {
			this.url = String(url);
			this.socket = new Base(url, protocols);
			this.socket.addEventListener("close", (event) => {
				const close = event as CloseEvent;
				onNativeClose?.({ code: close.code, reason: close.reason });
			});
		}

		get readyState(): number { return this.fenced ? FencedWebSocket.CLOSED : this.socket.readyState; }
		get binaryType(): BinaryType { return this.socket.binaryType; }
		set binaryType(value: BinaryType) { this.socket.binaryType = value; }

		send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			if (this.fenced) throw new Error("WebSocket transport was superseded");
			this.socket.send(data);
		}

		close(code?: number, reason?: string): void {
			if (!this.fenced) this.socket.close(code, reason);
		}

		terminate(): void {
			if (this.fenced) return;
			this.fenced = true;
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
