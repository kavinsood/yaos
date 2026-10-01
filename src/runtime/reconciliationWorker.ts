interface QueuedWork {
	execute(): Promise<void>;
	cancel(error: Error): void;
	retainedBytes: number;
	label: string;
}

export class ReconciliationBackpressureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReconciliationBackpressureError";
	}
}

export class ReconciliationIoTimeoutError extends Error {
	constructor(readonly operation: string, readonly timeoutMs: number) {
		super(`Reconciliation operation ${operation} exceeded ${timeoutMs}ms; sync is paused until outstanding work settles and recovery restarts`);
		this.name = "ReconciliationIoTimeoutError";
	}
}

export function reconciliationRetainedBytes(...texts: Array<string | null | undefined>): number {
	return texts.reduce<number>((total, text) => total + (text?.length ?? 0) * 2, 0);
}

export class ReconciliationWorker {
	private readonly queue: QueuedWork[] = [];
	private readonly idleWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
	private active = false;
	private retainedBytes = 0;
	private pendingIo = 0;
	private stoppedError: ReconciliationIoTimeoutError | null = null;
	private activeReject: ((error: Error) => void) | null = null;
	private activeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
	private activeLabel = "filesystem work";
	private activeDeadline = Infinity;
	private stallHandler: ((error: ReconciliationIoTimeoutError) => void) | undefined;
	private readonly maximumQueued: number;
	private readonly maximumRetainedBytes: number;
	private readonly ioTimeoutMs: number;
	private readonly monotonicNow: () => number;

	constructor(options: { maximumQueued?: number; maximumRetainedBytes?: number; ioTimeoutMs?: number; monotonicNow?: () => number } = {}) {
		this.maximumQueued = options.maximumQueued ?? 64;
		this.maximumRetainedBytes = options.maximumRetainedBytes ?? 32 * 1024 * 1024;
		this.ioTimeoutMs = options.ioTimeoutMs ?? 30_000;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		if (!Number.isSafeInteger(this.maximumQueued) || this.maximumQueued < 1
			|| !Number.isSafeInteger(this.maximumRetainedBytes) || this.maximumRetainedBytes < 1
			|| !Number.isFinite(this.ioTimeoutMs) || this.ioTimeoutMs <= 0) {
			throw new Error("Invalid reconciliation worker limits");
		}
	}

	get isOperational(): boolean {
		return this.stoppedError === null;
	}

	setStallHandler(handler: (error: ReconciliationIoTimeoutError) => void): void {
		this.stallHandler = handler;
	}

	run<Result>(execute: () => Promise<Result>, options: { retainedBytes?: number; label?: string } = {}): Promise<Result> {
		if (this.stoppedError) return Promise.reject(this.stoppedError);
		const retainedBytes = options.retainedBytes ?? 0;
		if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) return Promise.reject(new Error("Invalid retained payload size"));
		if (this.queue.length >= this.maximumQueued || retainedBytes > this.maximumRetainedBytes - this.retainedBytes) {
			return Promise.reject(new ReconciliationBackpressureError(`Reconciliation admission limit reached${options.label ? ` for ${options.label}` : ""}`));
		}
		const result = new Promise<Result>((resolve, reject) => {
			this.retainedBytes += retainedBytes;
			this.queue.push({
				execute: () => {
					this.activeReject = reject;
					return Promise.resolve().then(execute).then((value) => {
						if (this.monotonicNow() >= this.activeDeadline) this.stop(new ReconciliationIoTimeoutError(this.activeLabel, this.ioTimeoutMs));
						if (this.stoppedError) reject(this.stoppedError);
						else resolve(value);
					}, (error: unknown) => {
						if (this.monotonicNow() >= this.activeDeadline) this.stop(new ReconciliationIoTimeoutError(this.activeLabel, this.ioTimeoutMs));
						reject(this.stoppedError ?? (error instanceof Error ? error : new Error(String(error))));
					});
				},
				cancel: reject,
				retainedBytes,
				label: options.label ?? "filesystem work",
			});
		});
		this.drain();
		return result;
	}

	reset(): void {
		this.cancelQueued(new DOMException("Reconciliation work was cancelled", "AbortError"));
		if (!this.active && this.pendingIo === 0) this.stoppedError = null;
		this.resolveIdle();
	}

	whenIdle(): Promise<void> {
		if (this.stoppedError) return Promise.reject(this.stoppedError);
		if (!this.active && this.pendingIo === 0 && this.queue.length === 0) return Promise.resolve();
		if (this.idleWaiters.length >= this.maximumQueued) return Promise.reject(new ReconciliationBackpressureError("Too many reconciliation idle waiters"));
		return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
	}

	diagnostics(): { active: number; queued: number } {
		return { active: Number(this.active || this.pendingIo > 0), queued: this.queue.length };
	}

	health(): { stopped: boolean; retainedBytes: number; pendingIo: number; idleWaiters: number } {
		return { stopped: this.stoppedError !== null, retainedBytes: this.retainedBytes, pendingIo: this.pendingIo, idleWaiters: this.idleWaiters.length };
	}

	io<Result>(operation: string, execute: () => Promise<Result>): Promise<Result> {
		if (this.active && this.monotonicNow() >= this.activeDeadline) this.stop(new ReconciliationIoTimeoutError(this.activeLabel, this.ioTimeoutMs));
		if (this.stoppedError) return Promise.reject(this.stoppedError);
		if (this.pendingIo > 0) return Promise.reject(new ReconciliationBackpressureError("Another reconciliation filesystem operation is still outstanding"));
		this.clearActiveTimer();
		this.pendingIo++;
		const deadline = this.monotonicNow() + this.ioTimeoutMs;
		return new Promise<Result>((resolve, reject) => {
			let timedOut = false;
			const timeout = (): void => {
				timedOut = true;
				const error = new ReconciliationIoTimeoutError(operation, this.ioTimeoutMs);
				this.stop(error);
				reject(error);
			};
			const timer = globalThis.setTimeout(timeout, this.ioTimeoutMs);
			const settle = (): void => {
				globalThis.clearTimeout(timer);
				if (!timedOut && this.monotonicNow() >= deadline) timeout();
				this.pendingIo--;
				if (this.active && !this.stoppedError) this.armActiveTimer();
				this.drain();
				this.resolveIdle();
			};
			void Promise.resolve().then(execute).then((value) => {
				settle();
				if (!timedOut) resolve(value);
			}, (error: unknown) => {
				settle();
				if (!timedOut) reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private drain(): void {
		if (this.active || this.pendingIo > 0 || this.stoppedError) return;
		const work = this.queue.shift();
		if (!work) {
			this.resolveIdle();
			return;
		}
		this.active = true;
		this.activeLabel = work.label;
		this.armActiveTimer();
		void work.execute().finally(() => {
			this.clearActiveTimer();
			this.retainedBytes -= work.retainedBytes;
			this.activeReject = null;
			this.active = false;
			this.drain();
			this.resolveIdle();
		});
	}

	private armActiveTimer(): void {
		this.clearActiveTimer();
		this.activeDeadline = this.monotonicNow() + this.ioTimeoutMs;
		this.activeTimer = globalThis.setTimeout(() => {
			this.stop(new ReconciliationIoTimeoutError(this.activeLabel, this.ioTimeoutMs));
		}, this.ioTimeoutMs);
	}

	private clearActiveTimer(): void {
		if (this.activeTimer !== null) globalThis.clearTimeout(this.activeTimer);
		this.activeTimer = null;
		this.activeDeadline = Infinity;
	}

	private stop(error: ReconciliationIoTimeoutError): void {
		if (this.stoppedError) return;
		this.clearActiveTimer();
		this.stoppedError = error;
		this.cancelQueued(error);
		this.activeReject?.(error);
		for (const waiter of this.idleWaiters.splice(0)) waiter.reject(error);
		try { this.stallHandler?.(error); } catch { return; }
	}

	private cancelQueued(error: Error): void {
		for (const work of this.queue.splice(0)) {
			this.retainedBytes -= work.retainedBytes;
			work.cancel(error);
		}
	}

	private resolveIdle(): void {
		if (this.active || this.pendingIo > 0 || this.queue.length > 0) return;
		for (const waiter of this.idleWaiters.splice(0)) waiter.resolve();
	}
}
