export const SCHEMA_VERSION = 4 as const;
export const STORAGE_FORMAT_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;
export const SNAPSHOT_FORMAT_VERSION = 2 as const;
export const SETTINGS_FORMAT_VERSION = 1 as const;

export type RuntimeName = "wrangler" | "node";

export const ALL_CAPABILITIES = [
	"capabilities", "routing", "identity", "admission", "root-body", "bootstrap",
	"durability", "settings", "attachments", "recovery", "recovery-crash-resume",
	"deletion", "awareness", "restart",
] as const;
export type Capability = typeof ALL_CAPABILITIES[number];

export interface DeviceIdentity {
	readonly host: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly deviceId: string;
	readonly deviceToken: string;
}

export interface EnrollmentReplay {
	readonly pairingCode: string;
	readonly enrollmentRequestId: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly deviceName: string;
}

export interface ConformanceTarget {
	/** Diagnostic label only. Fixtures must never branch on this value. */
	readonly runtime: RuntimeName;
	readonly baseUrl: string;
	readonly controlUrl: string;
	readonly capabilities: ReadonlySet<Capability>;
	readonly deviceA: DeviceIdentity;
	readonly deviceB: DeviceIdentity;
	readonly operatorRecoveryKey: string;
	readonly operatorCookie: string;
	readonly originEnrollment: EnrollmentReplay;
}

export const TARGET_ENV = "YAOS_CONFORMANCE_TARGET";

export function targetFromEnv(): ConformanceTarget {
	const raw = process.env[TARGET_ENV];
	if (!raw) throw new Error(`${TARGET_ENV} is required; run fixtures through run-conformance.ts`);
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${TARGET_ENV} is invalid`);
	const target = value as Partial<Omit<ConformanceTarget, "capabilities">> & { capabilities?: unknown };
	if ((target.runtime !== "wrangler" && target.runtime !== "node")
		|| typeof target.baseUrl !== "string" || typeof target.controlUrl !== "string"
		|| !Array.isArray(target.capabilities)) throw new Error(`${TARGET_ENV} is invalid`);
	const capabilities = new Set<Capability>();
	for (const capability of target.capabilities) {
		if (typeof capability !== "string" || !(ALL_CAPABILITIES as readonly string[]).includes(capability)) {
			throw new Error(`unknown conformance capability ${JSON.stringify(capability)}`);
		}
		capabilities.add(capability as Capability);
	}
	return { ...(target as Omit<ConformanceTarget, "capabilities">), capabilities };
}

export function requireCapabilities(target: ConformanceTarget, required: readonly Capability[]): void {
	const missing = required.filter((capability) => !target.capabilities.has(capability));
	if (missing.length > 0) throw new Error(`target did not declare required capabilities: ${missing.join(", ")}`);
}
