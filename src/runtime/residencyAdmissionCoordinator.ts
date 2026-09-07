export type ResidencyPopulation = "active" | "warm" | "loading" | "cold";
export type BodySocketState = "none" | "opening" | "open";
export type AdmissionPriority = "editor" | "foreground" | "background";
export type RuntimePlatform = "desktop" | "mobile";
export type RuntimeVisibility = "foreground" | "background";

export interface ResidencyBodyObservation {
	readonly bodyId: string;
	readonly population: ResidencyPopulation;
	readonly residentCost: number;
	readonly transientCost: number;
	readonly dirty: boolean;
	readonly durablyPending: boolean;
	readonly leaseCount: number;
	readonly socket: BodySocketState;
	readonly lastUsedAt: number;
}

export interface ResidencyAdmissionLimits {
	readonly residentCost: number;
	readonly transientCost: number;
	readonly concurrentLoads: number;
	readonly warmBodies: number;
	readonly sockets: number;
	readonly reservedSockets: number;
	readonly warmRetentionMs: number;
	readonly backgroundPromotionMs: number;
	readonly maxPreferredBurst: number;
}

export interface AdmissionRequestInput {
	readonly bodyId: string;
	readonly priority: AdmissionPriority;
	readonly needsLoad: boolean;
	readonly needsSocket: boolean;
	readonly residentCost: number;
	readonly transientCost: number;
	readonly finalPopulation: "active" | "warm";
	readonly essentialInBackground?: boolean;
	readonly requestedAt: number;
}

export interface AdmissionRequest extends AdmissionRequestInput {
	readonly requestId: string;
	readonly sequence: number;
}

export type AdmissionBackpressureReason =
	| "mobile_background"
	| "concurrent_load_limit"
	| "transient_cost_limit"
	| "resident_cost_limit"
	| "protected_residency_saturation"
	| "socket_budget";

export interface AdmissionReservation {
	readonly reservationId: string;
	readonly request: AdmissionRequest;
	readonly evictBodyIds: readonly string[];
	readonly closeSocketBodyIds: readonly string[];
	readonly loadSlots: number;
	readonly residentCost: number;
	readonly transientCost: number;
	readonly socketSlots: number;
}

export type AdmissionDecision =
	| { kind: "idle" }
	| { kind: "backpressure"; request: AdmissionRequest; reason: AdmissionBackpressureReason }
	| { kind: "granted"; reservation: AdmissionReservation };

export interface AdmissionSettlement {
	readonly requeue?: boolean;
	readonly observation?: ResidencyBodyObservation;
}

export interface ResidencyMaintenancePlan {
	readonly evictBodyIds: readonly string[];
	readonly closeSocketBodyIds: readonly string[];
}

export interface ResidencyAdmissionSnapshot {
	readonly context: { platform: RuntimePlatform; visibility: RuntimeVisibility };
	readonly populations: Record<ResidencyPopulation, number>;
	readonly queue: Record<AdmissionPriority, number>;
	readonly reservations: number;
	readonly residentCost: { used: number; reserved: number; plannedRelease: number; limit: number };
	readonly transientCost: { used: number; reserved: number; limit: number };
	readonly loads: { used: number; reserved: number; limit: number };
	readonly sockets: { used: number; reserved: number; plannedRelease: number; fixed: number; limit: number };
	readonly blockers: {
		dirty: number;
		durablyPending: number;
		leased: number;
		active: number;
	};
}

const POPULATIONS: readonly ResidencyPopulation[] = ["active", "warm", "loading", "cold"];
const PRIORITIES: readonly AdmissionPriority[] = ["editor", "foreground", "background"];

function assertBudget(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function checkedAdd(left: number, right: number, label: string): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds safe integer range`);
	return result;
}

function isResident(body: ResidencyBodyObservation): boolean {
	return body.population !== "cold";
}

function isProtected(body: ResidencyBodyObservation): boolean {
	return body.population === "active" || body.dirty || body.durablyPending || body.leaseCount > 0;
}

function isEvictableWarm(body: ResidencyBodyObservation): boolean {
	return body.population === "warm" && !isProtected(body);
}

/**
 * Pure admission authority for measured body residency and body-provider
 * sockets. Callers observe actual state, request work, execute a grant's
 * evictions/closures, then settle the reservation with the resulting state.
 */
export class ResidencyAdmissionCoordinator {
	private readonly bodies = new Map<string, ResidencyBodyObservation>();
	private readonly queue = new Map<string, AdmissionRequest>();
	private readonly reservations = new Map<string, AdmissionReservation>();
	private requestSequence = 0;
	private reservationSequence = 0;
	private preferredBurst = 0;
	private platform: RuntimePlatform = "desktop";
	private visibility: RuntimeVisibility = "foreground";

	constructor(
		readonly limits: ResidencyAdmissionLimits,
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {
		assertBudget(limits.residentCost, "resident cost limit");
		assertBudget(limits.transientCost, "transient cost limit");
		assertBudget(limits.concurrentLoads, "concurrent load limit");
		assertBudget(limits.warmBodies, "warm body limit");
		assertBudget(limits.sockets, "socket limit");
		assertBudget(limits.reservedSockets, "reserved socket count");
		assertBudget(limits.warmRetentionMs, "warm retention");
		assertBudget(limits.backgroundPromotionMs, "background promotion");
		assertBudget(limits.maxPreferredBurst, "preferred burst");
		if (limits.reservedSockets > limits.sockets) {
			throw new Error("reserved sockets cannot exceed the socket limit");
		}
	}

	setRuntimeContext(platform: RuntimePlatform, visibility: RuntimeVisibility): void {
		this.platform = platform;
		this.visibility = visibility;
	}

	observeBody(observation: ResidencyBodyObservation): void {
		this.validateObservation(observation);
		this.bodies.set(observation.bodyId, { ...observation });
	}

	forgetBody(bodyId: string): void {
		this.bodies.delete(bodyId);
	}

	request(input: AdmissionRequestInput): AdmissionRequest {
		this.validateRequest(input);
		const queued = [...this.queue.values()].find((request) => request.bodyId === input.bodyId);
		if (queued) {
			const priority = this.higherPriority(queued.priority, input.priority);
			const coalesced: AdmissionRequest = {
				...queued,
				priority,
				needsLoad: queued.needsLoad || input.needsLoad,
				needsSocket: queued.needsSocket || input.needsSocket,
				residentCost: Math.max(queued.residentCost, input.residentCost),
				transientCost: Math.max(queued.transientCost, input.transientCost),
				finalPopulation: queued.finalPopulation === "active" || input.finalPopulation === "active" ? "active" : "warm",
				essentialInBackground: queued.essentialInBackground === true || input.essentialInBackground === true,
				requestedAt: Math.min(queued.requestedAt, input.requestedAt),
			};
			this.validateRequest(coalesced);
			this.queue.set(coalesced.requestId, coalesced);
			return coalesced;
		}
		const request: AdmissionRequest = {
			...input,
			requestId: `admission-${this.requestSequence + 1}-${this.createId()}`,
			sequence: ++this.requestSequence,
		};
		this.queue.set(request.requestId, request);
		return request;
	}

	cancelRequest(requestId: string): boolean {
		return this.queue.delete(requestId);
	}

	cancelBodyRequests(bodyId: string): number {
		let cancelled = 0;
		for (const [requestId, request] of this.queue) {
			if (request.bodyId !== bodyId) continue;
			this.queue.delete(requestId);
			cancelled++;
		}
		return cancelled;
	}

	decideNext(now: number): AdmissionDecision {
		assertBudget(now, "admission time");
		const request = this.pickNext(now);
		if (!request) return { kind: "idle" };
		if (this.isOptionalAdmissionPaused(request)) {
			return { kind: "backpressure", request, reason: "mobile_background" };
		}
		const resourceFailure = this.checkFixedResources(request);
		if (resourceFailure) return { kind: "backpressure", request, reason: resourceFailure };
		const residency = this.planResidency(request);
		if (!residency) {
			return { kind: "backpressure", request, reason: "protected_residency_saturation" };
		}
		const sockets = this.planSockets(request, residency.evictBodyIds);
		if (!sockets) return { kind: "backpressure", request, reason: "socket_budget" };
		const reservation: AdmissionReservation = {
			reservationId: `residency-${++this.reservationSequence}-${this.createId()}`,
			request,
			evictBodyIds: residency.evictBodyIds,
			closeSocketBodyIds: sockets,
			loadSlots: request.needsLoad ? 1 : 0,
			residentCost: request.needsLoad ? request.residentCost : 0,
			transientCost: request.transientCost,
			socketSlots: request.needsSocket ? 1 : 0,
		};
		this.queue.delete(request.requestId);
		this.reservations.set(reservation.reservationId, reservation);
		if (request.priority === "background") this.preferredBurst = 0;
		else this.preferredBurst++;
		return { kind: "granted", reservation };
	}

	settle(reservationId: string, settlement: AdmissionSettlement = {}): boolean {
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return false;
		this.reservations.delete(reservationId);
		if (settlement.observation) this.observeBody(settlement.observation);
		if (settlement.requeue) this.queue.set(reservation.request.requestId, reservation.request);
		return true;
	}

	planMaintenance(now: number): ResidencyMaintenancePlan {
		assertBudget(now, "maintenance time");
		const reservedEvictions = this.reservedBodyIds("evictBodyIds");
		const reservedClosures = this.reservedBodyIds("closeSocketBodyIds");
		const reservedRequests = this.reservedRequestBodyIds();
		const warm = [...this.bodies.values()]
			.filter((body) => isEvictableWarm(body)
				&& !reservedEvictions.has(body.bodyId)
				&& !reservedRequests.has(body.bodyId))
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.bodyId.localeCompare(right.bodyId));
		const evictBodyIds: string[] = [];
		if (this.platform === "mobile" && this.visibility === "background") {
			evictBodyIds.push(...warm.map((body) => body.bodyId));
		} else {
			let remainingWarm = this.countEffectiveWarm();
			for (const body of warm) {
				const expired = now - body.lastUsedAt >= this.limits.warmRetentionMs;
				if (!expired && remainingWarm <= this.limits.warmBodies) continue;
				evictBodyIds.push(body.bodyId);
				remainingWarm--;
			}
		}
		const closeSocketBodyIds = this.planMaintenanceSocketClosures(reservedClosures, evictBodyIds);
		return { evictBodyIds, closeSocketBodyIds };
	}

	snapshot(): ResidencyAdmissionSnapshot {
		const populations = Object.fromEntries(POPULATIONS.map((population) => [population, 0])) as Record<ResidencyPopulation, number>;
		const queue = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0])) as Record<AdmissionPriority, number>;
		let residentUsed = 0;
		let transientUsed = 0;
		let loadsUsed = 0;
		let socketsUsed = 0;
		const blockers = { dirty: 0, durablyPending: 0, leased: 0, active: 0 };
		for (const body of this.bodies.values()) {
			populations[body.population]++;
			if (isResident(body)) residentUsed = checkedAdd(residentUsed, body.residentCost, "observed resident cost");
			transientUsed = checkedAdd(transientUsed, body.transientCost, "observed transient cost");
			if (body.population === "loading") loadsUsed++;
			if (body.socket !== "none") socketsUsed++;
			if (body.dirty) blockers.dirty++;
			if (body.durablyPending) blockers.durablyPending++;
			if (body.leaseCount > 0) blockers.leased++;
			if (body.population === "active") blockers.active++;
		}
		for (const request of this.queue.values()) queue[request.priority]++;
		let residentReserved = 0;
		let transientReserved = 0;
		let loadsReserved = 0;
		let socketsReserved = 0;
		for (const reservation of this.reservations.values()) {
			residentReserved = checkedAdd(residentReserved, reservation.residentCost, "reserved resident cost");
			transientReserved = checkedAdd(transientReserved, reservation.transientCost, "reserved transient cost");
			loadsReserved += reservation.loadSlots;
			socketsReserved += reservation.socketSlots;
		}
		const plannedEvictions = this.reservedBodyIds("evictBodyIds");
		const plannedSocketReleases = new Set([
			...plannedEvictions,
			...this.reservedBodyIds("closeSocketBodyIds"),
		]);
		const plannedResidentRelease = [...plannedEvictions].reduce(
			(total, bodyId) => total + (this.bodies.get(bodyId)?.residentCost ?? 0),
			0,
		);
		const plannedSocketRelease = [...plannedSocketReleases].reduce(
			(total, bodyId) => total + (this.bodies.get(bodyId)?.socket === "none" ? 0 : 1),
			0,
		);
		return {
			context: { platform: this.platform, visibility: this.visibility },
			populations,
			queue,
			reservations: this.reservations.size,
			residentCost: { used: residentUsed, reserved: residentReserved, plannedRelease: plannedResidentRelease, limit: this.limits.residentCost },
			transientCost: { used: transientUsed, reserved: transientReserved, limit: this.limits.transientCost },
			loads: { used: loadsUsed, reserved: loadsReserved, limit: this.limits.concurrentLoads },
			sockets: { used: socketsUsed, reserved: socketsReserved, plannedRelease: plannedSocketRelease, fixed: this.limits.reservedSockets, limit: this.limits.sockets },
			blockers,
		};
	}

	private pickNext(now: number): AdmissionRequest | null {
		const requests = [...this.queue.values()];
		if (requests.length === 0) return null;
		const allowed = requests.filter((request) => !this.isOptionalAdmissionPaused(request));
		const candidates = allowed.length > 0 ? allowed : requests;
		const oldest = (priority: AdmissionPriority): AdmissionRequest | null => candidates
			.filter((request) => request.priority === priority)
			.sort((left, right) => left.requestedAt - right.requestedAt || left.sequence - right.sequence)[0] ?? null;
		const background = oldest("background");
		const backgroundPromoted = background !== null
			&& now - background.requestedAt >= this.limits.backgroundPromotionMs
			&& this.preferredBurst >= this.limits.maxPreferredBurst;
		if (backgroundPromoted) return background;
		return oldest("editor") ?? oldest("foreground") ?? background;
	}

	private checkFixedResources(request: AdmissionRequest): AdmissionBackpressureReason | null {
		const snapshot = this.snapshot();
		if (request.needsLoad && snapshot.loads.used + snapshot.loads.reserved >= snapshot.loads.limit) {
			return "concurrent_load_limit";
		}
		if (request.needsLoad && request.residentCost > snapshot.residentCost.limit) {
			return "resident_cost_limit";
		}
		const transientDemand = checkedAdd(
			checkedAdd(snapshot.transientCost.used, snapshot.transientCost.reserved, "transient admission demand"),
			request.transientCost,
			"transient admission demand",
		);
		if (request.transientCost > 0 && transientDemand > snapshot.transientCost.limit) {
			return "transient_cost_limit";
		}
		return null;
	}

	private planResidency(request: AdmissionRequest): { evictBodyIds: readonly string[] } | null {
		if (!request.needsLoad) return { evictBodyIds: [] };
		const snapshot = this.snapshot();
		const reservedEvictions = this.reservedBodyIds("evictBodyIds");
		const reservedRequests = this.reservedRequestBodyIds();
		const alreadyPlannedCost = [...reservedEvictions].reduce(
			(total, bodyId) => total + (this.bodies.get(bodyId)?.residentCost ?? 0),
			0,
		);
		const retainedCost = snapshot.residentCost.used - alreadyPlannedCost;
		const residentDemand = checkedAdd(
			checkedAdd(retainedCost, snapshot.residentCost.reserved, "resident admission demand"),
			request.residentCost,
			"resident admission demand",
		);
		let excessCost = residentDemand - snapshot.residentCost.limit;
		let excessWarm = this.countEffectiveWarm() + (request.finalPopulation === "warm" ? 1 : 0) - this.limits.warmBodies;
		if (excessCost <= 0 && excessWarm <= 0) return { evictBodyIds: [] };
		const candidates = [...this.bodies.values()]
			.filter((body) => body.bodyId !== request.bodyId
				&& isEvictableWarm(body)
				&& !reservedEvictions.has(body.bodyId)
				&& !reservedRequests.has(body.bodyId))
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.bodyId.localeCompare(right.bodyId));
		const evictBodyIds: string[] = [];
		for (const body of candidates) {
			if (excessCost <= 0 && excessWarm <= 0) break;
			evictBodyIds.push(body.bodyId);
			excessCost -= body.residentCost;
			excessWarm--;
		}
		return excessCost <= 0 ? { evictBodyIds } : null;
	}

	private planSockets(request: AdmissionRequest, evictBodyIds: readonly string[]): readonly string[] | null {
		if (!request.needsSocket) return [];
		const snapshot = this.snapshot();
		const reservedClosures = this.reservedBodyIds("closeSocketBodyIds");
		const reservedRequests = this.reservedRequestBodyIds();
		const evicted = new Set(evictBodyIds);
		const alreadyPlanned = new Set([...reservedClosures, ...this.reservedBodyIds("evictBodyIds"), ...evicted]);
		let socketCount = snapshot.sockets.used + snapshot.sockets.reserved + snapshot.sockets.fixed;
		for (const bodyId of alreadyPlanned) {
			if (this.bodies.get(bodyId)?.socket !== "none") socketCount--;
		}
		if (socketCount + 1 <= snapshot.sockets.limit) return [];
		const candidates = [...this.bodies.values()]
			.filter((body) => body.socket !== "none"
				&& isEvictableWarm(body)
				&& !alreadyPlanned.has(body.bodyId)
				&& !reservedRequests.has(body.bodyId))
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.bodyId.localeCompare(right.bodyId));
		const closeSocketBodyIds: string[] = [];
		for (const body of candidates) {
			closeSocketBodyIds.push(body.bodyId);
			socketCount--;
			if (socketCount + 1 <= snapshot.sockets.limit) return closeSocketBodyIds;
		}
		return null;
	}

	private planMaintenanceSocketClosures(reservedClosures: ReadonlySet<string>, evictions: readonly string[]): string[] {
		const evicted = new Set(evictions);
		const reservedRequests = this.reservedRequestBodyIds();
		const candidates = [...this.bodies.values()]
			.filter((body) => body.socket !== "none"
				&& isEvictableWarm(body)
				&& !reservedClosures.has(body.bodyId)
				&& !evicted.has(body.bodyId)
				&& !reservedRequests.has(body.bodyId))
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.bodyId.localeCompare(right.bodyId));
		if (this.platform === "mobile" && this.visibility === "background") return candidates.map((body) => body.bodyId);
		const snapshot = this.snapshot();
		let excess = snapshot.sockets.used + snapshot.sockets.reserved + snapshot.sockets.fixed - snapshot.sockets.limit;
		if (excess <= 0) return [];
		return candidates.slice(0, excess).map((body) => body.bodyId);
	}

	private countEffectiveWarm(): number {
		const reservedEvictions = this.reservedBodyIds("evictBodyIds");
		let count = 0;
		for (const body of this.bodies.values()) {
			if (body.population === "warm" && !reservedEvictions.has(body.bodyId)) count++;
		}
		for (const reservation of this.reservations.values()) {
			if (reservation.request.needsLoad && reservation.request.finalPopulation === "warm") count++;
		}
		return count;
	}

	private reservedBodyIds(field: "evictBodyIds" | "closeSocketBodyIds"): Set<string> {
		const bodyIds = new Set<string>();
		for (const reservation of this.reservations.values()) {
			for (const bodyId of reservation[field]) bodyIds.add(bodyId);
		}
		return bodyIds;
	}

	private reservedRequestBodyIds(): Set<string> {
		return new Set([...this.reservations.values()].map((reservation) => reservation.request.bodyId));
	}

	private isOptionalAdmissionPaused(request: AdmissionRequest): boolean {
		return this.platform === "mobile"
			&& this.visibility === "background"
			&& request.essentialInBackground !== true;
	}

	private higherPriority(left: AdmissionPriority, right: AdmissionPriority): AdmissionPriority {
		const rank: Record<AdmissionPriority, number> = { background: 0, foreground: 1, editor: 2 };
		return rank[left] >= rank[right] ? left : right;
	}

	private validateObservation(observation: ResidencyBodyObservation): void {
		if (!observation.bodyId) throw new Error("body observation requires an ID");
		assertBudget(observation.residentCost, "body resident cost");
		assertBudget(observation.transientCost, "body transient cost");
		assertBudget(observation.leaseCount, "body lease count");
		assertBudget(observation.lastUsedAt, "body last-used time");
		if (observation.population === "cold" && (observation.residentCost !== 0 || observation.transientCost !== 0 || observation.socket !== "none")) {
			throw new Error("cold bodies cannot retain resident, transient, or socket resources");
		}
		if (observation.population !== "loading" && observation.transientCost !== 0) {
			throw new Error("only loading bodies may report transient cost");
		}
	}

	private validateRequest(input: AdmissionRequestInput): void {
		if (!input.bodyId) throw new Error("admission request requires a body ID");
		assertBudget(input.residentCost, "requested resident cost");
		assertBudget(input.transientCost, "requested transient cost");
		assertBudget(input.requestedAt, "request time");
		if (!input.needsLoad && input.residentCost !== 0) {
			throw new Error("non-load admission cannot reserve resident cost");
		}
	}
}
