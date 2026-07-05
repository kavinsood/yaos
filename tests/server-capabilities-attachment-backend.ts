import { parseServerCapabilities } from "../src/runtime/capabilityUpdateService";

const caps = parseServerCapabilities({
	claimed: true,
	authMode: "claim",
	attachments: true,
	snapshots: false,
	attachmentBackend: "do",
	maxBlobUploadBytes: 10 * 1024 * 1024,
	socketTicketAuth: true,
	serverVersion: "0.4.0",
	minPluginVersion: null,
	recommendedPluginVersion: null,
	minSchemaVersion: 3,
	maxSchemaVersion: 3,
	migrationRequired: false,
	updateProvider: null,
	updateRepoUrl: null,
});
if (caps?.attachmentBackend !== "do") {
	console.error("FAIL: attachmentBackend not parsed");
	process.exit(1);
}
console.log("PASS: attachmentBackend parsed");
