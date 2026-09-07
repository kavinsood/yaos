export type FailureClass =
	| "network"
	| "rate_limited"
	| "unauthorized"
	| "revoked"
	| "incompatible_protocol"
	| "malformed_response"
	| "local_persistence"
	| "internal";

export type OperationOutcome<T = void> =
	| { kind: "completed"; value: T }
	| { kind: "cancelled" }
	| { kind: "superseded" }
	| { kind: "durably_pending" }
	| { kind: "retryable_failure"; failure: FailureClass; retryAfterMs?: number }
	| { kind: "permanently_blocked"; failure: FailureClass }
	| { kind: "decision_required"; failure: FailureClass };

export interface OperationEpoch {
	readonly value: number;
	isCurrent(): boolean;
}

export interface Lease {
	readonly label: string;
	readonly released: boolean;
	release(): void;
}

export interface RuntimeDrainReport {
	readonly completed: boolean;
	readonly unfinishedWork: readonly string[];
	readonly activeLeases: readonly string[];
}

interface TrackedWork {
	readonly label: string;
	readonly settled: Promise<void>;
}

/**
 * A small lifetime boundary for asynchronous runtimes. Stopping rotates the
 * publication epoch synchronously; draining only waits for work which was
 * already admitted and never restores publication rights.
 */
export class RuntimeScope {
	private accepting = true;
	private generation = 0;
	private leaseSequence = 0;
	private readonly leases = new Map<number, string>();
	private readonly work = new Set<TrackedWork>();

	get isAccepting(): boolean {
		return this.accepting;
	}

	captureEpoch(): OperationEpoch | null {
		if (!this.accepting) return null;
		const value = this.generation;
		return {
			value,
			isCurrent: () => this.accepting && this.generation === value,
		};
	}

	acquireLease(label: string): Lease | null {
		if (!this.accepting) return null;
		const leaseId = ++this.leaseSequence;
		this.leases.set(leaseId, label);
		let released = false;
		return {
			label,
			get released() { return released; },
			release: () => {
				if (released) return;
				released = true;
				this.leases.delete(leaseId);
			},
		};
	}

	track<T>(label: string, promise: Promise<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new Error("runtime scope is not accepting work"));
		let tracked!: TrackedWork;
		const settled = promise.then(
			() => undefined,
			() => undefined,
		).finally(() => this.work.delete(tracked));
		tracked = { label, settled };
		this.work.add(tracked);
		return promise;
	}

	stopAdmission(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.generation++;
	}

	async drain(timeoutMs: number): Promise<RuntimeDrainReport> {
		this.stopAdmission();
		const snapshot = [...this.work];
		if (snapshot.length > 0 && timeoutMs > 0) {
			let timer: number | null = null;
			await Promise.race([
				Promise.all(snapshot.map((entry) => entry.settled)),
				new Promise<void>((resolve) => {
					timer = window.setTimeout(resolve, timeoutMs);
				}),
			]);
			if (timer !== null) window.clearTimeout(timer);
		}
		return {
			completed: this.work.size === 0 && this.leases.size === 0,
			unfinishedWork: [...this.work].map((entry) => entry.label),
			activeLeases: [...this.leases.values()],
		};
	}
}
