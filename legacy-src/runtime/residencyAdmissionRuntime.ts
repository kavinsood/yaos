import {
	ResidencyAdmissionCoordinator,
	type AdmissionBackpressureReason,
	type AdmissionRequestInput,
	type AdmissionReservation,
} from "./residencyAdmissionCoordinator";

export class ResidencyAdmissionBackpressureError extends Error {
	constructor(
		readonly bodyId: string,
		readonly reason: AdmissionBackpressureReason,
	) {
		super(`body admission backpressured for ${bodyId}: ${reason}`);
		this.name = "ResidencyAdmissionBackpressureError";
	}
}

export interface ResidencyAdmissionRuntimeDeps {
	readonly coordinator: ResidencyAdmissionCoordinator;
	readonly now: () => number;
	refreshObservations(): void;
	prepare(reservation: AdmissionReservation): Promise<void>;
	onBackpressure?(bodyId: string, reason: AdmissionBackpressureReason): void;
}

interface PendingAdmission<T> {
	readonly execute: () => Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

interface PendingAdmissionGroup {
	readonly waiters: PendingAdmission<unknown>[];
}

interface ActiveAdmissionGroup extends PendingAdmissionGroup {
	readonly reservation: AdmissionReservation;
}

/** Executes pure residency decisions without letting callers bypass reservations. */
export class ResidencyAdmissionRuntime {
	private readonly pending = new Map<string, PendingAdmissionGroup>();
	private readonly activeByBody = new Map<string, ActiveAdmissionGroup>();
	private dispatching = false;
	private dispatchAgain = false;
	private stopped = false;

	constructor(private readonly deps: ResidencyAdmissionRuntimeDeps) {}

	run<T>(input: Omit<AdmissionRequestInput, "requestedAt">, execute: () => Promise<T>): Promise<T> {
		if (this.stopped) return Promise.reject(new Error("residency admission is stopped"));
		const result = new Promise<T>((resolve, reject) => {
			const pending: PendingAdmission<unknown> = {
				execute,
				resolve: resolve as (value: unknown) => void,
				reject,
			};
			const active = this.activeByBody.get(input.bodyId);
			if (active && this.reservationCovers(active.reservation, input)) {
				active.waiters.push(pending);
				return;
			}
			const request = this.deps.coordinator.request({ ...input, requestedAt: this.deps.now() });
			const group = this.pending.get(request.requestId) ?? { waiters: [] };
			group.waiters.push(pending);
			this.pending.set(request.requestId, group);
		});
		this.poke();
		return result;
	}

	poke(): void {
		if (this.stopped) return;
		if (this.dispatching) {
			this.dispatchAgain = true;
			return;
		}
		void this.dispatch();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const [requestId, group] of this.pending) {
			this.deps.coordinator.cancelRequest(requestId);
			for (const pending of group.waiters) pending.reject(new Error("residency admission stopped"));
		}
		this.pending.clear();
	}

	private async dispatch(): Promise<void> {
		if (this.dispatching || this.stopped) return;
		this.dispatching = true;
		try {
			do {
				this.dispatchAgain = false;
				this.deps.refreshObservations();
				while (!this.stopped) {
					const decision = this.deps.coordinator.decideNext(this.deps.now());
					if (decision.kind === "idle") break;
					if (decision.kind === "backpressure") {
						if (decision.reason === "mobile_background") break;
						const snapshot = this.deps.coordinator.snapshot();
						const mayProgressAfterActiveWork = decision.reason === "concurrent_load_limit"
							|| decision.reason === "transient_cost_limit";
						if (mayProgressAfterActiveWork && snapshot.reservations > 0) break;
						this.deps.coordinator.cancelRequest(decision.request.requestId);
						const group = this.pending.get(decision.request.requestId);
						this.pending.delete(decision.request.requestId);
						this.deps.onBackpressure?.(decision.request.bodyId, decision.reason);
						for (const pending of group?.waiters ?? []) {
							pending.reject(new ResidencyAdmissionBackpressureError(
								decision.request.bodyId,
								decision.reason,
							));
						}
						continue;
					}
					const group = this.pending.get(decision.reservation.request.requestId);
					this.pending.delete(decision.reservation.request.requestId);
					if (!group) {
						this.deps.coordinator.settle(decision.reservation.reservationId);
						continue;
					}
					const active = { reservation: decision.reservation, waiters: group.waiters };
					this.activeByBody.set(decision.reservation.request.bodyId, active);
					void this.execute(active);
				}
			} while (this.dispatchAgain && !this.stopped);
		} finally {
			this.dispatching = false;
			if (this.dispatchAgain && !this.stopped) this.poke();
		}
	}

	private async execute(active: ActiveAdmissionGroup): Promise<void> {
		const { reservation } = active;
		try {
			await this.deps.prepare(reservation);
			for (let index = 0; index < active.waiters.length; index++) {
				const pending = active.waiters[index]!;
				try {
					pending.resolve(await pending.execute());
				} catch (error) {
					pending.reject(error);
				}
			}
		} catch (error) {
			for (const pending of active.waiters) pending.reject(error);
		} finally {
			if (this.activeByBody.get(reservation.request.bodyId) === active) {
				this.activeByBody.delete(reservation.request.bodyId);
			}
			this.deps.coordinator.settle(reservation.reservationId);
			this.poke();
		}
	}

	private reservationCovers(
		reservation: AdmissionReservation,
		input: Omit<AdmissionRequestInput, "requestedAt">,
	): boolean {
		const request = reservation.request;
		return (!input.needsLoad || (
			request.needsLoad
			&& request.residentCost >= input.residentCost
		))
			&& request.transientCost >= input.transientCost
			&& (!input.needsSocket || request.needsSocket)
			&& (input.finalPopulation !== "active" || request.finalPopulation === "active");
	}
}
