import { type App, Notice, type RequestUrlParam } from "obsidian";
import type { PendingEnrollment, VaultSyncSettings } from "../settings/settingsStore";
import { randomId } from "../utils/randomId";
import { ConfirmModal } from "../ui/ConfirmModal";
import type { RuntimeTeardownCoordinator } from "./teardownLifecycle";

export interface EnrollmentMembership {
	host: string;
	deviceToken: string;
	vaultId: string;
	deviceId: string;
	vaultGeneration: string;
}

export interface SetupLinkControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	isMarkdownPathSyncable(path: string): boolean;
	updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason?: string,
	): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	startSyncAfterEnrollment(): Promise<void>;
	retireCurrentEnrollment(membership: EnrollmentMembership): Promise<void>;
	requestEnrollment(
		request: RequestUrlParam,
	): Promise<{ status: number; json: unknown }>;
	confirmEnrollmentReplacement?(title: string, message: string): Promise<boolean>;
}

interface EnrollmentResponse {
	host?: unknown;
	vaultId?: unknown;
	deviceId?: unknown;
	deviceToken?: unknown;
	deviceName?: unknown;
	vaultGeneration?: unknown;
	originImport?: unknown;
	error?: unknown;
	message?: unknown;
}

export class SetupLinkController {
	private enrollmentInFlight: { requestId: string; promise: Promise<boolean> } | null = null;

	constructor(private readonly deps: SetupLinkControllerDeps) {
		this.deps.app.workspace?.onLayoutReady(() => {
			if (this.deps.getSettings().pendingEnrollment) void this.resumePendingEnrollment();
		});
	}

	async handleSetupLink(params: Record<string, string>): Promise<void> {
		const action = typeof params.action === "string" ? params.action.trim() : "";
		const host = typeof params.host === "string" ? params.host.trim().replace(/\/$/, "") : "";
		const pairingCode = typeof params.pairingCode === "string" ? params.pairingCode.trim() : "";
		if (action !== "setup" || !host || !pairingCode) {
			new Notice("Setup link is missing action=setup, a host, or a pairing code.");
			return;
		}
		await this.enrollWithCode(host, pairingCode);
	}

	async resumePendingEnrollment(): Promise<boolean> {
		const pending = this.deps.getSettings().pendingEnrollment;
		if (!pending) return false;
		return this.runPendingEnrollment(pending);
	}

	async enrollWithCode(host: string, pairingCode: string): Promise<boolean> {
		const normalizedHost = host.trim().replace(/\/$/, "");
		const code = pairingCode.trim();
		if (!normalizedHost || !code) {
			new Notice("Enter the server URL and pairing code.");
			return false;
		}
		const currentSettings = this.deps.getSettings();
		const existingPending = currentSettings.pendingEnrollment;
		if (existingPending) {
			if (existingPending.host !== normalizedHost || existingPending.pairingCode !== code) {
				new Notice("A previous enrollment is still pending. The plugin will resume it before accepting another pairing code.", 8000);
				return false;
			}
			return this.runPendingEnrollment(existingPending);
		}

		const previousEnrollment = this.currentMembership(currentSettings);
		const hasExistingEnrollment = [
			previousEnrollment.vaultId,
			previousEnrollment.deviceId,
			previousEnrollment.deviceToken,
		].some(Boolean);
		if (hasExistingEnrollment) {
			const localMarkdownCount = this.deps.app.vault
				.getMarkdownFiles()
				.filter((file) => this.deps.isMarkdownPathSyncable(file.path))
				.length;
			let destinationOrigin = normalizedHost;
			try {
				destinationOrigin = new URL(normalizedHost).origin;
			} catch {
				// The request path reports invalid hosts after informed consent.
			}
			const confirmed = await this.confirmEnrollOverExisting(
				previousEnrollment.vaultId,
				localMarkdownCount,
				destinationOrigin,
			);
			if (!confirmed) {
				new Notice("Pairing cancelled.", 6000);
				return false;
			}
		}

		const pending: PendingEnrollment = {
			host: normalizedHost,
			pairingCode: code,
			enrollmentRequestId: randomId(22),
			deviceId: randomId(22),
			deviceToken: randomId(43),
			deviceName: currentSettings.deviceName.trim(),
		};
		try {
			await this.deps.updateSettings((settings) => {
				settings.pendingEnrollment = pending;
			}, "setup-enroll-pending");
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Could not save pending enrollment.", 8000);
			return false;
		}
		return this.runPendingEnrollment(pending);
	}

	private runPendingEnrollment(pending: PendingEnrollment): Promise<boolean> {
		if (this.enrollmentInFlight?.requestId === pending.enrollmentRequestId) {
			return this.enrollmentInFlight.promise;
		}
		const promise = this.completePendingEnrollment(pending).finally(() => {
			if (this.enrollmentInFlight?.requestId === pending.enrollmentRequestId) {
				this.enrollmentInFlight = null;
			}
		});
		this.enrollmentInFlight = { requestId: pending.enrollmentRequestId, promise };
		return promise;
	}

	private currentMembership(settings: VaultSyncSettings): EnrollmentMembership {
		return {
			host: settings.host.trim().replace(/\/$/, ""),
			deviceToken: settings.deviceToken.trim(),
			vaultId: settings.vaultId.trim(),
			deviceId: settings.deviceId.trim(),
			vaultGeneration: settings.vaultGeneration.trim(),
		};
	}

	private async completePendingEnrollment(pending: PendingEnrollment): Promise<boolean> {
		const previousEnrollment = this.currentMembership(this.deps.getSettings());
		const hasExistingEnrollment = [
			previousEnrollment.vaultId,
			previousEnrollment.deviceId,
			previousEnrollment.deviceToken,
		].some(Boolean);
		let enrolled: EnrollmentResponse;
		try {
			const res = await this.deps.requestEnrollment({
				url: `${pending.host}/enroll`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pairingCode: pending.pairingCode,
					enrollmentRequestId: pending.enrollmentRequestId,
					deviceId: pending.deviceId,
					deviceToken: pending.deviceToken,
					...(pending.deviceName ? { deviceName: pending.deviceName } : {}),
				}),
			});
			const raw: unknown = res.json;
			enrolled = raw && typeof raw === "object" ? raw as EnrollmentResponse : {};
			if (res.status !== 200) {
				new Notice(
					typeof enrolled.message === "string" ? enrolled.message : enrollErrorCopy(enrolled.error),
					8000,
				);
				return false;
			}
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Enroll failed", 8000);
			return false;
		}

		if (
			typeof enrolled.host !== "string" || !enrolled.host.trim()
			|| typeof enrolled.vaultId !== "string" || !enrolled.vaultId.trim()
			|| enrolled.deviceId !== pending.deviceId
			|| enrolled.deviceToken !== pending.deviceToken
			|| typeof enrolled.deviceName !== "string" || !enrolled.deviceName.trim()
			|| typeof enrolled.vaultGeneration !== "string" || !enrolled.vaultGeneration.trim()
			|| typeof enrolled.originImport !== "boolean"
		) {
			new Notice("Server did not return complete enrollment credentials.", 8000);
			return false;
		}
		const enrolledHost = enrolled.host.trim().replace(/\/$/, "");
		if (enrolledHost !== pending.host) {
			new Notice("Server returned enrollment credentials for a different host.", 8000);
			return false;
		}
		const nextEnrollment: EnrollmentMembership = {
			host: enrolledHost,
			deviceToken: pending.deviceToken,
			vaultId: enrolled.vaultId,
			deviceId: pending.deviceId,
			vaultGeneration: enrolled.vaultGeneration,
		};
		const enrollmentChanged = hasExistingEnrollment && (
			previousEnrollment.host !== nextEnrollment.host
			|| previousEnrollment.deviceToken !== nextEnrollment.deviceToken
			|| previousEnrollment.vaultId !== nextEnrollment.vaultId
			|| previousEnrollment.deviceId !== nextEnrollment.deviceId
			|| previousEnrollment.vaultGeneration !== nextEnrollment.vaultGeneration
		);
		if (enrollmentChanged) {
			try {
				await this.deps.retireCurrentEnrollment(previousEnrollment);
			} catch (err) {
				new Notice(err instanceof Error ? err.message : "Could not retire the current enrollment.", 8000);
				return false;
			}
		}

		try {
			await this.deps.updateSettings((settings) => {
				settings.host = nextEnrollment.host;
				settings.deviceToken = nextEnrollment.deviceToken;
				settings.vaultId = nextEnrollment.vaultId;
				settings.deviceId = nextEnrollment.deviceId;
				settings.vaultGeneration = nextEnrollment.vaultGeneration;
				settings.originImportPending = enrolled.originImport === true;
				settings.deviceName = enrolled.deviceName as string;
				settings.pendingEnrollment = null;
			}, "setup-enroll");
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Could not save enrollment credentials.", 8000);
			return false;
		}
		await this.deps.refreshServerCapabilities("setup-enroll");
		new Notice("This device is enrolled. Starting sync...", 6000);
		await this.deps.startSyncAfterEnrollment();
		return true;
	}

	private async confirmEnrollOverExisting(
		currentVaultId: string,
		localMarkdownCount: number,
		destinationOrigin: string,
	): Promise<boolean> {
		const title = "Replace this folder's enrollment?";
		const currentMembership = currentVaultId
			? ` in vault ${currentVaultId}`
			: "";
		const message =
			`This folder already has a server enrollment${currentMembership} and ` +
			`${localMarkdownCount} syncable local Markdown ${localMarkdownCount === 1 ? "file" : "files"}. ` +
			`Enrolling with ${destinationOrigin} will replace the enrollment used by this device, ` +
			`and all local content in this folder will sync to ${destinationOrigin}. ` +
			"YAOS will ask the old server to remove this device. If that fails, the old membership " +
			"remains active until you remove it from the old server's console.";
		if (this.deps.confirmEnrollmentReplacement) {
			return await this.deps.confirmEnrollmentReplacement(title, message);
		}
		return await new Promise<boolean>((resolve) => {
			new ConfirmModal(
				this.deps.app,
				title,
				message,
				() => resolve(true),
				"Replace enrollment",
				"Keep current enrollment",
				() => resolve(false),
			).open();
		});
	}
}

/**
 * Enrollment is an intentional in-process restart. A completed retirement or
 * Leave leaves the coordinator closed, so reopen it before initialization.
 */
export async function startEnrollmentRuntime(
	lifecycle: RuntimeTeardownCoordinator,
	initialize: () => Promise<void>,
): Promise<void> {
	if (lifecycle.isClosing && !lifecycle.reopenAfterTeardown()) {
		throw new Error("Sync teardown has not completed; enrollment cannot start yet.");
	}
	await initialize();
}

function enrollErrorCopy(code: unknown): string {
	if (code === "expired_code") return "This pairing code has expired. Ask for a new one.";
	if (code === "used_code") return "This pairing code was already used.";
	if (code === "unknown_code") return "This pairing code is not recognized.";
	return "Could not enroll this device.";
}
