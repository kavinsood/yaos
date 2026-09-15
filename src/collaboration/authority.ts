export type VaultRole = "owner" | "member";

export type VaultCapability =
	| "vault.catalog.read"
	| "vault.content.read"
	| "vault.content.write"
	| "vault.lifecycle.write"
	| "vault.attachments.read"
	| "vault.attachments.write"
	| "vault.presence.use"
	| "vault.members.read"
	| "vault.profile.manage_self"
	| "vault.devices.manage_self"
	| "vault.settings.personal.sync"
	| "vault.leave"
	| "vault.operations.read_own_outcome"
	| "vault.members.invite"
	| "vault.members.manage"
	| "vault.devices.manage_all"
	| "vault.recovery.manage"
	| "vault.audit.read"
	| "vault.diagnostics.read"
	| "vault.policy.manage"
	| "vault.metadata.rename"
	| "vault.ownership.transfer"
	| "vault.destroy.request"
	| "vault.excalidraw.shares.manage";

export const MEMBER_CAPABILITIES: readonly VaultCapability[] = Object.freeze([
	"vault.catalog.read",
	"vault.content.read",
	"vault.content.write",
	"vault.lifecycle.write",
	"vault.attachments.read",
	"vault.attachments.write",
	"vault.presence.use",
	"vault.members.read",
	"vault.profile.manage_self",
	"vault.devices.manage_self",
	"vault.settings.personal.sync",
	"vault.leave",
	"vault.operations.read_own_outcome",
]);

export const OWNER_CAPABILITIES: readonly VaultCapability[] = Object.freeze([
	...MEMBER_CAPABILITIES.filter((capability) => capability !== "vault.leave"),
	"vault.members.invite",
	"vault.members.manage",
	"vault.devices.manage_all",
	"vault.recovery.manage",
	"vault.audit.read",
	"vault.diagnostics.read",
	"vault.policy.manage",
	"vault.metadata.rename",
	"vault.ownership.transfer",
	"vault.destroy.request",
	"vault.excalidraw.shares.manage",
]);

const ALL_CAPABILITIES: readonly VaultCapability[] = Object.freeze([
	...new Set([...MEMBER_CAPABILITIES, ...OWNER_CAPABILITIES]),
]);

export interface VaultAuthorityIdentity {
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly principalId: string;
	readonly membershipRevision: number;
	readonly deviceId: string;
	readonly deviceCredentialRevision: number;
}

export interface VaultAuthoritySnapshot extends VaultAuthorityIdentity {
	readonly role: VaultRole;
	readonly policyVersion: number;
	readonly capabilityDigest: string;
	readonly capabilities: readonly VaultCapability[];
}

export type AuthorityState = "active" | "refreshing" | "changing" | "revoked" | "incompatible";

export interface AuthorityCoordinatorSnapshot {
	readonly epoch: number;
	readonly state: AuthorityState;
	readonly authority: VaultAuthoritySnapshot | null;
	readonly reason: string | null;
}

export interface AuthoritySubscription {
	readonly snapshot: AuthorityCoordinatorSnapshot;
	unsubscribe(): void;
}

export class AuthoritySupersededError extends Error {
	constructor(readonly captured: VaultAuthorityIdentity) {
		super("work belongs to superseded vault authority");
		this.name = "AuthoritySupersededError";
	}
}

type AuthorityListener = (snapshot: AuthorityCoordinatorSnapshot) => void;

export class AuthorityCoordinator {
	private snapshot: AuthorityCoordinatorSnapshot;
	private readonly listeners = new Set<AuthorityListener>();

	constructor(initial: VaultAuthoritySnapshot | null = null) {
		this.snapshot = freezeCoordinatorSnapshot({
			epoch: 0,
			state: initial ? "active" : "refreshing",
			authority: initial ? copyAuthority(initial) : null,
			reason: null,
		});
	}

	get current(): AuthorityCoordinatorSnapshot {
		return this.snapshot;
	}

	has(capability: VaultCapability): boolean {
		return this.snapshot.state === "active"
			&& this.snapshot.authority?.capabilities.includes(capability) === true;
	}

	capture(): VaultAuthorityIdentity {
		const authority = this.snapshot.authority;
		if (this.snapshot.state !== "active" || !authority) {
			throw new Error(`vault authority is ${this.snapshot.state}`);
		}
		return copyAuthorityIdentity(authority);
	}

	assertCurrent(captured: VaultAuthorityIdentity): void {
		const authority = this.snapshot.authority;
		if (this.snapshot.state !== "active" || !authority || !sameAuthorityIdentity(captured, authority)) {
			throw new AuthoritySupersededError(captured);
		}
	}

	install(authority: VaultAuthoritySnapshot): AuthorityCoordinatorSnapshot {
		return this.transition("active", authority, null);
	}

	refreshing(reason: string | null = null): AuthorityCoordinatorSnapshot {
		return this.transition("refreshing", this.snapshot.authority, reason);
	}

	changing(reason: string | null = null): AuthorityCoordinatorSnapshot {
		return this.transition("changing", this.snapshot.authority, reason);
	}

	revoked(reason: string | null = "membership_revoked"): AuthorityCoordinatorSnapshot {
		return this.transition("revoked", this.snapshot.authority, reason);
	}

	incompatible(reason: string): AuthorityCoordinatorSnapshot {
		return this.transition("incompatible", this.snapshot.authority, reason);
	}

	subscribe(listener: AuthorityListener): AuthoritySubscription {
		this.listeners.add(listener);
		let active = true;
		return Object.freeze({
			snapshot: this.snapshot,
			unsubscribe: (): void => {
				if (!active) return;
				active = false;
				this.listeners.delete(listener);
			},
		});
	}

	private transition(
		state: AuthorityState,
		authority: VaultAuthoritySnapshot | null,
		reason: string | null,
	): AuthorityCoordinatorSnapshot {
		this.snapshot = freezeCoordinatorSnapshot({
			epoch: this.snapshot.epoch + 1,
			state,
			authority: authority ? copyAuthority(authority) : null,
			reason,
		});
		for (const listener of [...this.listeners]) {
			try { listener(this.snapshot); } catch { /* consumer-owned callback */ }
		}
		return this.snapshot;
	}
}

export function capabilitiesForRole(role: VaultRole): readonly VaultCapability[] {
	return role === "owner" ? OWNER_CAPABILITIES : MEMBER_CAPABILITIES;
}

export function sameAuthorityIdentity(
	left: VaultAuthorityIdentity,
	right: VaultAuthorityIdentity,
): boolean {
	return left.vaultId === right.vaultId
		&& left.vaultGeneration === right.vaultGeneration
		&& left.principalId === right.principalId
		&& left.membershipRevision === right.membershipRevision
		&& left.deviceId === right.deviceId
		&& left.deviceCredentialRevision === right.deviceCredentialRevision;
}

export function readVaultAuthoritySnapshot(value: unknown): VaultAuthoritySnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("authority response is not an object");
	}
	const record = value as Record<string, unknown>;
	const role = record.role;
	if (role !== "owner" && role !== "member") throw new Error("authority response has invalid role");
	const rawCapabilities = record.capabilities;
	if (!Array.isArray(rawCapabilities) || rawCapabilities.some((item) => !isVaultCapability(item))) {
		throw new Error("authority response has invalid capabilities");
	}
	const uniqueCapabilities = [...new Set(rawCapabilities as VaultCapability[])].sort();
	const expectedCapabilities = [...capabilitiesForRole(role)].sort();
	if (uniqueCapabilities.length !== expectedCapabilities.length
		|| uniqueCapabilities.some((capability, index) => capability !== expectedCapabilities[index])) {
		throw new Error("authority response capabilities do not match its fixed role");
	}
	return copyAuthority({
		vaultId: requiredIdentifier(record.vaultId, "vaultId"),
		vaultGeneration: requiredIdentifier(record.vaultGeneration, "vaultGeneration"),
		principalId: requiredIdentifier(record.principalId, "principalId"),
		membershipRevision: requiredRevision(record.membershipRevision, "membershipRevision"),
		deviceId: requiredIdentifier(record.deviceId, "deviceId"),
		deviceCredentialRevision: requiredRevision(record.deviceCredentialRevision, "deviceCredentialRevision"),
		role,
		policyVersion: requiredRevision(record.policyVersion, "policyVersion"),
		capabilityDigest: requiredIdentifier(record.capabilityDigest, "capabilityDigest"),
		capabilities: uniqueCapabilities,
	});
}

export function copyAuthorityIdentity(authority: VaultAuthorityIdentity): VaultAuthorityIdentity {
	return Object.freeze({
		vaultId: authority.vaultId,
		vaultGeneration: authority.vaultGeneration,
		principalId: authority.principalId,
		membershipRevision: authority.membershipRevision,
		deviceId: authority.deviceId,
		deviceCredentialRevision: authority.deviceCredentialRevision,
	});
}

function copyAuthority(authority: VaultAuthoritySnapshot): VaultAuthoritySnapshot {
	return Object.freeze({
		...copyAuthorityIdentity(authority),
		role: authority.role,
		policyVersion: authority.policyVersion,
		capabilityDigest: authority.capabilityDigest,
		capabilities: Object.freeze([...authority.capabilities]),
	});
}

function freezeCoordinatorSnapshot(snapshot: AuthorityCoordinatorSnapshot): AuthorityCoordinatorSnapshot {
	return Object.freeze(snapshot);
}

function requiredIdentifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) {
		throw new Error(`authority response has invalid ${field}`);
	}
	return value;
}

function requiredRevision(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`authority response has invalid ${field}`);
	}
	return value as number;
}

function isVaultCapability(value: unknown): value is VaultCapability {
	return typeof value === "string"
		&& (ALL_CAPABILITIES as readonly string[]).includes(value);
}
