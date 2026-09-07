import {
	RuntimeScope,
	type Lease,
	type OperationEpoch,
} from "../runtime/operationLifecycle";

export type BodyResidency = "absent" | "loading" | "warm" | "active" | "evicting";
export type BodyProjectionOwner = "editor" | "disk" | "recovery";
export type BodySynchronization = "clean" | "locally-pending" | "durably-pending" | "catching-up";
export type BodyDivergence = "none" | "evaluating" | "preserved" | "decision-required";
export type BodyLifetime = "accepting" | "quiescing" | "disposed";

export interface BodyRevisionToken {
	readonly bodyId: string;
	readonly docIdentity: string;
	readonly contentRevision: number;
	readonly lifecycleRevision: number;
	readonly ownershipRevision: number;
	readonly localRuntimeEpoch: OperationEpoch;
}

export interface BodyCoordinatorSnapshot {
	bodyId: string;
	docIdentity: string;
	contentRevision: number;
	lifecycleRevision: number;
	ownershipRevision: number;
	residency: BodyResidency;
	projectionOwner: BodyProjectionOwner | null;
	synchronization: BodySynchronization;
	divergence: BodyDivergence;
	lifetime: BodyLifetime;
	leaseCount: number;
}

export interface BodyLease extends Lease {
	readonly bodyId: string;
	readonly leaseId: string;
}

interface BodyRecord {
	docIdentity: string;
	contentRevision: number;
	lifecycleRevision: number;
	ownershipRevision: number;
	residency: BodyResidency;
	projectionOwner: BodyProjectionOwner | null;
	projectionHolders: Set<string>;
	synchronization: BodySynchronization;
	divergence: BodyDivergence;
	lifetime: BodyLifetime;
	leases: Set<string>;
}

interface PathClaim {
	bodyId: string;
	owner: BodyProjectionOwner;
	holders: Set<string>;
}

export class StaleBodyRevisionError extends Error {
	constructor(readonly token: BodyRevisionToken) {
		super(`body ${token.bodyId} effect token is no longer current`);
		this.name = "StaleBodyRevisionError";
	}
}

export class BodyProjectionOwnershipError extends Error {
	constructor(bodyId: string, current: BodyProjectionOwner, requested: BodyProjectionOwner) {
		super(`body ${bodyId} projection is owned by ${current}, not ${requested}`);
		this.name = "BodyProjectionOwnershipError";
	}
}

/** Identity-scoped revision, lease, and projection ownership for one runtime. */
export class BodyCoordinator {
	private readonly records = new Map<string, BodyRecord>();
	private readonly pathBindings = new Map<string, string>();
	private readonly bodyPaths = new Map<string, string>();
	private readonly pathClaims = new Map<string, PathClaim>();
	private accepting = true;
	private disposed = false;

	constructor(
		private readonly runtimeScope: RuntimeScope = new RuntimeScope(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	ensure(bodyId: string): BodyCoordinatorSnapshot {
		return this.snapshotRecord(bodyId, this.record(bodyId));
	}

	capture(bodyId: string): BodyRevisionToken {
		const record = this.record(bodyId);
		const localRuntimeEpoch = this.runtimeScope.captureEpoch();
		if (!localRuntimeEpoch) throw new Error("runtime scope is not accepting work");
		return {
			bodyId,
			docIdentity: record.docIdentity,
			contentRevision: record.contentRevision,
			lifecycleRevision: record.lifecycleRevision,
			ownershipRevision: record.ownershipRevision,
			localRuntimeEpoch,
		};
	}

	isContentCurrent(token: BodyRevisionToken): boolean {
		const record = this.currentRecord(token);
		return record !== null
			&& record.docIdentity === token.docIdentity
			&& record.contentRevision === token.contentRevision;
	}

	isLifecycleCurrent(token: BodyRevisionToken): boolean {
		const record = this.currentRecord(token);
		return record !== null && record.lifecycleRevision === token.lifecycleRevision;
	}

	isProjectionCurrent(token: BodyRevisionToken, path?: string): boolean {
		const record = this.currentRecord(token);
		return record !== null
			&& record.docIdentity === token.docIdentity
			&& record.contentRevision === token.contentRevision
			&& record.lifecycleRevision === token.lifecycleRevision
			&& record.ownershipRevision === token.ownershipRevision
			&& (path === undefined || this.pathBindings.get(path) === token.bodyId);
	}

	isCurrent(token: BodyRevisionToken): boolean {
		return this.isProjectionCurrent(token);
	}

	assertCurrent(token: BodyRevisionToken): void {
		if (!this.isCurrent(token)) throw new StaleBodyRevisionError(token);
	}

	advanceContent(bodyId: string): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.contentRevision++;
		return this.capture(bodyId);
	}

	installDocument(bodyId: string): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.docIdentity = this.createId();
		record.contentRevision = 0;
		return this.capture(bodyId);
	}

	advanceLifecycle(bodyId: string): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.lifecycleRevision++;
		return this.capture(bodyId);
	}

	setResidency(bodyId: string, residency: BodyResidency): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.residency = residency;
		return this.capture(bodyId);
	}

	setSynchronization(bodyId: string, synchronization: BodySynchronization): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.synchronization = synchronization;
		return this.capture(bodyId);
	}

	setDivergence(bodyId: string, divergence: BodyDivergence): BodyRevisionToken {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		record.divergence = divergence;
		return this.capture(bodyId);
	}

	acquireLease(bodyId: string, purpose = "body-work"): BodyLease {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		const runtimeLease = this.runtimeScope.acquireLease(`${purpose}:${bodyId}`);
		if (!runtimeLease) throw new Error("runtime scope is not accepting work");
		const leaseId = this.createId();
		record.leases.add(leaseId);
		let released = false;
		return {
			bodyId,
			leaseId,
			label: runtimeLease.label,
			get released() { return released; },
			release: () => {
				if (released) return;
				released = true;
				record.leases.delete(leaseId);
				runtimeLease.release();
			},
		};
	}

	/** Replaces the complete catalog projection in one synchronous transition. */
	replacePathBindings(bindings: Iterable<readonly [string, string]>): void {
		const next = new Map<string, string>();
		const reverse = new Map<string, string>();
		for (const [path, bodyId] of bindings) {
			if (!path || !bodyId) throw new Error("path and body ID are required");
			if (next.has(path) || reverse.has(bodyId)) throw new Error("catalog path/body bindings must be one-to-one");
			next.set(path, bodyId);
			reverse.set(bodyId, path);
		}
		const affected = new Set<string>();
		for (const [path, priorBodyId] of this.pathBindings) {
			if (next.get(path) !== priorBodyId) affected.add(priorBodyId);
		}
		for (const [path, nextBodyId] of next) {
			if (this.pathBindings.get(path) !== nextBodyId) affected.add(nextBodyId);
		}
		this.pathBindings.clear();
		this.bodyPaths.clear();
		for (const [path, bodyId] of next) {
			this.pathBindings.set(path, bodyId);
			this.bodyPaths.set(bodyId, path);
		}
		for (const [path, claim] of this.pathClaims) {
			if (next.get(path) === claim.bodyId) continue;
			this.releaseClaim(path, claim);
		}
		for (const bodyId of affected) this.advanceLifecycle(bodyId);
	}

	bindPath(path: string, bodyId: string): void {
		const next = new Map(this.pathBindings);
		const oldPath = this.bodyPaths.get(bodyId);
		if (oldPath && oldPath !== path) next.delete(oldPath);
		next.set(path, bodyId);
		this.replacePathBindings(next);
	}

	unbindPath(path: string, expectedBodyId?: string): void {
		const prior = this.pathBindings.get(path);
		if (!prior || (expectedBodyId !== undefined && prior !== expectedBodyId)) return;
		const next = new Map(this.pathBindings);
		next.delete(path);
		this.replacePathBindings(next);
	}

	isPathCurrent(path: string, bodyId: string): boolean {
		return this.pathBindings.get(path) === bodyId;
	}

	pathForBody(bodyId: string): string | null {
		return this.bodyPaths.get(bodyId) ?? null;
	}

	acquireProjection(path: string, bodyId: string, owner: BodyProjectionOwner, holderId: string): BodyLease {
		const record = this.record(bodyId);
		this.assertAccepting(record);
		if (!this.isPathCurrent(path, bodyId)) throw new Error(`path ${path} is not currently bound to body ${bodyId}`);
		const currentClaim = this.pathClaims.get(path);
		if (currentClaim && (currentClaim.bodyId !== bodyId || currentClaim.owner !== owner || owner !== "editor")) {
			throw new BodyProjectionOwnershipError(bodyId, currentClaim.owner, owner);
		}
		const holderKey = `${owner}:${holderId}`;
		const claim = currentClaim ?? { bodyId, owner, holders: new Set<string>() };
		if (claim.holders.has(holderKey)) throw new Error(`body ${bodyId} projection holder ${holderKey} already exists`);
		this.pathClaims.set(path, claim);
		record.projectionOwner = owner;
		record.projectionHolders.add(holderKey);
		claim.holders.add(holderKey);
		record.ownershipRevision++;
		const lease = this.acquireLease(bodyId, `${owner}-projection`);
		let released = false;
		return {
			...lease,
			get released() { return released; },
			release: () => {
				if (released) return;
				released = true;
				record.projectionHolders.delete(holderKey);
				claim.holders.delete(holderKey);
				if (claim.holders.size === 0) this.pathClaims.delete(path);
				if (record.projectionHolders.size === 0) record.projectionOwner = null;
				record.ownershipRevision++;
				lease.release();
			},
		};
	}

	canEvict(bodyId: string): boolean {
		const record = this.records.get(bodyId);
		return record === undefined || (record.leases.size === 0
			&& record.projectionOwner === null
			&& record.synchronization === "clean"
			&& record.lifetime === "accepting");
	}

	snapshot(bodyId: string): BodyCoordinatorSnapshot | null {
		const record = this.records.get(bodyId);
		return record ? this.snapshotRecord(bodyId, record) : null;
	}

	quiesce(): void {
		if (!this.accepting) return;
		this.accepting = false;
		for (const record of this.records.values()) record.lifetime = "quiescing";
	}

	dispose(): void {
		this.quiesce();
		this.disposed = true;
		for (const record of this.records.values()) {
			record.lifetime = "disposed";
			record.projectionOwner = null;
			record.projectionHolders.clear();
			record.leases.clear();
		}
		this.pathClaims.clear();
		this.pathBindings.clear();
		this.bodyPaths.clear();
	}

	private currentRecord(token: BodyRevisionToken): BodyRecord | null {
		const record = this.records.get(token.bodyId);
		return !this.disposed && token.localRuntimeEpoch.isCurrent() && record?.lifetime === "accepting"
			? record
			: null;
	}

	private releaseClaim(path: string, claim: PathClaim): void {
		this.pathClaims.delete(path);
		const record = this.records.get(claim.bodyId);
		if (!record) return;
		for (const holder of claim.holders) record.projectionHolders.delete(holder);
		record.projectionOwner = record.projectionHolders.size === 0 ? null : record.projectionOwner;
		record.ownershipRevision++;
	}

	private record(bodyId: string): BodyRecord {
		if (!bodyId) throw new Error("body ID is required");
		let record = this.records.get(bodyId);
		if (!record) {
			if (!this.accepting || this.disposed || !this.runtimeScope.isAccepting) throw new Error("body coordinator is not accepting work");
			record = {
				docIdentity: this.createId(), contentRevision: 0, lifecycleRevision: 0, ownershipRevision: 0,
				residency: "absent", projectionOwner: null, projectionHolders: new Set(),
				synchronization: "clean", divergence: "none", lifetime: "accepting", leases: new Set(),
			};
			this.records.set(bodyId, record);
		}
		return record;
	}

	private assertAccepting(record: BodyRecord): void {
		if (!this.accepting || this.disposed || !this.runtimeScope.isAccepting || record.lifetime !== "accepting") {
			throw new Error("body coordinator is not accepting work");
		}
	}

	private snapshotRecord(bodyId: string, record: BodyRecord): BodyCoordinatorSnapshot {
		return {
			bodyId, docIdentity: record.docIdentity, contentRevision: record.contentRevision,
			lifecycleRevision: record.lifecycleRevision, ownershipRevision: record.ownershipRevision,
			residency: record.residency, projectionOwner: record.projectionOwner,
			synchronization: record.synchronization, divergence: record.divergence,
			lifetime: record.lifetime, leaseCount: record.leases.size,
		};
	}
}
