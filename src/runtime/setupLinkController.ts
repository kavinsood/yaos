import { type App, Notice } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import { ConfirmModal } from "../ui/ConfirmModal";

interface SetupLinkControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	isMarkdownPathSyncable(path: string): boolean;
	updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason?: string,
	): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	hasSyncRuntime(): boolean;
	initSync(): void;
}

export class SetupLinkController {
	constructor(private readonly deps: SetupLinkControllerDeps) {}

	async handleSetupLink(params: Record<string, string>): Promise<void> {
		const host = typeof params.host === "string" ? params.host.trim() : "";
		const token = typeof params.token === "string" ? params.token.trim() : "";
		const incomingVaultId = typeof params.vaultId === "string" ? params.vaultId.trim() : "";
		if (!host || !token) {
			new Notice("Setup link is missing a host or token.");
			return;
		}
		if (!incomingVaultId) {
			new Notice(
				"Setup link is missing the vault ID. This may create a separate sync room on this device.",
				8000,
			);
		}

		const currentVaultId = this.deps.getSettings().vaultId?.trim() ?? "";
		if (incomingVaultId && currentVaultId && incomingVaultId !== currentVaultId) {
			const localMarkdownCount = this.deps.app.vault
				.getMarkdownFiles()
				.filter((file) => this.deps.isMarkdownPathSyncable(file.path))
				.length;
			if (localMarkdownCount > 5) {
				const confirmed = await this.confirmVaultIdSwitch(
					currentVaultId,
					incomingVaultId,
					localMarkdownCount,
				);
				if (!confirmed) {
					new Notice("Pairing cancelled. Vault ID unchanged.", 6000);
					return;
				}
			}
		}

		await this.deps.updateSettings((settings) => {
			settings.host = host.replace(/\/$/, "");
			settings.token = token;
			if (incomingVaultId) {
				settings.vaultId = incomingVaultId;
			}
		}, "setup-link");
		await this.deps.refreshServerCapabilities();
		new Notice("Server linked. Starting sync...", 6000);

		if (!this.deps.hasSyncRuntime()) {
			this.deps.initSync();
			return;
		}

		new Notice("Settings saved. Reload the plugin to reconnect with the new server.", 8000);
	}

	private async confirmVaultIdSwitch(
		currentVaultId: string,
		incomingVaultId: string,
		localMarkdownCount: number,
	): Promise<boolean> {
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.deps.app,
				"Switch vault ID",
				`This pairing link points to a different vault ID. ` +
					`Current vault ID: ${currentVaultId}. Incoming vault ID: ${incomingVaultId}. ` +
					`This vault currently has ${localMarkdownCount} local markdown files. ` +
					`Switching rooms may pull a different remote state. Continue and switch to the incoming vault ID?`,
				() => resolve(true),
				"Switch vault ID",
				"Keep current vault ID",
				() => resolve(false),
			).open();
		});
	}
}
