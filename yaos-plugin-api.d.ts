import type { EventRef } from "obsidian";

/**
 * YAOS's stable, data-only plugin API. Resolve it from
 * `app.plugins.plugins["yaos"]?.api`, then reacquire it whenever the
 * `yaos:api-ready` workspace event fires. Handles retained after YAOS unloads
 * throw `YaosPublicApiStaleHandleError` when called.
 */

export type YaosPublicAvailability = "starting" | "ready";
export type YaosPublicSettlementState = "unknown" | "pending" | "settled";
export type YaosPublicSettlementAgreement = "unknown" | "agreed" | "disagreed";
export type YaosPublicResidency = "absent" | "loading" | "warm" | "active" | "evicting";
export type YaosPublicProjectionOwner = "editor" | "disk" | "recovery";
export type YaosPublicSynchronization = "clean" | "locally-pending" | "durably-pending" | "catching-up";
export type YaosPublicDivergence = "none" | "evaluating" | "preserved" | "decision-required";
export type YaosPublicLifetime = "accepting" | "quiescing" | "disposed";

export interface YaosPublicBodyState {
	readonly contentRevision: number;
	readonly lifecycleRevision: number;
	readonly ownershipRevision: number;
	readonly residency: YaosPublicResidency;
	readonly projectionOwner: YaosPublicProjectionOwner | null;
	readonly synchronization: YaosPublicSynchronization;
	readonly divergence: YaosPublicDivergence;
	readonly lifetime: YaosPublicLifetime;
	readonly leaseCount: number;
}

export interface YaosPublicSettlementSummary {
	readonly state: YaosPublicSettlementState;
	readonly durableGeneration: number | null;
	readonly localSettlementRevision: number | null;
	readonly agreement: YaosPublicSettlementAgreement;
	readonly settledAt: number | null;
}

export interface YaosPublicConflictSummary {
	readonly preservedUnresolved: number;
	readonly frontmatterQuarantined: number;
}

export interface YaosPublicFileState {
	readonly path: string;
	readonly bodyId: string;
	readonly body: YaosPublicBodyState;
	readonly settlement: YaosPublicSettlementSummary;
	readonly conflicts: YaosPublicConflictSummary;
}

export interface YaosPublicCounts {
	readonly files: number;
	readonly residentBodies: number;
	readonly pendingSettlements: number;
	readonly preservedUnresolved: number;
	readonly frontmatterQuarantined: number;
}

export interface YaosPublicSnapshot {
	readonly apiVersion: 0;
	readonly revision: number;
	readonly availability: YaosPublicAvailability;
	readonly files: readonly YaosPublicFileState[];
	readonly counts: YaosPublicCounts;
}

export interface YaosPublicSnapshotEvent {
	readonly type: "snapshot";
	readonly revision: number;
	readonly snapshot: YaosPublicSnapshot;
}

export interface YaosPublicSubscription {
	readonly snapshot: YaosPublicSnapshot;
	unsubscribe(): void;
}

export interface YaosPublicApiV0 {
	getSnapshot(): YaosPublicSnapshot;
	subscribe(listener: (event: YaosPublicSnapshotEvent) => void): YaosPublicSubscription;
	getFile(path: string): YaosPublicFileState | null;
	getFileByBodyId(bodyId: string): YaosPublicFileState | null;
}

export interface YaosPublicApi {
	readonly v0: YaosPublicApiV0;
}

export type YaosApi = YaosPublicApi;

export class YaosPublicApiStaleHandleError extends Error {}

declare module "obsidian" {
	interface Workspace {
		on(name: "yaos:api-ready", callback: () => void): EventRef;
		trigger(name: "yaos:api-ready"): void;
	}
}
