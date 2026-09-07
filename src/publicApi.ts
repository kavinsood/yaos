/**
 * The intentionally small, data-only boundary exposed to other Obsidian
 * plugins. Runtime code owns projecting internal state into these types; this
 * module never accepts or returns a live YAOS runtime object.
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
}

/** The snapshot supplied by YAOS's runtime projection, before API metadata. */
export interface YaosPublicSnapshotInput {
	readonly availability: YaosPublicAvailability;
	readonly collaboration?: YaosPublicCollaboration;
	readonly files: readonly YaosPublicFileState[];
	readonly counts: YaosPublicCounts;
}

export interface YaosPublicSnapshot extends Omit<YaosPublicSnapshotInput, "collaboration"> {
	readonly apiVersion: 0;
	readonly revision: number;
	readonly collaboration: YaosPublicCollaboration;
}

export interface YaosPublicSnapshotEvent {
	readonly type: "snapshot";
	readonly revision: number;
	readonly snapshot: YaosPublicSnapshot;
}

export interface YaosPublicSubscription {
	/** A snapshot captured after this listener became eligible for future events. */
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

/** Compatibility-friendly short name for consumers of the declaration file. */
export type YaosApi = YaosPublicApi;

export class YaosPublicApiStaleHandleError extends Error {
	constructor() {
		super("YAOS's public API handle belongs to an unloaded plugin instance; reacquire it after yaos:api-ready.");
		this.name = "YaosPublicApiStaleHandleError";
	}
}

interface SubscriptionRecord {
	readonly listener: (event: YaosPublicSnapshotEvent) => void;
	active: boolean;
}

function copyBody(body: YaosPublicBodyState): YaosPublicBodyState {
	return Object.freeze({
		contentRevision: body.contentRevision,
		lifecycleRevision: body.lifecycleRevision,
		ownershipRevision: body.ownershipRevision,
		residency: body.residency,
		projectionOwner: body.projectionOwner,
		synchronization: body.synchronization,
		divergence: body.divergence,
		lifetime: body.lifetime,
		leaseCount: body.leaseCount,
	});
}

function copySettlement(settlement: YaosPublicSettlementSummary): YaosPublicSettlementSummary {
	return Object.freeze({
		state: settlement.state,
		durableGeneration: settlement.durableGeneration,
		localSettlementRevision: settlement.localSettlementRevision,
		agreement: settlement.agreement,
		settledAt: settlement.settledAt,
	});
}

function copyConflicts(conflicts: YaosPublicConflictSummary): YaosPublicConflictSummary {
	return Object.freeze({
		preservedUnresolved: conflicts.preservedUnresolved,
		frontmatterQuarantined: conflicts.frontmatterQuarantined,
	});
}

function copyFile(file: YaosPublicFileState): YaosPublicFileState {
	return Object.freeze({
		path: file.path,
		bodyId: file.bodyId,
		body: copyBody(file.body),
		settlement: copySettlement(file.settlement),
		conflicts: copyConflicts(file.conflicts),
	});
}

function copyCounts(counts: YaosPublicCounts): YaosPublicCounts {
	return Object.freeze({
		files: counts.files,
		residentBodies: counts.residentBodies,
		pendingSettlements: counts.pendingSettlements,
		preservedUnresolved: counts.preservedUnresolved,
		frontmatterQuarantined: counts.frontmatterQuarantined,
	});
}

function copyCollaboration(collaboration: YaosPublicCollaboration): YaosPublicCollaboration {
	return Object.freeze({
		authorityState: collaboration.authorityState,
		principalId: collaboration.principalId,
		displayName: collaboration.displayName,
		deviceId: collaboration.deviceId,
		deviceName: collaboration.deviceName,
		role: collaboration.role,
		membershipRevision: collaboration.membershipRevision,
		deviceCredentialRevision: collaboration.deviceCredentialRevision,
		policyVersion: collaboration.policyVersion,
		capabilities: Object.freeze([...collaboration.capabilities]),
		members: Object.freeze(collaboration.members.map((member) => Object.freeze({ ...member }))),
		presence: Object.freeze(collaboration.presence.map((instance) => Object.freeze({ ...instance }))),
		ownershipTransfers: Object.freeze(collaboration.ownershipTransfers.map((transfer) => Object.freeze({ ...transfer }))),
		preservedUnpublishedWork: collaboration.preservedUnpublishedWork,
	});
}

function snapshotCopy(input: YaosPublicSnapshotInput, revision: number): YaosPublicSnapshot {
	return Object.freeze({
		apiVersion: 0 as const,
		revision,
		availability: input.availability,
		collaboration: copyCollaboration(input.collaboration ?? {
			authorityState: "refreshing",
			principalId: null,
			displayName: null,
			deviceId: null,
			deviceName: null,
			role: null,
			membershipRevision: null,
			deviceCredentialRevision: null,
			policyVersion: null,
			capabilities: [],
			members: [],
			presence: [],
			ownershipTransfers: [],
			preservedUnpublishedWork: 0,
		}),
		files: Object.freeze(input.files.map(copyFile)),
		counts: copyCounts(input.counts),
	});
}

/**
 * Owns a single plugin instance's public state. A replacement plugin instance
 * must create a replacement service, which makes retained API handles fail
 * instead of accidentally observing a different YAOS lifetime.
 */
export class YaosPublicApiService {
	readonly api: YaosPublicApi;
	private snapshot: YaosPublicSnapshot;
	private readonly subscriptions = new Set<SubscriptionRecord>();
	private disposed = false;

	constructor(initial: YaosPublicSnapshotInput) {
		this.snapshot = snapshotCopy(initial, 0);
		this.api = Object.freeze({
			v0: Object.freeze({
				getSnapshot: (): YaosPublicSnapshot => this.readSnapshot(),
				subscribe: (listener: (event: YaosPublicSnapshotEvent) => void): YaosPublicSubscription => this.subscribe(listener),
				getFile: (path: string): YaosPublicFileState | null => this.getFile(path),
				getFileByBodyId: (bodyId: string): YaosPublicFileState | null => this.getFileByBodyId(bodyId),
			}),
		});
	}

	publish(next: YaosPublicSnapshotInput): YaosPublicSnapshot {
		this.assertActive();
		this.snapshot = snapshotCopy(next, this.snapshot.revision + 1);
		const event = Object.freeze({ type: "snapshot" as const, revision: this.snapshot.revision, snapshot: this.snapshot });
		for (const subscription of [...this.subscriptions]) {
			if (!subscription.active) continue;
			try {
				subscription.listener(event);
			} catch {
				ignoreConsumerFailure();
			}
		}
		return this.snapshot;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const subscription of this.subscriptions) subscription.active = false;
		this.subscriptions.clear();
	}

	private readSnapshot(): YaosPublicSnapshot {
		this.assertActive();
		return this.snapshot;
	}

	private subscribe(listener: (event: YaosPublicSnapshotEvent) => void): YaosPublicSubscription {
		this.assertActive();
		const subscription: SubscriptionRecord = { listener, active: true };
		this.subscriptions.add(subscription);
		return Object.freeze({
			snapshot: this.snapshot,
			unsubscribe: (): void => {
				if (!subscription.active) return;
				subscription.active = false;
				this.subscriptions.delete(subscription);
			},
		});
	}

	private getFile(path: string): YaosPublicFileState | null {
		this.assertActive();
		return this.snapshot.files.find((file) => file.path === path) ?? null;
	}

	private getFileByBodyId(bodyId: string): YaosPublicFileState | null {
		this.assertActive();
		return this.snapshot.files.find((file) => file.bodyId === bodyId) ?? null;
	}

	private assertActive(): void {
		if (this.disposed) throw new YaosPublicApiStaleHandleError();
	}
}

function ignoreConsumerFailure(): void {
	return undefined;
}
