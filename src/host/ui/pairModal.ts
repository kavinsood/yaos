/**
 * Pairing modals: PairModal (join this device to a vault with a server URL + one-time code) and
 * the "pair another device" code display with an "Open pairing page" button. Ported from the old
 * client (adfa7a7:src/settings/PairDeviceModal.ts and the enrollment parts of
 * adfa7a7:src/settings/settingsTab.ts). No QR code: scripts/check-deps.mjs does not let the host
 * import the qrcode package.
 *
 * SECRETS: the pairing code input is a password field; codes and tokens are never logged. The
 * code shown by PairingCodeModal is displayed only because handing it to the other device is the
 * point of that dialog.
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type { YaosUiHost } from "./api";
import { errorMessage } from "./format";
import { copyText, obsidianRequest } from "./obsidianEnv";
import { applyPairedIdentity, formatCountdown, PairingSession } from "./pairFlow";
import { requestPairingCode, type PairingCodeGrant, type RequestFn } from "./pairing";

export interface PairPrefill {
	readonly host?: string;
	readonly pairingCode?: string;
}

export class PairModal extends Modal {
	private readonly session: PairingSession;
	private hostValue: string;
	private codeValue: string;
	private nameValue: string;
	private statusEl: HTMLElement | null = null;
	private pairButton: ButtonComponent | null = null;
	private open_ = false;

	constructor(
		app: App,
		private readonly host: YaosUiHost,
		prefill: PairPrefill = {},
		request: RequestFn = obsidianRequest,
	) {
		super(app);
		this.session = new PairingSession({ request, onProgress: (text) => this.setStatus(text, false) });
		const data = host.data();
		this.hostValue = prefill.host ?? data.identity?.host ?? "";
		this.codeValue = prefill.pairingCode ?? "";
		this.nameValue = data.deviceLabel;
	}

	onOpen(): void {
		this.open_ = true;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-pair-modal");
		this.setTitle("Pair this device");

		const current = this.host.data().identity;
		if (current) {
			contentEl.createEl("p", {
				cls: "mod-warning",
				text: `This device is already paired with ${current.host}. Pairing again replaces this device's credentials and syncs this folder with the vault of the new code. Notes on disk are not deleted.`,
			});
		}
		contentEl.createEl("p", {
			text: "Enter the server URL and a one-time pairing code. Create a code on a device that is already paired (YAOS settings, \"Pair another device\") or in your server's console.",
		});

		new Setting(contentEl)
			.setName("Server URL")
			.addText((text) => {
				text.setPlaceholder("https://sync.example.com").setValue(this.hostValue).onChange((v) => { this.hostValue = v; });
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
			});
		new Setting(contentEl)
			.setName("Pairing code")
			.setDesc("Works once and expires 15 minutes after it was created.")
			.addText((text) => {
				text.setPlaceholder("Paste the pairing code").setValue(this.codeValue).onChange((v) => { this.codeValue = v; });
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
			});
		new Setting(contentEl)
			.setName("Device name")
			.setDesc("Sent to your server, which lists it among the vault's devices, and used in this device's conflict copy names.")
			.addText((text) => {
				text.setPlaceholder("My laptop").setValue(this.nameValue).onChange((v) => { this.nameValue = v; });
			});

		this.statusEl = contentEl.createEl("p", { cls: "yaos-pair-status" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.pairButton = b;
				b.setButtonText(current ? "Replace pairing" : "Pair").onClick(() => { void this.submit(); });
				if (current) b.setWarning();
				else b.setCta();
			});
	}

	private setStatus(text: string, isError: boolean): void {
		if (!this.open_ || !this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("mod-warning", isError);
	}

	private async submit(): Promise<void> {
		if (this.session.busy) return;
		this.pairButton?.setDisabled(true);
		this.setStatus("Pairing…", false);
		try {
			const identity = await this.session.submit({ host: this.hostValue, pairingCode: this.codeValue, deviceName: this.nameValue });
			// Persist even if the modal was closed meanwhile: the server has already enrolled this
			// device and the code is spent, so dropping the result would strand it.
			await this.host.updateData((d) => applyPairedIdentity(d, identity));
			this.codeValue = "";
			new Notice(`YAOS: this device is now paired with ${identity.host}.`);
			if (this.open_) this.close();
		} catch (err) {
			this.setStatus(errorMessage(err), true);
			if (!this.open_) new Notice(`YAOS pairing failed: ${errorMessage(err)}`, 8000);
		} finally {
			this.pairButton?.setDisabled(false);
		}
	}

	onClose(): void {
		this.open_ = false;
		this.contentEl.empty();
		this.statusEl = null;
		this.pairButton = null;
		if (!this.session.busy) {
			this.session.clear();
			this.codeValue = "";
		}
	}
}

/** Shows a fresh one-time code for pairing another device, with copy buttons and an expiry countdown. */
export class PairingCodeModal extends Modal {
	private timer: number | null = null;
	private closed = false;

	constructor(app: App, private readonly host: YaosUiHost, private readonly request: RequestFn = obsidianRequest) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-pairing-code-modal");
		this.setTitle("Pair another device");
		const identity = this.host.data().identity;
		if (!identity) {
			contentEl.createEl("p", { text: "Pair this device first. Then you can create codes for your other devices here." });
			return;
		}
		const loading = contentEl.createEl("p", { text: "Creating a pairing code…" });
		requestPairingCode(identity, { request: this.request }).then(
			(grant) => {
				if (this.closed) return;
				loading.remove();
				this.renderGrant(grant);
			},
			(err: unknown) => {
				if (this.closed) return;
				loading.setText(`Could not create a pairing code: ${errorMessage(err)}`);
				loading.addClass("mod-warning");
			},
		);
	}

	private renderGrant(grant: PairingCodeGrant): void {
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "On the other device, open the setup link, or open YAOS settings, choose \"Pair this device\" and enter the server URL and this code. Anyone with this code can join your vault until it is used or expires, so share it only with your own device.",
		});

		const field = (label: string, value: string, rows: number): Setting => {
			const s = new Setting(contentEl).setName(label);
			s.settingEl.addClass("yaos-pairing-code-field");
			const area = contentEl.createEl("textarea", { cls: "yaos-pairing-code-value" });
			area.value = value;
			area.readOnly = true;
			area.rows = rows;
			area.addEventListener("focus", () => area.select());
			s.addButton((b) => b.setButtonText("Copy").onClick(() => {
				copyText(value).then(() => new Notice(`${label} copied.`), () => new Notice(`Could not copy the ${label.toLowerCase()}.`, 6000));
			}));
			return s;
		};
		field("Server URL", this.host.data().identity?.host ?? "", 1);
		field("Pairing code", grant.pairingCode, 2);
		field("Setup link", grant.setupLink, 3);
		const page = grant.mobileSetupUrl;
		// pairing.ts admits only a URL under the paired server's origin, so opening it is safe.
		if (page) field("Mobile setup page", page, 2).addButton((b) => b.setButtonText("Open pairing page").onClick(() => { window.open(page, "_blank", "noopener"); }));

		const expiry = contentEl.createEl("p", { cls: "yaos-pairing-code-expiry" });
		const tick = (): void => {
			const remaining = grant.expiresAt - Date.now();
			if (remaining <= 0) {
				expiry.setText("This code has expired. Close this dialog and create a new one.");
				expiry.addClass("mod-warning");
				this.stopTimer();
				return;
			}
			expiry.setText(`Expires in ${formatCountdown(remaining)}.`);
		};
		tick();
		this.timer = window.setInterval(tick, 1000);

		new Setting(contentEl).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
	}

	private stopTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	onClose(): void {
		this.closed = true;
		this.stopTimer();
		this.contentEl.empty();
	}
}

export function showPairingCodeModal(app: App, host: YaosUiHost, request: RequestFn = obsidianRequest): PairingCodeModal {
	const modal = new PairingCodeModal(app, host, request);
	modal.open();
	return modal;
}
