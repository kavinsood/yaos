import {
	RuntimeScope,
	type Lease,
	type OperationEpoch,
	type RuntimeDrainReport,
} from "./operationLifecycle";

export interface TeardownStage {
	name: string;
	run: () => void | Promise<void>;
}

export interface TeardownStageFailure {
	stage: string;
	error: unknown;
}

/**
 * Reports every stage failure only after every registered cleanup stage has
 * had a chance to run. Callers can log each failure as it happens and still
 * receive one rejected promise once orderly cleanup is exhausted.
 */
export class TeardownStagesError extends Error {
	constructor(readonly failures: readonly TeardownStageFailure[]) {
		super(`Teardown completed with ${failures.length} failed stage${failures.length === 1 ? "" : "s"}`);
		this.name = "TeardownStagesError";
	}
}

export async function runTeardownStages(
	stages: readonly TeardownStage[],
	reportFailure: (failure: TeardownStageFailure) => void,
): Promise<void> {
	const failures: TeardownStageFailure[] = [];
	for (const stage of stages) {
		try {
			await stage.run();
		} catch (error) {
			const failure = { stage: stage.name, error };
			failures.push(failure);
			reportFailure(failure);
		}
	}
	if (failures.length > 0) throw new TeardownStagesError(failures);
}

/**
 * Serializes a runtime teardown and invalidates initialization continuations
 * as soon as closing begins. The completed promise stays retained until a
 * deliberate in-process restart reopens the lifecycle.
 */
export class RuntimeTeardownCoordinator {
	private teardownPromise: Promise<void> | null = null;
	private teardownSettled = false;
	private closing = false;
	private permanentlyShutdown = false;
	private generation = 0;
	private scope = new RuntimeScope();

	get isClosing(): boolean {
		return this.closing;
	}

	requestPermanentShutdown(): void {
		this.permanentlyShutdown = true;
		this.closing = true;
		this.generation++;
		this.scope.stopAdmission();
	}

	beginTeardown(run: () => Promise<void>): Promise<void> {
		if (this.teardownPromise) return this.teardownPromise;
		this.closing = true;
		this.generation++;
		this.scope.stopAdmission();
		const teardownPromise = run();
		this.teardownPromise = teardownPromise;
		this.teardownSettled = false;
		void teardownPromise.then(
			() => {
				if (this.teardownPromise === teardownPromise) this.teardownSettled = true;
			},
			() => {
				if (this.teardownPromise === teardownPromise) this.teardownSettled = true;
			},
		);
		return teardownPromise;
	}

	beginInitialization(): number | null {
		if (this.closing || this.permanentlyShutdown) return null;
		return this.generation;
	}

	isInitializationCurrent(generation: number): boolean {
		return !this.closing && !this.permanentlyShutdown && this.generation === generation;
	}

	captureOperationEpoch(): OperationEpoch | null {
		return this.scope.captureEpoch();
	}

	acquireLease(label: string): Lease | null {
		return this.scope.acquireLease(label);
	}

	track<T>(label: string, work: Promise<T>): Promise<T> {
		return this.scope.track(label, work);
	}

	drain(timeoutMs: number): Promise<RuntimeDrainReport> {
		return this.scope.drain(timeoutMs);
	}

	/** Reopen only after an awaited, intentional in-process reset. */
	reopenAfterTeardown(): boolean {
		if (this.permanentlyShutdown || !this.teardownPromise || !this.teardownSettled) return false;
		this.teardownPromise = null;
		this.teardownSettled = false;
		this.closing = false;
		this.generation++;
		this.scope = new RuntimeScope();
		return true;
	}
}
