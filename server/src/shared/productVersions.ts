/**
 * Independent product format and wire-version pins.
 *
 * A change to one pin does not imply a change to any other pin. Compatibility
 * is exact until a future release deliberately defines a wider contract.
 */
export const SCHEMA_VERSION = 4;
export const STORAGE_FORMAT_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const SNAPSHOT_FORMAT_VERSION = 2;

export interface ProductVersions {
	schemaVersion: number;
	storageFormatVersion: number;
	protocolVersion: number;
	snapshotFormatVersion: number;
}

export const CURRENT_PRODUCT_VERSIONS: Readonly<ProductVersions> = Object.freeze({
	schemaVersion: SCHEMA_VERSION,
	storageFormatVersion: STORAGE_FORMAT_VERSION,
	protocolVersion: PROTOCOL_VERSION,
	snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
});

export type VersionCompatibility =
	| { compatible: true }
	| {
		compatible: false;
		error: "update_required";
		component: keyof ProductVersions;
		localVersion: number;
		remoteVersion: number;
	};

function exactVersion(
	component: keyof ProductVersions,
	localVersion: number,
	remoteVersion: number,
): VersionCompatibility {
	return localVersion === remoteVersion
		? { compatible: true }
		: {
			compatible: false,
			error: "update_required",
			component,
			localVersion,
			remoteVersion,
		};
}

/** Schema and wire protocol must both match before either peer may sync. */
export function negotiateSyncVersions(
	local: ProductVersions,
	remote: ProductVersions,
): VersionCompatibility {
	const schema = exactVersion("schemaVersion", local.schemaVersion, remote.schemaVersion);
	if (!schema.compatible) return schema;
	return exactVersion("protocolVersion", local.protocolVersion, remote.protocolVersion);
}

/** Snapshot decoding is admitted separately from live sync. */
export function negotiateSnapshotVersion(
	local: ProductVersions,
	remote: ProductVersions,
): VersionCompatibility {
	return exactVersion(
		"snapshotFormatVersion",
		local.snapshotFormatVersion,
		remote.snapshotFormatVersion,
	);
}

/** Durable storage rollback is safe only while the persisted format pin matches. */
export function negotiateStorageVersion(
	code: ProductVersions,
	persisted: ProductVersions,
): VersionCompatibility {
	return exactVersion(
		"storageFormatVersion",
		code.storageFormatVersion,
		persisted.storageFormatVersion,
	);
}
