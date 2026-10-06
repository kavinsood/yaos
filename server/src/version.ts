// DECISIONS-GAP: §2.3 keeps version.ts (14 lines) but deletes shared/productVersions, the source of its schema,
// storage, protocol, snapshot and settings pins; §5 row 2.1 drops those pins from capabilities. Only the server
// version is left.
export const SERVER_VERSION = "1.0.0";
