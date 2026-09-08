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
export type YaosPublicVaultRole = "owner" | "member";
export type YaosPublicAuthorityState = "active" | "refreshing" | "changing" | "revoked" | "incompatible";

export interface YaosPublicPrincipal {
	readonly principalId: string;
	readonly displayName: string;
	readonly role: YaosPublicVaultRole;
	readonly state: "active" | "changing" | "revoking" | "revoked";
	readonly deviceCount: number;
	readonly lastSeenAt: number | null;
}

export interface YaosPublicPresence {
	readonly principalId: string;
	readonly deviceId: string;
	readonly displayName: string;
	readonly deviceName: string;
}

export interface YaosPublicOwnershipTransfer {
	readonly transferId: string;
	readonly fromPrincipalId: string;
	readonly toPrincipalId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface YaosPublicCollaboration {
	readonly authorityState: YaosPublicAuthorityState;
	readonly principalId: string | null;
	readonly displayName: string | null;
	readonly deviceId: string | null;
	readonly deviceName: string | null;
	readonly role: YaosPublicVaultRole | null;
	readonly membershipRevision: number | null;
	readonly deviceCredentialRevision: number | null;
	readonly policyVersion: number | null;
	readonly capabilities: readonly string[];
	readonly members: readonly YaosPublicPrincipal[];
	readonly presence: readonly YaosPublicPresence[];
	readonly ownershipTransfers: readonly YaosPublicOwnershipTransfer[];
	readonly preservedUnpublishedWork: number;
}

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
	readonly semanticCanvases: number;
	readonly residentCanvases: number;
	readonly pendingCanvasOperations: number;
	readonly invalidCanvases: number;
	readonly oversizedCanvases: number;
	readonly conflictCanvases: number;
	readonly degradedCanvases: number;
}

export interface YaosPublicSnapshot {
	readonly apiVersion: 0;
	readonly revision: number;
	readonly availability: YaosPublicAvailability;
	readonly collaboration: YaosPublicCollaboration;
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
