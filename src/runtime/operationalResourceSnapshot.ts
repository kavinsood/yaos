import type {
	AdmissionBackpressureReason,
	AdmissionPressureDiagnostic,
	ResidencyAdmissionSnapshot,
} from "./residencyAdmissionCoordinator";
import type { OverdueWorkDiagnostics, WorkBlockerKind, WorkPriority } from "./overdueWorkKernel";
import type { BodyResidencySnapshot } from "../sync/bodyResidencyAccounting";

export type OperationalResourcePressureSource = "admission" | "overdue" | "residency";

export interface OperationalResourcePressure {
	readonly source: OperationalResourcePressureSource;
	readonly reason: AdmissionBackpressureReason | WorkBlockerKind | "estimated_resident_budget";
	readonly observedAt: number;
	readonly actionable: boolean;
	readonly label: string;
	readonly guidance: string;
}

export interface OperationalResourceSnapshot {
	readonly capturedAt: number;
	readonly estimateClaim: "heuristic-resident-estimate-not-heap-measurement";
	readonly residency: {
		readonly estimatorVersion: string;
		readonly currentEstimatedBytes: number;
		readonly highWaterEstimatedBytes: number;
		readonly configuredBudgetBytes: number;
		readonly temporaryReservedBytes: number;
		readonly loadedBodies: number;
		readonly loadingBodies: number;
	};
	readonly queued: {
		readonly admission: Readonly<Record<"editor" | "foreground" | "background", number>> & { readonly total: number };
		readonly overdue: Readonly<Record<WorkPriority, number>> & { readonly total: number };
		readonly oldestAgeMs: number | null;
	};
	readonly blockers: {
		readonly bodyObservations: ResidencyAdmissionSnapshot["blockers"];
		readonly overdueDecisionRequired: number;
		readonly overduePermanentlyBlocked: number;
	};
	readonly sockets: ResidencyAdmissionSnapshot["sockets"];
	readonly currentPressure: OperationalResourcePressure | null;
	readonly lastPressure: OperationalResourcePressure | null;
}

export interface OperationalResourceSnapshotInput {
	readonly residency: BodyResidencySnapshot;
	readonly admission: ResidencyAdmissionSnapshot;
	readonly overdue: readonly OverdueWorkDiagnostics[];
}

function total(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0);
}

function pressureCopy(pressure: AdmissionPressureDiagnostic): OperationalResourcePressure {
	const details: Record<AdmissionBackpressureReason, Pick<OperationalResourcePressure, "actionable" | "label" | "guidance">> = {
		mobile_background: {
			actionable: false,
			label: "Background body loading paused",
			guidance: "Return Obsidian to the foreground to continue optional body loading.",
		},
		concurrent_load_limit: {
			actionable: false,
			label: "Body loads are at their concurrency limit",
			guidance: "This pressure normally clears when an active body load finishes.",
		},
		transient_cost_limit: {
			actionable: false,
			label: "Temporary body-work estimate limit reached",
			guidance: "This pressure normally clears when reconstruction or merge work finishes.",
		},
		resident_cost_limit: {
			actionable: true,
			label: "A body exceeds the configured estimate budget",
			guidance: "Reduce the note's size or fragmentation before retrying. The estimate is not RAM usage.",
		},
		protected_residency_saturation: {
			actionable: true,
			label: "Body loading is blocked by protected resident work",
			guidance: "Close inactive notes or let pending edits settle before retrying.",
		},
		socket_budget: {
			actionable: true,
			label: "Body connection limit reached",
			guidance: "Close inactive notes to release body connections, then retry.",
		},
	};
	return { source: "admission", reason: pressure.reason, observedAt: pressure.observedAt, ...details[pressure.reason] };
}

function admissionPressureStillApplies(
	pressure: AdmissionPressureDiagnostic,
	snapshot: ResidencyAdmissionSnapshot,
): boolean {
	const demand = pressure.demand;
	switch (pressure.reason) {
		case "mobile_background":
			return snapshot.context.platform === "mobile" && snapshot.context.visibility === "background";
		case "concurrent_load_limit":
			return demand.loadSlots > 0
				&& snapshot.loads.used + snapshot.loads.reserved + demand.loadSlots > snapshot.loads.limit;
		case "transient_cost_limit":
			return snapshot.transientCost.used + snapshot.transientCost.reserved + demand.transientCost > snapshot.transientCost.limit;
		case "resident_cost_limit":
			return demand.residentCost > snapshot.residentCost.limit;
		case "protected_residency_saturation":
			return total(Object.values(snapshot.blockers)) > 0
				&& snapshot.residentCost.used
					+ snapshot.residentCost.reserved
					- snapshot.residentCost.plannedRelease
					+ demand.residentCost > snapshot.residentCost.limit;
		case "socket_budget":
			return snapshot.sockets.used
				+ snapshot.sockets.reserved
				+ snapshot.sockets.fixed
				- snapshot.sockets.plannedRelease
				+ demand.socketSlots > snapshot.sockets.limit;
	}
}

function overduePressure(
	diagnostics: readonly OverdueWorkDiagnostics[],
	now: number,
): OperationalResourcePressure | null {
	const blocked = diagnostics.flatMap((entry) => entry.queue).filter((item) => item.blocker !== null);
	if (blocked.length === 0) return null;
	const kind: WorkBlockerKind = blocked.some((item) => item.blocker?.kind === "permanently_blocked")
		? "permanently_blocked"
		: "decision_required";
	const relevant = blocked.filter((item) => item.blocker?.kind === kind);
	const oldestAgeMs = Math.max(...relevant.map((item) => item.queueAgeMs));
	return kind === "permanently_blocked"
		? {
			source: "overdue",
			reason: kind,
			observedAt: now - oldestAgeMs,
			actionable: true,
			label: "Sync work is blocked",
			guidance: "Open diagnostics for the failure class and resolve the blocked operation.",
		}
		: {
			source: "overdue",
			reason: kind,
			observedAt: now - oldestAgeMs,
			actionable: true,
			label: "Sync work needs a decision",
			guidance: "Open YAOS settings to complete the pending decision.",
		};
}

function deriveCurrentPressure(
	input: OperationalResourceSnapshotInput,
	now: number,
): OperationalResourcePressure | null {
	const blocked = overduePressure(input.overdue, now);
	if (blocked) return blocked;
	const admission = input.admission.pressure?.current ?? null;
	if (admission && admissionPressureStillApplies(admission, input.admission)) return pressureCopy(admission);
	if (input.residency.totals.estimatedResidentBytes > input.residency.residentBudget.bytes) {
		return {
			source: "residency",
			reason: "estimated_resident_budget",
			observedAt: input.residency.capturedAt,
			actionable: true,
			label: "Body residency estimate exceeds its configured budget",
			guidance: "Close inactive notes and let pending edits settle. This estimate is not RAM usage.",
		};
	}
	return null;
}

function latestPressure(
	left: OperationalResourcePressure | null,
	right: OperationalResourcePressure | null,
): OperationalResourcePressure | null {
	if (!left) return right;
	if (!right) return left;
	return left.observedAt >= right.observedAt ? left : right;
}

export class OperationalResourceSnapshotTracker {
	private lastPressure: OperationalResourcePressure | null = null;
	private scopeKey: string | null = null;

	capture(
		input: OperationalResourceSnapshotInput,
		now = Date.now(),
		scopeKey = "default",
	): OperationalResourceSnapshot {
		if (scopeKey !== this.scopeKey) {
			this.scopeKey = scopeKey;
			this.lastPressure = null;
		}
		const currentPressure = deriveCurrentPressure(input, now);
		const lastAdmission = input.admission.pressure?.last
			? pressureCopy(input.admission.pressure.last)
			: null;
		this.lastPressure = latestPressure(this.lastPressure, latestPressure(currentPressure, lastAdmission));
		const admissionTotal = total(Object.values(input.admission.queue));
		const overdueQueue = input.overdue.flatMap((entry) => entry.queue);
		const overdueByPriority = {
			background: overdueQueue.filter((item) => item.priority === "background").length,
			normal: overdueQueue.filter((item) => item.priority === "normal").length,
			interactive: overdueQueue.filter((item) => item.priority === "interactive").length,
		};
		const queueAges = overdueQueue.map((item) => item.queueAgeMs);
		if (input.admission.oldestQueuedAt !== undefined && input.admission.oldestQueuedAt !== null) {
			queueAges.push(Math.max(0, now - input.admission.oldestQueuedAt));
		}
		return {
			capturedAt: now,
			estimateClaim: "heuristic-resident-estimate-not-heap-measurement",
			residency: {
				estimatorVersion: input.residency.estimatorVersion,
				currentEstimatedBytes: input.residency.totals.estimatedResidentBytes,
				highWaterEstimatedBytes: input.residency.highWater.estimatedResidentBytes,
				configuredBudgetBytes: input.residency.residentBudget.bytes,
				temporaryReservedBytes: input.residency.totals.temporaryReservedBytes,
				loadedBodies: input.residency.totals.loadedBodies,
				loadingBodies: input.residency.totals.loadingBodies,
			},
			queued: {
				admission: { ...input.admission.queue, total: admissionTotal },
				overdue: { ...overdueByPriority, total: overdueQueue.length },
				oldestAgeMs: queueAges.length > 0 ? Math.max(...queueAges) : null,
			},
			blockers: {
				bodyObservations: { ...input.admission.blockers },
				overdueDecisionRequired: overdueQueue.filter((item) => item.blocker?.kind === "decision_required").length,
				overduePermanentlyBlocked: overdueQueue.filter((item) => item.blocker?.kind === "permanently_blocked").length,
			},
			sockets: { ...input.admission.sockets },
			currentPressure,
			lastPressure: this.lastPressure,
		};
	}
}
