import {
	CURRENT_PRODUCT_VERSIONS,
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	SNAPSHOT_FORMAT_VERSION,
	STORAGE_FORMAT_VERSION,
	SETTINGS_FORMAT_VERSION,
	negotiateSnapshotVersion,
	negotiateStorageVersion,
	negotiateSyncVersions,
	type ProductVersions,
} from "../../server/src/shared/productVersions";
import {
	MAX_CLIENT_MARKDOWN_BYTES,
	MAX_CLIENT_MARKDOWN_KB,
	MAX_DURABLE_UPDATE_BYTES,
} from "../../server/src/shared/durableLimits";
import { safeBlobPath, safeMarkdownPath } from "../../server/src/shared/vaultPath";
import type { DurableReceipt } from "../../server/src/contracts";
import {
	decodeCanonicalVaultIdSegment,
	isCanonicalVaultId,
	MAX_VAULT_ID_LENGTH,
	MIN_VAULT_ID_LENGTH,
} from "../../server/src/vaultId";
import type { VaultMetadata, VaultProvisioningResult } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("storage-kernel-reference");

s.section("Independent format pins");
s.check(
	SCHEMA_VERSION === 4
		&& STORAGE_FORMAT_VERSION === 1
		&& PROTOCOL_VERSION === 1
		&& SNAPSHOT_FORMAT_VERSION === 2
		&& SETTINGS_FORMAT_VERSION === 1,
	"schema/storage/protocol/snapshot/settings formats remain independently pinned to 4/1/1/2/1",
);

function withVersion(component: keyof ProductVersions, version: number): ProductVersions {
	return { ...CURRENT_PRODUCT_VERSIONS, [component]: version };
}

for (const component of ["schemaVersion", "protocolVersion"] as const) {
	const result = negotiateSyncVersions(CURRENT_PRODUCT_VERSIONS, withVersion(component, 2));
	s.check(
		!result.compatible && result.error === "update_required" && result.component === component,
		`${component} skew fails closed for live sync`,
	);
}
const storageSkew = negotiateStorageVersion(
	CURRENT_PRODUCT_VERSIONS,
	withVersion("storageFormatVersion", 2),
);
s.check(
	!storageSkew.compatible && storageSkew.component === "storageFormatVersion",
	"storage rollback rejects a mismatched durable format",
);
const snapshotSkew = negotiateSnapshotVersion(
	CURRENT_PRODUCT_VERSIONS,
	withVersion("snapshotFormatVersion", 1),
);
s.check(
	!snapshotSkew.compatible && snapshotSkew.component === "snapshotFormatVersion",
	"snapshot decoding rejects its own format skew",
);

s.section("Durable hard limits");
s.check(MAX_DURABLE_UPDATE_BYTES === 1_750_000, "durable update values retain the SQLite-safe bound");
s.check(MAX_CLIENT_MARKDOWN_BYTES === 1_500_000, "client markdown retains deterministic wire headroom");
s.check(
	MAX_CLIENT_MARKDOWN_KB === Math.floor(MAX_CLIENT_MARKDOWN_BYTES / 1024),
	"displayed markdown KB limit derives from the byte limit",
);

s.section("Canonical storage identities");
s.check(
	MIN_VAULT_ID_LENGTH === 8 && MAX_VAULT_ID_LENGTH === 256,
	"vault identity length bounds are explicit",
);
s.check(isCanonicalVaultId("vault-generation_01"), "safe opaque vault identities are canonical");
s.check(!isCanonicalVaultId(" short ") && !isCanonicalVaultId("vault/id"), "trimmed and path-like identities fail closed");
s.check(
	decodeCanonicalVaultIdSegment("vault-generation_01") === "vault-generation_01"
		&& decodeCanonicalVaultIdSegment("vault%2dgeneration_01") === null,
	"URL segments reject alternate encodings of one durable identity",
);
s.check(safeMarkdownPath("Notes/Entry.md") === "Notes/Entry.md", "canonical markdown paths are accepted");
s.check(safeMarkdownPath(".obsidian/plugins/data.md") === null, "Obsidian configuration paths are excluded");
s.check(safeMarkdownPath("CON/readme.md") === null, "platform-reserved path components are excluded");
s.check(safeMarkdownPath("Cafe\u0301.md") === null, "non-NFC paths are excluded");
s.check(
	safeBlobPath("assets/image.png", "", { hash: "a".repeat(64), size: 10 * 1024 * 1024 }) === "assets/image.png",
	"attachment references admit the exact maximum object size",
);
s.check(
	safeBlobPath("assets/image.png", "", { hash: "a".repeat(64), size: 10 * 1024 * 1024 + 1 }) === null,
	"attachment references reject objects beyond the hard limit",
);

s.section("Durable generation and runtime epoch are distinct");
const metadata: VaultMetadata = {
	vaultId: "vault-reference-01",
	vaultGeneration: "generation-reference-01",
	schemaVersion: 4,
	storageFormatVersion: 1,
	provisionedAt: 1,
};
const provisioning: VaultProvisioningResult = { ...metadata, created: true };
const receipt: DurableReceipt = {
	vaultId: metadata.vaultId,
	vaultGeneration: metadata.vaultGeneration,
	bodyId: "body-reference-01",
	clientId: "client-reference-01",
	candidateId: "candidate-reference-01",
	candidateDigest: "a".repeat(64),
	durableGeneration: 1,
	runtimeEpoch: "runtime-epoch-reference-01",
};
s.check(
	provisioning.vaultGeneration === receipt.vaultGeneration
		&& receipt.runtimeEpoch !== receipt.vaultGeneration,
	"persisted vaultGeneration is not the ephemeral runtimeEpoch",
);

await s.done();
