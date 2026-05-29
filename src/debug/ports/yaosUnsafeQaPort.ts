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
 */

export interface YaosUnsafeQaPort {
	// --- Unsafe CRDT/data mutation ---
	__qaOnlyForceCrdtContentUnsafe(
		path: string,
		content: string,
		opts?: { reason?: string },
	): Promise<{ beforeHash: string | null; afterHash: string; fileExisted: boolean }>;

	__qaOnlyForceSyncFileFromDiskUnsafe(
		path: string,
		reason?: string,
	): Promise<void>;

	// --- Editor binding control ---
	__qaOnlyPauseEditorBindingPropagationUnsafe(path: string): Promise<boolean>;
	__qaOnlyResumeEditorBindingPropagationUnsafe(path: string): Promise<boolean>;

	// --- Network control ---
	setQaNetworkHold(mode: "offline" | "online"): void;

	// --- Scenario machinery ---
	__qaOnlySetScenarioRunIdUnsafe(scenarioRunId: string, scenarioId: string): void;
	__qaOnlyAdvanceScenarioStepUnsafe(stepIndex: number, label?: string): void;
	__qaOnlyEmitPhaseUnsafe(phase: "setup" | "run" | "assert" | "cleanup"): Promise<void>;

	// --- Witness control ---
	__qaOnlyClearWitnessSuppressionUnsafe?(path: string): void;
	__qaOnlyTriggerWitnessDirtyUnsafe?(path: string): void;

	// --- Policy override ---
	__qaOnlySetExternalEditPolicyOverrideUnsafe(
		policy: "always" | "open-file" | "never" | null,
	): Promise<{ previous: string | null }>;

	// --- Witness observation (read-only but QA-specific) ---
	witnessDeviceSettled(
		path: string,
		options: { expectedContent?: string; expectedStateHash?: string; timeoutMs: number },
	): Promise<void>;
	computeWitnessStateHash(content: string): Promise<string>;
	getDeviceId(): string;
	getWitnessBuffer?(): readonly unknown[];
	currentWitnessSeq?(): number;
}
