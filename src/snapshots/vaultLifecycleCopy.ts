export type VaultLifecycleAction =
	| "reset-local-cache"
	| "reset-active-state"
	| "delete-recovery-point"
	| "delete-vault";

export interface VaultLifecycleCopy {
	title: string;
	deleted: string[];
	retained: string[];
	confirmation: string;
}

export const VAULT_LIFECYCLE_COPY: Record<VaultLifecycleAction, VaultLifecycleCopy> = {
	"reset-local-cache": {
		title: "Reset this device's local cache",
		deleted: ["This device's IndexedDB sync cache", "persisted transfer queue and derived local indexes"],
		retained: ["Files on disk", "server active state", "recovery points", "attachments", "vault access"],
		confirmation: "This device will download current server state again.",
	},
	"reset-active-state": {
		title: "Reset active synced state",
		deleted: ["Active server file catalog and bodies", "tombstones", "in-flight candidates and active recovery job dependencies", "this device's local sync cache"],
		retained: ["Files on disk", "durable recovery points", "recovery-v2 content graph objects", "content-addressed attachment objects", "vault provisioning and access"],
		confirmation: "Type the vault ID to prevent resetting the wrong vault.",
	},
	"delete-recovery-point": {
		title: "Delete one recovery point",
		deleted: ["The selected recovery-v2 root; unreferenced graph objects are reclaimed by recovery garbage collection"],
		retained: ["Current vault files and active sync state", "other recovery points", "attachments", "vault access", "local files"],
		confirmation: "Only the selected recovery point is removed.",
	},
	"delete-vault": {
		title: "Delete and revoke this vault",
		deleted: ["All active server state", "all server recovery points and attachment objects", "vault provisioning record and access"],
		retained: ["Files already on this device", "portable exports already downloaded"],
		confirmation: "Type the vault ID. This cannot be undone and other devices will lose access.",
	},
};
