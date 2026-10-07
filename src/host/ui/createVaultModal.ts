/**
 * "Create a new vault" (e2ee-design §15.1) as a modal; the logic is createVault.ts. Reached only from the command
 * and the settings action of the same name (registerUi.ts), never from a link, a code or a resumed enrollment.
 *
 *   server     the server URL, probed for whether it is claimed
 *   account    unclaimed: an operator key generated here, with Copy and an "I saved it" box that enables the claim;
 *              claimed: the operator key typed in, and a vault name. Either way the key lives in this modal's memory
 *              only until step 1 has run.
 *   check      "Checking that the new vault is empty…" (status.e2ee.creatable), or NOT_EMPTY_MESSAGE
 *   choice     "End-to-end encryption: On" preselected, or the opt-out (decision D2), confirmed
 *
 * "Finish creating this vault" opens the same modal at `check` for the vault named by the `creating` marker.
 *
 * SECRETS: the operator key (shown once when generated here, since handing it to the user is the point; never
 * logged, never stored), the owner code (never displayed), the recovery key (RecoveryKeyModal).
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type { YaosUiHost } from "./api";
import { confirmAction } from "./confirmModal";
import {
	confirmEmptyVault, createAndEnroll, CreateVaultError, enableEncryption, optOutOfEncryption, probeServer, resumableCreation,
	type ProbedServer,
} from "./createVault";
import { DEVICE_NAME_HINT, STORE_RK_ADVICE } from "./e2eeText";
import { errorMessage } from "./format";
import { askNewRecoveryKey } from "./keyModals";
import { copyText, obsidianRequest } from "./obsidianEnv";
import { generateOperatorKey, MAX_VAULT_NAME_CHARS, retireDeviceEnrollment, type RequestFn } from "./pairing";

export interface CreateVaultModalOptions {
	/** Open at the check step for the vault this device was creating (crash recovery, §15.1). */
	readonly resume?: boolean;
	readonly request?: RequestFn;
}

export class CreateVaultModal extends Modal {
	private readonly request: RequestFn;
	private open_ = false;
	private busy = false;
	private serverValue: string;
	private server: ProbedServer | null = null;
	/** SECRET, memory only, cleared once step 1 has run or the modal closes. */
	private operatorKey = "";
	private vaultName: string;
	private deviceName: string;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private readonly host: YaosUiHost, private readonly opts: CreateVaultModalOptions = {}) {
		super(app);
		this.request = opts.request ?? obsidianRequest;
		const data = host.data();
		this.serverValue = data.identity?.host ?? "";
		this.vaultName = app.vault.getName().slice(0, MAX_VAULT_NAME_CHARS);
		this.deviceName = data.deviceLabel;
	}

	onOpen(): void {
		this.open_ = true;
		this.contentEl.addClass("yaos-create-vault-modal");
		this.setTitle("Create a new vault");
		if (!this.opts.resume) {
			this.showServer();
			return;
		}
		const vaultId = resumableCreation(this.host.data());
		if (vaultId === null) {
			this.contentEl.empty();
			this.contentEl.createEl("p", { text: "This device has no vault creation to finish." });
			return;
		}
		void this.check(vaultId);
	}

	private reset(): HTMLElement {
		const { contentEl } = this;
		contentEl.empty();
		this.statusEl = null;
		return contentEl;
	}

	private status(el: HTMLElement): void {
		this.statusEl = el.createEl("p", { cls: "yaos-pair-status" });
	}

	private setStatus(text: string, warn: boolean): void {
		if (!this.open_ || !this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("mod-warning", warn);
	}

	// -- server --------------------------------------------------------------------------------------------------

	private showServer(): void {
		const el = this.reset();
		el.createEl("p", {
			text: "Creates an empty vault on your server and pairs this device with it. This folder's notes become the new vault's first notes. To join a vault that already exists, use \"Pair this device\" instead.",
		});
		if (this.host.data().identity) {
			el.createEl("p", {
				cls: "mod-warning",
				text: "This device is already paired. Creating a new vault replaces its pairing: this folder then syncs with the new vault, and YAOS asks the old server to remove this device's old membership. Notes on disk are not deleted.",
			});
		}
		let next: ButtonComponent | null = null;
		new Setting(el)
			.setName("Server URL")
			.setDesc("Your YAOS server. A server that is not set up yet is set up now, with this vault as its first.")
			.addText((t) => {
				t.setPlaceholder("https://sync.example.com").setValue(this.serverValue).onChange((v) => { this.serverValue = v; });
				t.inputEl.autocomplete = "off";
				t.inputEl.spellcheck = false;
				t.inputEl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") next?.buttonEl.click(); });
			});
		this.status(el);
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				next = b;
				b.setButtonText("Continue").setCta().onClick(async () => {
					if (this.busy) return;
					this.busy = true;
					b.setDisabled(true);
					this.setStatus("Contacting the server…", false);
					try {
						this.server = await probeServer(this.serverValue, { request: this.request });
						if (this.open_) this.showAccount();
					} catch (err) {
						this.setStatus(errorMessage(err), true);
					} finally {
						this.busy = false;
						b.setDisabled(false);
					}
				});
			});
	}

	// -- account (step 1 input) ----------------------------------------------------------------------------------

	private showAccount(): void {
		const server = this.server;
		if (!server) return this.showServer();
		const el = this.reset();
		let create: ButtonComponent | null = null;
		let saved = false;
		const ready = (): boolean => (server.claimed ? this.operatorKey.trim().length > 0 : saved);
		const refresh = (): void => { create?.setDisabled(!ready()); };

		if (!server.claimed) {
			this.operatorKey = generateOperatorKey();
			el.createEl("p", {
				text: `${server.host} is not set up yet. YAOS made an operator key for it: it opens the server console, where you add and remove devices and vaults. YAOS does not keep it, and the server cannot show it again.`,
			});
			el.createEl("p", { cls: "mod-warning", text: `${STORE_RK_ADVICE}.` });
			el.createEl("pre", { cls: "yaos-operator-key yaos-mono", text: this.operatorKey });
			new Setting(el)
				.setName("Operator key")
				.addButton((b) => b.setButtonText("Copy").onClick(() => {
					copyText(this.operatorKey).then(() => new Notice("Operator key copied."), () => new Notice("Could not copy the operator key. Write it down instead.", 6000));
				}));
			new Setting(el)
				.setName("I saved the operator key")
				.addToggle((t) => t.setValue(false).onChange((v) => { saved = v; refresh(); }));
		} else {
			el.createEl("p", { text: `${server.host} is set up. Enter its operator key to create a vault on it. YAOS uses the key once and does not keep it.` });
			new Setting(el)
				.setName("Operator key")
				.addText((t) => {
					t.setPlaceholder("Operator key").onChange((v) => { this.operatorKey = v; refresh(); });
					t.inputEl.type = "password";
					t.inputEl.autocomplete = "off";
					t.inputEl.spellcheck = false;
				});
			new Setting(el)
				.setName("Vault name")
				.setDesc("Shown in your server console.")
				.addText((t) => {
					t.setValue(this.vaultName).onChange((v) => { this.vaultName = v; });
					t.inputEl.maxLength = MAX_VAULT_NAME_CHARS;
				});
		}
		new Setting(el)
			.setName("Device name")
			.setDesc(`${DEVICE_NAME_HINT}. Also used in this device's conflict copy names.`)
			.addText((t) => t.setPlaceholder("My laptop").setValue(this.deviceName).onChange((v) => { this.deviceName = v; }));
		this.status(el);
		new Setting(el)
			.addButton((b) => b.setButtonText("Back").onClick(() => {
				if (this.busy) return;
				this.operatorKey = "";
				this.showServer();
			}))
			.addButton((b) => {
				create = b;
				b.setButtonText(server.claimed ? "Create vault" : "Set up the server").setCta().setDisabled(!ready()).onClick(() => { void this.create(server); });
			});
	}

	private async create(server: ProbedServer): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const operatorKey = this.operatorKey;
		this.setStatus("Creating the vault…", false);
		try {
			const result = await createAndEnroll(
				{ server, operatorKey, vaultName: this.vaultName, deviceName: this.deviceName },
				this.host,
				{ request: this.request, onProgress: (text) => this.setStatus(text, false) },
			);
			this.operatorKey = "";
			if (result.replaced) {
				retireDeviceEnrollment(result.replaced, { request: this.request }).catch((err: unknown) => new Notice(`YAOS: ${errorMessage(err)}`, 9000));
			}
			if (this.open_) void this.check(result.vaultId);
			else new Notice("YAOS: the new vault exists. Open YAOS settings and choose \"Finish creating this vault\".", 10000);
		} catch (err) {
			this.setStatus(errorMessage(err), true);
			if (!this.open_) new Notice(`YAOS: ${errorMessage(err)}`, 9000);
		} finally {
			this.busy = false;
		}
	}

	// -- check (step 3) ------------------------------------------------------------------------------------------

	private async check(vaultId: string): Promise<void> {
		const el = this.reset();
		el.createEl("p", { text: "Checking that the new vault is empty…" });
		this.status(el);
		try {
			await confirmEmptyVault(this.host, vaultId);
			if (this.open_) this.showChoice(vaultId);
		} catch (err) {
			if (!this.open_) return;
			this.failed(err, vaultId);
		}
	}

	private failed(err: unknown, vaultId: string): void {
		const el = this.reset();
		el.createEl("p", { cls: "mod-warning", text: errorMessage(err) });
		const buttons = new Setting(el).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
		if (err instanceof CreateVaultError && err.code === "unconfirmed") {
			buttons.addButton((b) => b.setButtonText("Try again").setCta().onClick(() => { void this.check(vaultId); }));
		}
	}

	// -- choice (D2) ---------------------------------------------------------------------------------------------

	private showChoice(vaultId: string): void {
		const el = this.reset();
		el.createEl("p", { text: "The new vault is empty. Choose how it syncs. You cannot change this later for this vault." });
		let encrypt = true;
		const group = el.createDiv({ cls: "yaos-e2ee-choice", attr: { role: "radiogroup" } });
		const option = (value: boolean, label: string, desc: string): void => {
			const row = group.createEl("label", { cls: "yaos-e2ee-choice-option" });
			const input = row.createEl("input", { attr: { type: "radio", name: "yaos-e2ee" } });
			input.checked = value === encrypt;
			input.addEventListener("change", () => { if (input.checked) encrypt = value; });
			const text = row.createDiv();
			text.createEl("strong", { text: label });
			text.createEl("div", { cls: "setting-item-description", text: desc });
		};
		option(true, "End-to-end encryption: On (recommended)", "Notes and attachments are encrypted on your devices. Your server stores them but cannot read them. You get a recovery key to save.");
		option(false, "End-to-end encryption: Off", "Your server can read this vault's notes and attachments.");
		this.status(el);
		new Setting(el).addButton((b) => b.setButtonText("Continue").setCta().onClick(async () => {
			if (this.busy) return;
			this.busy = true;
			b.setDisabled(true);
			try {
				if (encrypt) await this.turnOn(vaultId);
				else await this.turnOff(vaultId);
			} finally {
				this.busy = false;
				b.setDisabled(false);
			}
		}));
	}

	private async turnOn(vaultId: string): Promise<void> {
		const rk = await askNewRecoveryKey(this.app, this.host, {
			title: "Recovery key",
			intro: "This is the new vault's recovery key. With it, a device that has no other way in (all your devices lost or reset) can open the vault again.",
			confirmText: "Turn on encryption",
		});
		if (!rk) {
			this.setStatus("Nothing was decided yet. Continue when you are ready to save a recovery key.", false);
			return;
		}
		this.setStatus("Turning on end-to-end encryption…", false);
		try {
			await enableEncryption(this.host, vaultId, rk);
			new Notice("YAOS: the new vault is end-to-end encrypted.", 8000);
			if (this.open_) this.close();
		} catch (err) {
			this.choiceFailed(err, vaultId);
		}
	}

	private async turnOff(vaultId: string): Promise<void> {
		const ok = await confirmAction(this.app, {
			title: "Sync without end-to-end encryption?",
			message: "Your server will be able to read this vault's notes and attachments. You cannot turn end-to-end encryption on later for this vault.",
			confirmText: "Sync without encryption",
		});
		if (!ok) return;
		this.setStatus("Saving your choice…", false);
		try {
			await optOutOfEncryption(this.host, vaultId);
			new Notice("YAOS: the new vault syncs without end-to-end encryption.", 8000);
			if (this.open_) this.close();
		} catch (err) {
			this.choiceFailed(err, vaultId);
		}
	}

	private choiceFailed(err: unknown, vaultId: string): void {
		if (!this.open_) {
			new Notice(`YAOS: ${errorMessage(err)}`, 9000);
			return;
		}
		if (err instanceof CreateVaultError && err.code !== "unconfirmed") this.failed(err, vaultId);
		else this.setStatus(errorMessage(err), true);
	}

	onClose(): void {
		this.open_ = false;
		this.operatorKey = "";
		this.contentEl.empty();
		this.statusEl = null;
	}
}
