/**
 * Pairing modals: PairModal (join this device to a vault with a server URL + one-time code) and PairingCodeModal
 * ("Pair another device": a fresh code, and on request a QR code the plugin draws itself). Ported from the old client
 * (adfa7a7:src/settings/PairDeviceModal.ts, QR at :40-65, and the enrollment parts of
 * adfa7a7:src/settings/settingsTab.ts). When a pairing replaces another, the old enrollment is revoked on its server
 * after the new one is stored.
 *
 * e2ee-design §12.1: the QR and the copied setup link carry this device's vault key (or `suite=0`) in a client-only
 * `key` param, which never reaches the server (`/enroll` gets only the code). The QR is drawn only after a click on
 * "Show pairing QR", and hidden when the code expires or the dialog closes. The server's mobile setup page is not
 * offered: a page the server draws can only carry a key-less join.
 *
 * SECRETS: the pairing code input is a password field; codes, tokens, keys and links are never logged or put in a
 * notice. The code shown by PairingCodeModal is displayed only because handing it to the other device is the point of
 * that dialog.
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import { sameIdentity, type PairedIdentity, type YaosUiHost } from "./api";
import { COPY_LINK_WARNING, DEVICE_NAME_HINT } from "./e2eeText";
import { errorMessage } from "./format";
import { pairingLink, pairingLinkE2ee } from "./keyActions";
import { copyText, obsidianRequest } from "./obsidianEnv";
import { applyPairedIdentity, formatCountdown, PairingSession, setPendingEnrollment, withoutPendingEnrollment } from "./pairFlow";
import {
	normalizeHost, pairingCodeVaultId, requestPairingCode, retireDeviceEnrollment, type LinkE2ee, type PairingCodeGrant, type RequestFn,
} from "./pairing";
import { drawQr } from "./qr";

/** One-click Cloudflare deploy of the server (README "Deploy to Cloudflare"). */
const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";

export interface PairPrefill {
	readonly host?: string;
	readonly pairingCode?: string;
	/** From a setup link: true. The pair modal then says what the link sets for encryption. */
	readonly fromLink?: boolean;
	/**
	 * SECRET: the link's vault key, or `suite=0`. Handed to `applyLinkE2ee` after pairing, and only when the device
	 * enrolled in the vault the link's code names on the link's server; zero-filled otherwise and on close.
	 */
	readonly e2ee?: LinkE2ee | null;
}

/** Takes a link's encryption part for the vault this device just enrolled in; owns (and zero-fills) the key. */
export type ApplyLinkE2ee = (vaultId: string, e2ee: LinkE2ee) => void;

function dropLinkKey(e2ee: LinkE2ee | null): void {
	if (e2ee?.suite === 1) e2ee.key.k.fill(0);
}

/** Whether a link's encryption part belongs to the vault this device enrolled in from that link's code (§12.4). */
export function linkE2eeApplies(prefill: PairPrefill, identity: PairedIdentity): boolean {
	if (!prefill.host || !prefill.pairingCode) return false;
	let host: string;
	try {
		host = normalizeHost(prefill.host);
	} catch {
		return false;
	}
	return identity.host === host && pairingCodeVaultId(prefill.pairingCode) === identity.vaultId;
}

export class PairModal extends Modal {
	private readonly session: PairingSession;
	private hostValue: string;
	private codeValue: string;
	private nameValue: string;
	private statusEl: HTMLElement | null = null;
	private pairButton: ButtonComponent | null = null;
	private open_ = false;
	/** SECRET until handed on or zero-filled. */
	private linkE2ee: LinkE2ee | null;

	constructor(
		app: App,
		private readonly host: YaosUiHost,
		private readonly prefill: PairPrefill = {},
		private readonly applyE2ee: ApplyLinkE2ee | null = null,
		private readonly request: RequestFn = obsidianRequest,
	) {
		super(app);
		this.linkE2ee = prefill.e2ee ?? null;
		this.session = new PairingSession({
			request,
			onProgress: (text) => this.setStatus(text, false),
			persist: (attempt) => host.updateData((d) => (attempt ? setPendingEnrollment(d, attempt) : withoutPendingEnrollment(d))),
		});
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
				text: `This device is already paired with ${current.host}. Pairing again replaces this device's credentials and syncs this folder with the vault of the new code. Once the new pairing succeeds, YAOS asks the old server to remove this device's old membership. Notes on disk are not deleted.`,
			});
		}
		contentEl.createEl("p", {
			text: "Enter the server URL and a one-time pairing code. Create a code on a device that is already paired (YAOS settings, \"Pair another device\") or in your server's console.",
		});
		if (this.prefill.fromLink) {
			const e2ee = this.linkE2ee;
			const line = contentEl.createEl("p", { cls: "yaos-pair-e2ee" });
			if (e2ee?.suite === 1) {
				line.createEl("strong", { text: "End-to-end encryption: On" });
				line.appendText(". This link carries the vault key. YAOS checks it against the vault's key record before this device syncs.");
			} else if (e2ee?.suite === 0) {
				line.createEl("strong", { text: "End-to-end encryption: Off (from this link)" });
				line.appendText(". This device will sync the vault without end-to-end encryption, unless the vault turns out to be encrypted.");
			} else {
				line.appendText("This link carries no vault key. If the vault is end-to-end encrypted, this device asks for your recovery key or a QR code from one of your devices after pairing.");
			}
		}

		new Setting(contentEl)
			.setName("Server URL")
			.setDesc(createFragment((f) => {
				f.appendText("No server yet? ");
				f.createEl("a", { text: "Deploy your server", href: CLOUDFLARE_DEPLOY_URL });
				f.appendText(" on Cloudflare with one click; its console gives you a pairing code.");
			}))
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
			.setDesc(`${DEVICE_NAME_HINT}. Also used in this device's conflict copy names.`)
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
		const previous = this.host.data().identity;
		try {
			const identity = await this.session.submit({ host: this.hostValue, pairingCode: this.codeValue, deviceName: this.nameValue });
			// Persist even if the modal was closed meanwhile: the server has already enrolled this
			// device and the code is spent, so dropping the result would strand it.
			await this.host.updateData((d) => applyPairedIdentity(d, identity));
			this.codeValue = "";
			new Notice(`YAOS: this device is now paired with ${identity.host}.`);
			const e2ee = this.linkE2ee;
			this.linkE2ee = null;
			if (e2ee && this.applyE2ee && linkE2eeApplies(this.prefill, identity)) {
				this.applyE2ee(identity.vaultId, e2ee);
			} else if (e2ee) {
				dropLinkKey(e2ee);
				new Notice("YAOS: this device paired with a different code than the link's, so the link's encryption setting was not used.", 9000);
			}
			if (this.open_) this.close();
			// Best effort, only after the new identity is stored: revoke the replaced enrollment
			// with its own token (adfa7a7:src/runtime/setupLinkController.ts:243-256).
			if (previous && !sameIdentity(previous, identity)) {
				retireDeviceEnrollment(previous, { request: this.request }).catch((err: unknown) => new Notice(`YAOS: ${errorMessage(err)}`, 9000));
			}
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
			dropLinkKey(this.linkE2ee);
			this.linkE2ee = null;
		}
	}
}

/**
 * "Pair another device": a fresh one-time code with copy buttons and an expiry countdown, and on request a QR code
 * of a setup link with this device's vault key (§12.1).
 */
export class PairingCodeModal extends Modal {
	private timer: number | null = null;
	private closed = false;
	private hideQr: (() => void) | null = null;

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
				this.renderGrant(identity.host, grant);
			},
			(err: unknown) => {
				if (this.closed) return;
				loading.setText(`Could not create a pairing code: ${errorMessage(err)}`);
				loading.addClass("mod-warning");
			},
		);
	}

	/** The link's encryption part now, or null with a notice saying why this device cannot hand one on. */
	private linkE2ee(): LinkE2ee | null {
		const e2ee = pairingLinkE2ee(this.host);
		if (e2ee) return e2ee;
		new Notice(
			this.host.data().e2ee?.suite === 1
				? "YAOS: this device does not hold the vault's current key, so it cannot pair another device with it. Enter your recovery key on this device first."
				: "YAOS: this device does not know yet whether the vault is end-to-end encrypted, so it cannot pair another device with a QR code. Use the server URL and code below.",
			10000,
		);
		return null;
	}

	private renderGrant(serverUrl: string, grant: PairingCodeGrant): void {
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "On the other device, scan the pairing QR with its camera, or open YAOS settings there, choose \"Pair this device\" and enter the server URL and this code. Anyone with this code can join your vault until it is used or expires, so share it only with your own device.",
		});
		const qrSlot = contentEl.createDiv();
		const buttons: ButtonComponent[] = [];
		new Setting(contentEl)
			.setName("Pairing QR")
			.setDesc("Carries the vault key. Shown only on request, and hidden when the code expires or you close this dialog.")
			.addButton((b) => {
				buttons.push(b);
				b.setButtonText("Show pairing QR").setCta().onClick(() => {
					if (this.hideQr) {
						this.hideQr();
						this.hideQr = null;
						b.setButtonText("Show pairing QR");
						return;
					}
					if (grant.expiresAt <= Date.now()) return;
					const e2ee = this.linkE2ee();
					if (!e2ee) return;
					this.hideQr = drawQr(qrSlot, pairingLink(serverUrl, grant.pairingCode, e2ee), "QR code to pair your other device");
					b.setButtonText("Hide pairing QR");
				});
			});

		const field = (label: string, value: string): void => {
			const s = new Setting(contentEl).setName(label);
			s.settingEl.addClass("yaos-pairing-code-field");
			const area = contentEl.createEl("textarea", { cls: "yaos-pairing-code-value" });
			area.value = value;
			area.readOnly = true;
			area.rows = 1;
			area.addEventListener("focus", () => area.select());
			s.addButton((b) => {
				buttons.push(b);
				b.setButtonText("Copy").onClick(() => {
					copyText(value).then(() => new Notice(`${label} copied.`), () => new Notice(`Could not copy the ${label.toLowerCase()}.`, 6000));
				});
			});
		};
		field("Server URL", serverUrl);
		field("Pairing code", grant.pairingCode);
		new Setting(contentEl)
			.setName("Copy setup link")
			.setDesc(this.host.data().e2ee?.suite === 0 ? "This link lets a device join your vault. Send it only over a channel you trust." : COPY_LINK_WARNING)
			.addButton((b) => {
				buttons.push(b);
				b.setButtonText("Copy setup link").onClick(() => {
					if (grant.expiresAt <= Date.now()) return;
					const e2ee = this.linkE2ee();
					if (!e2ee) return;
					copyText(pairingLink(serverUrl, grant.pairingCode, e2ee)).then(
						() => new Notice("Setup link copied."),
						() => new Notice("Could not copy the setup link.", 6000),
					);
				});
			});

		const expiry = contentEl.createEl("p", { cls: "yaos-pairing-code-expiry" });
		const tick = (): void => {
			const remaining = grant.expiresAt - Date.now();
			if (remaining <= 0) {
				expiry.setText("This code has expired. Close this dialog and create a new one.");
				expiry.addClass("mod-warning");
				this.hideQr?.();
				this.hideQr = null;
				for (const b of buttons) b.setDisabled(true);
				this.stopTimer();
				return;
			}
			expiry.setText(`Expires in ${formatCountdown(remaining)}.`);
		};
		tick();
		this.timer = window.setInterval(tick, 1000);

		new Setting(contentEl).addButton((b) => b.setButtonText("Done").onClick(() => this.close()));
	}

	private stopTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	onClose(): void {
		this.closed = true;
		this.stopTimer();
		this.hideQr?.();
		this.hideQr = null;
		this.contentEl.empty();
	}
}

export function showPairingCodeModal(app: App, host: YaosUiHost, request: RequestFn = obsidianRequest): PairingCodeModal {
	const modal = new PairingCodeModal(app, host, request);
	modal.open();
	return modal;
}
