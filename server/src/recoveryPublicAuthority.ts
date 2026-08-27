import {
	RECOVERY_PUBLIC_RPC_HEADER,
	RECOVERY_PUBLIC_RPC_PATH,
	RECOVERY_RPC_MAX_JSON_BYTES,
	decodeRecoveryRpcPayload,
	encodeRecoveryRpcPayload,
	type CaptureStarted,
	type CaptureStatus,
	type RecoverySnapshotCatalogEntry,
} from "./recoveryProtocol";
import type { RetainedSnapshotRoot } from "./recoveryReadService";
import type { RecoveryRouteAuthority, RestoreItemResult, StartRestoreRequest } from "./recoveryRoutes";
import type { VaultRuntimeStubPort } from "./routes/types";

const encoder = new TextEncoder();

export class DurableRecoveryRouteAuthority implements RecoveryRouteAuthority {
	constructor(
		private readonly stub: VaultRuntimeStubPort,
		private readonly vaultId: string,
		private readonly vaultGeneration: string,
	) {}

	private async call<T>(method: string, params: unknown): Promise<T> {
		const body = JSON.stringify({ method, params: encodeRecoveryRpcPayload(params) });
		if (encoder.encode(body).byteLength > RECOVERY_RPC_MAX_JSON_BYTES) throw new Error("recovery request too large");
		const response = await this.stub.fetch(new Request(`https://internal${RECOVERY_PUBLIC_RPC_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[RECOVERY_PUBLIC_RPC_HEADER]: "1",
				"x-yaos-vault-id": this.vaultId,
				"x-yaos-vault-generation": this.vaultGeneration,
			},
			body,
		}));
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > RECOVERY_RPC_MAX_JSON_BYTES) throw new Error("recovery response too large");
		let envelope: unknown;
		try {
			envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		} catch {
			throw new Error(`recovery authority returned invalid JSON (${response.status})`);
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
			throw new Error("recovery authority returned invalid response");
		}
		const record = envelope as Record<string, unknown>;
		if (record.ok !== true) {
			const error = record.error;
			const message = error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
				? String((error as Record<string, unknown>).message).slice(0, 512)
				: `recovery authority failed (${response.status})`;
			throw new Error(message);
		}
		return decodeRecoveryRpcPayload(record.result) as T;
	}

	startRecoveryCapture(input: { vaultId: string; reason: "daily" | "manual" | "pre-bulk-operation"; requestId: string }) {
		return this.call<CaptureStarted>("startRecoveryCapture", input);
	}
	getRecoveryCaptureStatus(input: { vaultId: string; captureId: string }) {
		return this.call<CaptureStatus | null>("getRecoveryCaptureStatus", input);
	}
	cancelRecoveryCapture(input: { vaultId: string; captureId: string }) { return this.call<unknown>("cancelRecoveryCapture", input); }
	listRecoverySnapshots(input: { vaultId: string; cursor: string | null; limit: number }) {
		return this.call<{ snapshots: RecoverySnapshotCatalogEntry[]; nextCursor: string | null }>("listRecoverySnapshots", input);
	}
	authorizeRecoverySnapshotRead(input: { vaultId: string; snapshotId: string }) {
		return this.call<RetainedSnapshotRoot | null>("authorizeRecoverySnapshotRead", input);
	}
	deleteRecoverySnapshot(input: { vaultId: string; snapshotId: string }) {
		return this.call<{ deleted: boolean }>("deleteRecoverySnapshot", input);
	}
	startRecoveryRestore(input: { vaultId: string } & StartRestoreRequest) { return this.call<unknown>("startRecoveryRestore", input); }
	getRecoveryRestoreStatus(input: { vaultId: string; restoreId: string }) { return this.call<unknown>("getRecoveryRestoreStatus", input); }
	listRecoveryRestoreItems(input: { vaultId: string; restoreId: string; cursor: string | null; limit: number }) {
		return this.call<unknown>("listRecoveryRestoreItems", input);
	}
	async getRecoveryRestoreItemContent(input: { vaultId: string; restoreId: string; itemId: string }): Promise<Response> {
		const body = JSON.stringify({ method: "getRecoveryRestoreItemContent", params: input });
		return this.stub.fetch(new Request(`https://internal${RECOVERY_PUBLIC_RPC_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[RECOVERY_PUBLIC_RPC_HEADER]: "1",
				"x-yaos-vault-id": this.vaultId,
				"x-yaos-vault-generation": this.vaultGeneration,
			},
			body,
		}));
	}
	recordRecoveryRestoreResults(input: { vaultId: string; restoreId: string; results: RestoreItemResult[] }) {
		return this.call<unknown>("recordRecoveryRestoreResults", input);
	}
	cancelRecoveryRestore(input: { vaultId: string; restoreId: string }) { return this.call<unknown>("cancelRecoveryRestore", input); }
	applyRecoveryRetention(input: { vaultId: string; policy: Record<string, unknown> }) { return this.call<unknown>("applyRecoveryRetention", input); }
	startRecoveryGc(input: { vaultId: string; requestId: string }) { return this.call<unknown>("startRecoveryGc", input); }
	getRecoveryStatus(input: { vaultId: string }) { return this.call<unknown>("getRecoveryStatus", input); }
}
