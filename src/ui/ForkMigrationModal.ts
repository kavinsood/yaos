import { App, Modal, Notice } from "obsidian";
import {
	buildGithubOpsBootstrapWorkflowYaml,
	normalizeReleaseRepo,
} from "../runtime/capabilityUpdateService";
import type { VaultSyncSettings } from "../settings/settingsStore";
import type { VaultSyncSettingsHost } from "../settings/settingsTab";

export type ForkMigrationMode = "migrate" | "revert";

const DEFAULT_RELEASE_REPO = "kavinsood/yaos";
const MIGRATE_PLACEHOLDER = "pixmuffin/yaos";
const RELEASE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MIGRATION_GUIDE_URL = "https://github.com/kavinsood/yaos/blob/main/docs/migrate-to-self-fork.md";

function parseReleaseRepoInput(input: string): string | null {
	let normalized = input.trim().replace(/^https:\/\/github\.com\//, "");
	normalized = normalized.replace(/\/+$/, "").replace(/\.git$/, "");
	return RELEASE_REPO_PATTERN.test(normalized) ? normalized : null;
}

async function copyToClipboard(text: string, successMessage: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(successMessage, 3000);
	} catch {
		new Notice("Failed to copy to clipboard.", 4000);
	}
}

function createWizardStep(
	containerEl: HTMLElement,
	stepNumber: number,
	title: string,
): { bodyEl: HTMLElement; actionsEl: HTMLElement } {
	const stepEl = containerEl.createDiv({ cls: "yaos-fork-migration-step" });
	const headerEl = stepEl.createDiv({ cls: "yaos-fork-migration-step-header" });
	headerEl.createSpan({
		text: String(stepNumber),
		cls: "yaos-fork-migration-step-number",
	});
	headerEl.createSpan({
		text: title,
		cls: "yaos-fork-migration-step-title",
	});
	const bodyEl = stepEl.createDiv({ cls: "yaos-fork-migration-step-body" });
	const actionsEl = stepEl.createDiv({ cls: "modal-button-container yaos-fork-migration-step-actions" });
	return { bodyEl, actionsEl };
}

export class ForkMigrationModal extends Modal {
	private forkInputEl: HTMLInputElement | null = null;
	private verifyStatusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly mode: ForkMigrationMode,
		private readonly host: VaultSyncSettingsHost,
		private readonly onSettingsChanged?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-fork-migration-modal");

		const title = this.mode === "migrate"
			? "Migrate to your fork"
			: "Revert to upstream";
		contentEl.createEl("h3", { text: title });
		contentEl.createEl("p", {
			text: this.mode === "migrate"
				? "Retarget your deployment repo and plugin updates to a fork you control. Your Worker URL, token, and vault stay the same."
				: "Restore upstream kavinsood/yaos as the release source and Ops workflow target.",
			cls: "yaos-modal-copy",
		});

		this.renderPrerequisitesStep(contentEl);
		this.renderSaveReleaseSourceStep(contentEl);
		this.renderRetargetOpsStep(contentEl);
		this.renderRunServerUpdateStep(contentEl);
		this.renderSwitchPluginStep(contentEl);
		this.renderVerifyStep(contentEl);

		contentEl.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "Close" })
			.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.forkInputEl = null;
		this.verifyStatusEl = null;
	}

	private getReleaseRepo(): string {
		const raw = this.forkInputEl?.value ?? this.defaultForkValue();
		return parseReleaseRepoInput(raw) ?? normalizeReleaseRepo(raw);
	}

	private defaultForkValue(): string {
		if (this.mode === "revert") {
			return DEFAULT_RELEASE_REPO;
		}
		const saved = this.host.settings.releaseSourceRepo.trim();
		if (saved) {
			return saved;
		}
		return "";
	}

	private hasDeployRepo(): boolean {
		return this.host.settings.updateRepoUrl.trim().length > 0;
	}

	private renderPrerequisitesStep(containerEl: HTMLElement): void {
		const { bodyEl } = createWizardStep(containerEl, 1, "Prerequisites");

		bodyEl.createEl("p", {
			text: "Confirm your fork and deployment repo before continuing.",
			cls: "yaos-fork-migration-step-copy",
		});

		const forkLabel = bodyEl.createEl("label", {
			text: this.mode === "migrate" ? "Fork URL" : "Upstream release repo",
			cls: "yaos-fork-migration-input-label",
		});
		this.forkInputEl = bodyEl.createEl("input", {
			cls: "yaos-fork-migration-input",
			type: "text",
		});
		this.forkInputEl.placeholder = this.mode === "migrate"
			? MIGRATE_PLACEHOLDER
			: DEFAULT_RELEASE_REPO;
		this.forkInputEl.value = this.defaultForkValue();
		if (this.mode === "revert") {
			this.forkInputEl.readOnly = true;
		}
		forkLabel.appendChild(this.forkInputEl);

		const checklist = bodyEl.createEl("ul", { cls: "yaos-fork-migration-checklist" });
		checklist.createEl("li", {
			text: this.mode === "migrate"
				? "Your fork should have a GitHub Release with yaos-server.zip (and plugin assets if you are switching the client)."
				: "Upstream releases remain on kavinsood/yaos.",
		});
		checklist.createEl("li", {
			text: "Deployment repo URL must already be set in Advanced settings (same requirement as Initialize updater).",
		});

		const deployStatus = bodyEl.createDiv({ cls: "yaos-fork-migration-status-line" });
		deployStatus.createSpan({
			text: "Deployment repo",
			cls: "yaos-fork-migration-status-label",
		});
		deployStatus.createSpan({
			text: this.hasDeployRepo()
				? this.host.settings.updateRepoUrl.trim()
				: "Not configured",
			cls: this.hasDeployRepo()
				? "yaos-fork-migration-status-value"
				: "yaos-fork-migration-status-warning",
		});
	}

	private renderSaveReleaseSourceStep(containerEl: HTMLElement): void {
		const { bodyEl, actionsEl } = createWizardStep(containerEl, 2, "Save release source");

		bodyEl.createEl("p", {
			text: "Persist the release source repo in YAOS settings. The detached deployment repo URL stays unchanged.",
			cls: "yaos-fork-migration-step-copy",
		});

		const current = bodyEl.createDiv({ cls: "yaos-fork-migration-status-line" });
		current.createSpan({
			text: "Current release source",
			cls: "yaos-fork-migration-status-label",
		});
		current.createSpan({
			text: this.host.settings.releaseSourceRepo.trim() || `${DEFAULT_RELEASE_REPO} (upstream default)`,
			cls: "yaos-fork-migration-status-value",
		});

		actionsEl.createEl("button", { text: "Save release source" }).addEventListener("click", () => {
			void this.saveReleaseSource();
		});
	}

	private renderRetargetOpsStep(containerEl: HTMLElement): void {
		const { bodyEl, actionsEl } = createWizardStep(containerEl, 3, "Retarget Ops workflow");

		bodyEl.createEl("p", {
			text: "Update yaos-ops.yml in your deployment repo so server updates pull from the selected release source.",
			cls: "yaos-fork-migration-step-copy",
		});
		bodyEl.createEl("p", {
			text: "Copy the YAML, open GitHub with the prefilled file, then click Commit on GitHub before running the workflow.",
			cls: "yaos-fork-migration-step-hint",
		});

		actionsEl.createEl("button", { text: "Copy YAML" }).addEventListener("click", () => {
			const yaml = buildGithubOpsBootstrapWorkflowYaml(this.getReleaseRepo());
			void copyToClipboard(yaml, "Ops workflow YAML copied.");
		});

		actionsEl.createEl("button", { text: "Open GitHub (create)" }).addEventListener("click", () => {
			const url = this.host.buildForkMigrationBootstrapUrl(this.getReleaseRepo());
			if (!url) {
				new Notice("Set a GitHub deployment repo URL in Advanced settings first.", 6000);
				return;
			}
			window.open(url, "_blank", "noopener");
		});

		actionsEl.createEl("button", { text: "Open edit" }).addEventListener("click", () => {
			const url = this.host.buildForkMigrationEditUrl();
			if (!url) {
				new Notice("Set a GitHub deployment repo URL in Advanced settings first.", 6000);
				return;
			}
			window.open(url, "_blank", "noopener");
		});
	}

	private renderRunServerUpdateStep(containerEl: HTMLElement): void {
		const { bodyEl, actionsEl } = createWizardStep(containerEl, 4, "Run server update");

		bodyEl.createEl("p", {
			text: "Open the Ops workflow in your deployment repo and run it with action=update. Leave version empty to use the latest release, or pin a tag.",
			cls: "yaos-fork-migration-step-copy",
		});
		bodyEl.createEl("p", {
			text: `release_repo defaults to ${this.mode === "revert" ? DEFAULT_RELEASE_REPO : "your fork"} from the committed YAML.`,
			cls: "yaos-fork-migration-step-hint",
		});

		actionsEl.createEl("button", { text: "Open Ops workflow" }).addEventListener("click", () => {
			const updateState = this.host.getUpdateState();
			const url = updateState.updateActionUrl;
			if (!url) {
				new Notice("Set a GitHub deployment repo URL in Advanced settings first.", 6000);
				return;
			}
			window.open(url, "_blank", "noopener");
		});
	}

	private renderSwitchPluginStep(containerEl: HTMLElement): void {
		const { bodyEl, actionsEl } = createWizardStep(containerEl, 5, "Switch plugin (client)");

		if (this.mode === "migrate") {
			bodyEl.createEl("p", {
				text: "Install BRAT, add your fork as a beta plugin, disable the Marketplace YAOS plugin, then reconnect with the same host, token, and vault ID.",
				cls: "yaos-fork-migration-step-copy",
			});
		} else {
			bodyEl.createEl("p", {
				text: "Switch back to the Marketplace YAOS plugin or BRAT pointing at kavinsood/yaos, then reconnect with the same host, token, and vault ID.",
				cls: "yaos-fork-migration-step-copy",
			});
		}

		const guideLink = bodyEl.createEl("a", {
			text: "Full migration guide",
			href: MIGRATION_GUIDE_URL,
		});
		guideLink.setAttr("target", "_blank");

		actionsEl.createEl("button", { text: "Copy BRAT add URL" }).addEventListener("click", () => {
			const releaseRepo = this.getReleaseRepo();
			void copyToClipboard(
				`https://github.com/${releaseRepo}`,
				"BRAT add URL copied.",
			);
		});
	}

	private renderVerifyStep(containerEl: HTMLElement): void {
		const { bodyEl, actionsEl } = createWizardStep(containerEl, 6, "Verify");

		bodyEl.createEl("p", {
			text: "Refresh server capabilities and confirm the Worker host is unchanged and sync is not Unauthorized.",
			cls: "yaos-fork-migration-step-copy",
		});

		this.verifyStatusEl = bodyEl.createDiv({ cls: "yaos-fork-migration-verify-status" });
		this.renderVerifyStatus("Not refreshed yet.");

		actionsEl.createEl("button", { text: "Refresh capabilities" }).addEventListener("click", () => {
			void this.refreshCapabilities();
		});
	}

	private renderVerifyStatus(message: string): void {
		if (!this.verifyStatusEl) return;
		this.verifyStatusEl.empty();
		this.verifyStatusEl.setText(message);
	}

	private async saveReleaseSource(): Promise<void> {
		if (!this.hasDeployRepo()) {
			new Notice("Set the deployment repo URL in Advanced settings first.", 6000);
			return;
		}

		const releaseRepo = this.getReleaseRepo();
		if (this.mode === "migrate" && !parseReleaseRepoInput(this.forkInputEl?.value ?? "")) {
			new Notice(`Enter a valid fork URL like ${MIGRATE_PLACEHOLDER}.`, 6000);
			return;
		}

		await this.host.updateSettings((settings: VaultSyncSettings) => {
			settings.releaseSourceRepo = releaseRepo;
		}, this.mode === "migrate" ? "fork-migration:save-release-source" : "fork-migration:revert-release-source");
		new Notice(`Release source saved as ${releaseRepo}.`, 4000);
		this.onSettingsChanged?.();
	}

	private async refreshCapabilities(): Promise<void> {
		this.renderVerifyStatus("Refreshing…");
		await this.host.refreshServerCapabilities("fork-migration-verify");
		const updateState = this.host.getUpdateState();
		const serverVersion = updateState.serverVersion ?? "Unknown";
		const attachmentBackend = this.host.attachmentBackend ?? "unknown";
		const host = this.host.settings.host.trim() || "(not set)";
		const statusSummary = this.host.getSettingsStatusSummary();
		const unauthorized = statusSummary.state === "unauthorized";

		const lines = [
			`Server version: ${serverVersion}`,
			`Attachment backend: ${attachmentBackend}`,
			`Worker host: ${host}`,
			unauthorized
				? "Status: Unauthorized — check your token."
				: `Status: ${statusSummary.label}`,
		];
		this.renderVerifyStatus(lines.join("\n"));

		if (!unauthorized && host !== "(not set)") {
			new Notice("Verification refresh complete.", 3000);
		}
	}
}
