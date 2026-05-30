/**
 * YaosUnsafeQaPort — scenario control and unsafe mutation helpers.
 *
 * These capabilities MUST be behind qaDebugMode. They should never be
 * casually imported by sync or runtime logic. They exist only for:
 *   - QA scenario harnesses
 *   - Multi-device validation tooling
 *   - Developer debugging of specific edge cases
 *
 * Every method in this interface either:
 *   - Mutates CRDT/disk state outside normal sync flow
 *   - Controls network behavior for scenario orchestration
 *   - Advances scenario machinery (step indices, run IDs)
 *   - Pauses/resumes internal subsystems for observation
 *
 * The __qaOnly prefix convention is preserved for grep-ability.
 *
 * IMPORTANT: This interface must remain assignable from YaosQaDebugApi.
 * See the compile-time check in src/qaDebugApi.ts.
 */

export interface YaosUnsafeQaPort {
	// --- Unsafe CRDT/data mutation ---
	__qaOnlyForceCrdtContentUnsafe(
		path: string,
		content: string,
		opts: { originClass: "local" | "remote"; createIfMissing?: boolean },
	): Promise<{ beforeHash: string | null; afterHash: string | null; fileExisted: boolean }>;

	// --- Disk ingest control ---
	ingestDiskFileNow(
		path: string,
		reason?: "create" | "modify",
	): Promise<void>;

	// --- Editor binding control ---
	pauseEditorPropagation(path: string): Promise<boolean>;
	resumeEditorPropagation(path: string): Promise<boolean>;

	// --- Network control ---
	setQaNetworkHold(mode: "offline" | "online"): void;

	// --- Scenario machinery ---
	__qaOnlySetScenarioRunIdUnsafe?(scenarioRunId: string, scenarioId: string): void;
	__qaOnlyAdvanceScenarioStepUnsafe?(stepIndex: number, label?: string): void;
	__qaOnlyEmitPhaseUnsafe(phase: "setup" | "run" | "assert" | "cleanup"): Promise<void>;

	// --- Witness control ---
	__qaOnlyClearWitnessSuppressionUnsafe?(path: string): void;
	__qaOnlyTriggerWitnessDirtyUnsafe?(path: string): void;

	// --- Policy override ---
	setExternalEditPolicyOverride(
		policy: "always" | "closed-only" | "never" | null,
	): Promise<{ previous: "always" | "closed-only" | "never" }>;

	// --- Witness observation (read-only but QA-specific) ---
	witnessDeviceSettled(
		path: string,
		options: { expectedContent?: string; expectedStateHash?: string; timeoutMs: number },
	): Promise<void>;
	computeWitnessStateHash(content: string): Promise<string>;
	getDeviceId(): string;
	getWitnessBuffer?(): ReadonlyArray<unknown> | undefined;
	currentWitnessSeq?(): number;
}
