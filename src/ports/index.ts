/**
 * Port bundles. DESIGN §h. Everything outside src/host and the production
 * adapters talks to the world only through these.
 */

export type { Unsubscribe, PortError } from "./common";
export type { ClockPort, TimerHandle } from "./clock";
export type { RandomPort } from "./random";
export type { CryptoPort, HashPort, BlobAddress, OpenFailure } from "./crypto";
export type { BlobPort } from "./blob";
export type { PlatformPort, PlatformInfo, PlatformOs, LifecycleEvent } from "./platform";
export type {
	VaultPort, VaultStat, VaultEvent, WritePrecondition, WriteOutcome, RenameOutcome, TrashMode,
	ConfigDirPort, SideFilePort, SideFileName,
} from "./vault";
export type { WorkspacePort, EditorViewRef, ViewEvent, EditorBindingSpec, ExternalReloadHandler } from "./workspace";
export type {
	RelayPort, RelaySession, RelayConnectParams, RelayConnectResult, RelayLimits, RelayEvent,
	AppendFrame, CommittedFrame, RelayRow, FeedPage, ReadPage, PutCheckpointResult, RefusalReason,
} from "./relay";
export type { StoragePort, StorageDb, StorageTx, StorageKey, KeyRange, StoreSpec, SchemaShape, StoreName, StorageFailure, StorageError } from "./storage";
export { isStorageError } from "./storage";

import type { ClockPort } from "./clock";
import type { RandomPort } from "./random";
import type { CryptoPort, HashPort } from "./crypto";
import type { BlobPort } from "./blob";
import type { PlatformPort } from "./platform";
import type { VaultPort, ConfigDirPort, SideFilePort } from "./vault";
import type { WorkspacePort } from "./workspace";
import type { RelayPort } from "./relay";
import type { StoragePort } from "./storage";

/** Ports the engine (worker, or inline) is constructed with. No vault access: that goes over the protocol. */
export interface EnginePorts {
	readonly relay: RelayPort;
	readonly storage: StoragePort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	/** null = no blob store; attachments ride the log up to MAX_LOG_BLOB_BYTES. */
	readonly blob: BlobPort | null;
}

/** Ports the host (Obsidian main thread) is constructed with. */
export interface HostPorts {
	readonly vault: VaultPort;
	readonly configDir: ConfigDirPort;
	readonly sideFiles: SideFilePort;
	readonly workspace: WorkspacePort;
	readonly platform: PlatformPort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly hash: HashPort;
}
