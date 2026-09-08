export const RECOVERY_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

export interface RecoveryMemorySnapshot {
	readonly ceilingBytes: number;
	readonly reservedBytes: number;
	readonly highWaterBytes: number;
	readonly denials: number;
	readonly owners: ReadonlyArray<{ owner: string; bytes: number }>;
}

export class RecoveryMemoryPressureError extends Error {
	readonly code = "recovery_memory_pressure";
	constructor(readonly requestedBytes: number, readonly availableBytes: number) {
		super(`recovery memory pressure: requested ${requestedBytes} bytes with ${availableBytes} available`);
	}
}

export class RecoveryMemoryOperationTooLargeError extends Error {
	readonly code = "recovery_memory_operation_too_large";
	constructor(readonly requestedBytes: number, readonly ceilingBytes: number) {
		super(`recovery operation requires ${requestedBytes} bytes, exceeding the ${ceilingBytes}-byte budget`);
	}
}

export interface RecoveryMemoryLease {
	readonly owner: string;
	readonly bytes: number;
	release(): void;
}

/** Per-RecoveryJob transient allocation budget. Durable data-size limits remain separate. */
export class RecoveryMemoryBudget {
	private reserved = 0;
	private highWater = 0;
	private denialCount = 0;
	private nextLease = 1;
	private readonly active = new Map<number, { owner: string; bytes: number }>();

	constructor(readonly ceilingBytes = RECOVERY_MEMORY_BUDGET_BYTES) {
		if (!Number.isSafeInteger(ceilingBytes) || ceilingBytes <= 0) throw new Error("invalid recovery memory ceiling");
	}

	reserve(owner: string, bytes: number): RecoveryMemoryLease {
		if (!owner || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid recovery memory reservation");
		if (bytes > this.ceilingBytes) {
			this.denialCount++;
			throw new RecoveryMemoryOperationTooLargeError(bytes, this.ceilingBytes);
		}
		const available = this.ceilingBytes - this.reserved;
		if (bytes > available) {
			this.denialCount++;
			throw new RecoveryMemoryPressureError(bytes, available);
		}
		const id = this.nextLease++;
		this.active.set(id, { owner, bytes });
		this.reserved += bytes;
		this.highWater = Math.max(this.highWater, this.reserved);
		let released = false;
		return {
			owner,
			bytes,
			release: () => {
				if (released) return;
				released = true;
				const lease = this.active.get(id);
				if (!lease) return;
				this.active.delete(id);
				this.reserved -= lease.bytes;
			},
		};
	}

	snapshot(): RecoveryMemorySnapshot {
		const byOwner = new Map<string, number>();
		for (const lease of this.active.values()) byOwner.set(lease.owner, (byOwner.get(lease.owner) ?? 0) + lease.bytes);
		return {
			ceilingBytes: this.ceilingBytes,
			reservedBytes: this.reserved,
			highWaterBytes: this.highWater,
			denials: this.denialCount,
			owners: [...byOwner].map(([owner, bytes]) => ({ owner, bytes })),
		};
	}
}

export function reconstructionReservationBytes(input: {
	expectedHistoryBytes: number;
	stagingBytes: number;
	bufferedPartBytes: number;
	nextChunkBytes: number;
	expectedContentBytes: number;
}): number {
	for (const value of Object.values(input)) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid reconstruction memory estimate");
	}
	const saturatedMultiply = (value: number, factor: number): number =>
		value > Math.floor(Number.MAX_SAFE_INTEGER / factor) ? Number.MAX_SAFE_INTEGER : value * factor;
	const saturatedAdd = (...values: number[]): number => {
		let total = 0;
		for (const value of values) {
			if (value > Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
			total += value;
		}
		return total;
	};
	// Yjs state, an exact assembly/staging encoding, semantic materialization, RPC bytes, and allocator slack.
	return Math.max(
		8 * 1024 * 1024,
		saturatedAdd(
			saturatedMultiply(Math.max(
				input.expectedHistoryBytes,
				saturatedAdd(input.stagingBytes, input.bufferedPartBytes),
			), 2),
			saturatedMultiply(input.nextChunkBytes, 2),
			saturatedMultiply(input.expectedContentBytes, 4),
			4 * 1024 * 1024,
		),
	);
}
