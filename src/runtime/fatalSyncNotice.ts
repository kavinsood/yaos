import type { FatalAuthCode } from "../sync/fatalAuth";

export interface FatalSyncNotice {
	message: string;
	timeout?: number;
}

export interface FatalSyncNoticeDetails {
	clientSchemaVersion: number | null;
	roomSchemaVersion: number | null;
	reason: string | null;
}

export function getFatalSyncNotice(
	code: FatalAuthCode | null,
	details: FatalSyncNoticeDetails | null,
): FatalSyncNotice {
	switch (code) {
		case "unclaimed":
			return {
				message: "This server is unclaimed. Open the server URL in a browser, then use the setup link.",
				timeout: 10_000,
			};
		case "server_misconfigured":
			return { message: "Server misconfigured." };
		case "server_format_unsupported":
			return {
				message:
					"YAOS: this server uses an unsupported configuration format and cannot authenticate devices. " +
					"Open the server console to repair or replace its configuration.",
				timeout: 12_000,
			};
		case "update_required": {
			const detailText = details && (
				details.roomSchemaVersion !== null ||
				details.clientSchemaVersion !== null
			)
				? ` (client=${details.clientSchemaVersion ?? "unknown"}, room=${details.roomSchemaVersion ?? "unknown"})`
				: "";
			return {
				message:
					`YAOS: this vault was upgraded by a newer plugin schema${detailText}. ` +
					"Update YAOS on this device to continue syncing.",
				timeout: 12_000,
			};
		}
		case "unauthorized":
		default:
			return { message: "Unauthorized. Re-enroll this device with a fresh pairing code." };
	}
}
