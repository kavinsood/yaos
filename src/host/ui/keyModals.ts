/**
 * Encryption modals (e2ee-design §12.4, §13.2, §13.3, §14.2):
 *
 *   KeyMissingModal          the blocked key-less screen: why, and exactly two actions
 *   EnterRecoveryKeyModal    "Enter recovery key" (installKey rk)
 *   RecoveryKeyModal         a new recovery key, shown once, confirmed by retyping two random groups
 *   RekeyQrModal             the re-key QR drawn from the stored key, for every device the user keeps
 *   RekeyAfterRevokeModal    a new vault key after a revoke, under the existing or a new recovery key
 *
 * The logic is in keyActions.ts and recoveryKeyText.ts. Nothing here creates a vault or chooses a vault's
 * encryption (that is createVault.ts, which this module does not import).
 *
 * SECRETS: recovery keys and re-key links. The recovery key is shown only in RecoveryKeyModal (handing it to the
 * user is the point of it), a re-key link only as a QR after a click, or on the clipboard. Neither is logged or put
 * in a notice, and the DOM holding them is emptied on close.
 */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type { YaosUiHost } from "./api";
import {
	COPY_LINK_WARNING, keyMissingText, PENDING_QR_TEXT, REKEY_EVERY_DEVICE_TEXT, SCAN_QR_TEXT, STORE_RK_ADVICE,
} from "./e2eeText";
import { errorMessage } from "./format";
import { installRecoveryKey, PendingQrKeys, rekeyBlocked, rekeyLinkNow, revokeRekey, RK_CHECKSUM_MESSAGE, RK_MALFORMED_MESSAGE } from "./keyActions";
import { copyText } from "./obsidianEnv";
import { defaultRandomBytes } from "./pairing";
import { drawQr } from "./qr";
import { groupMatches, newRecoveryKey, pickConfirmGroups, readRecoveryKey, recoveryKeyGroups } from "./recoveryKeyText";

/** A recovery key wrong but well-formed, or for a vault whose records have not arrived yet (§13.3). */
export const RK_PENDING_TEXT =
	"YAOS could not open this vault's key records with that recovery key yet. It keeps the key in memory and tries again as records arrive. If this device stays blocked, check that it is the recovery key of this vault.";

function inputFor(setting: Setting, opts: { placeholder: string; mono?: boolean }, onChange: (v: string) => void): HTMLInputElement {
	let el: HTMLInputElement | null = null;
	setting.addText((t) => {
		t.setPlaceholder(opts.placeholder).onChange(onChange);
		t.inputEl.autocomplete = "off";
		t.inputEl.spellcheck = false;
		t.inputEl.setAttribute("autocapitalize", "characters");
		if (opts.mono) t.inputEl.addClass("yaos-mono");
		el = t.inputEl;
	});
	return el!;
}

// ---------------------------------------------------------------------------
// The blocked screen (§12.4)
// ---------------------------------------------------------------------------

export class KeyMissingModal extends Modal {
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly host: YaosUiHost,
		private readonly pending: PendingQrKeys,
		private readonly openEnterRecoveryKey: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-key-missing-modal");
		this.setTitle("This device can't sync yet");
		const reason = this.host.status()?.e2ee?.keyMissing ?? "no-pin";
		contentEl.createEl("p", { text: keyMissingText(reason) });
		if (this.pending.shows(this.host)) contentEl.createEl("p", { cls: "mod-warning", text: PENDING_QR_TEXT });
		const scanHelp = contentEl.createEl("p", { cls: "yaos-key-missing-scan", text: SCAN_QR_TEXT });
		scanHelp.hidden = true;
		// Exactly two actions (§12.4). There is no way to sync without the key, and none to turn encryption off.
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Scan QR from one of your devices").onClick(() => { scanHelp.hidden = false; }))
			.addButton((b) => b.setButtonText("Enter recovery key").setCta().onClick(() => {
				this.close();
				this.openEnterRecoveryKey();
			}));
		this.unsubscribe = this.host.onChange(() => {
			const suite = this.host.data().e2ee?.suite;
			if ((suite === 0 || suite === 1) && this.host.status()?.e2ee?.keyMissing === null) {
				new Notice("YAOS: this device has the vault key and syncs again.");
				this.close();
			}
		});
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Enter recovery key (§13.3)
// ---------------------------------------------------------------------------

export class EnterRecoveryKeyModal extends Modal {
	private value = "";
	private statusEl: HTMLElement | null = null;
	private button: ButtonComponent | null = null;
	private busy = false;
	private open_ = false;

	constructor(app: App, private readonly host: YaosUiHost) {
		super(app);
	}

	onOpen(): void {
		this.open_ = true;
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Enter recovery key");
		contentEl.createEl("p", { text: "Type the recovery key you saved when this vault was created or last re-keyed. It starts with YAOS-RK1-. Case, spaces and dashes do not matter." });
		const s = new Setting(contentEl).setName("Recovery key");
		const input = inputFor(s, { placeholder: "YAOS-RK1-XXXX-XXXX-…", mono: true }, (v) => { this.value = v; });
		input.type = "password";
		input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void this.submit(); });
		this.statusEl = contentEl.createEl("p", { cls: "yaos-pair-status" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b;
				b.setButtonText("Unlock").setCta().onClick(() => { void this.submit(); });
			});
	}

	private setStatus(text: string, warn: boolean): void {
		if (!this.open_ || !this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("mod-warning", warn);
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.button?.setDisabled(true);
		this.setStatus("Checking the recovery key…", false);
		try {
			const outcome = await installRecoveryKey(this.host, this.value);
			if (outcome === "verified") {
				new Notice("YAOS: recovery key accepted. This device syncs again.");
				this.value = "";
				if (this.open_) this.close();
			} else {
				this.setStatus(RK_PENDING_TEXT, true);
			}
		} catch (err) {
			this.setStatus(errorMessage(err), true);
		} finally {
			this.busy = false;
			this.button?.setDisabled(false);
		}
	}

	onClose(): void {
		this.open_ = false;
		this.value = "";
		this.contentEl.empty();
		this.statusEl = null;
		this.button = null;
	}
}

// ---------------------------------------------------------------------------
// A new recovery key, shown once (§13.2)
// ---------------------------------------------------------------------------

/**
 * Generates a recovery key, shows it once with Copy and the §13.2 advice, and has the user retype two random
 * groups. Resolves with the 35 bytes once confirmed (the caller sends and zero-fills them), or null when closed
 * first (the bytes are zero-filled here).
 */
export class RecoveryKeyModal extends Modal {
	private rk: Uint8Array | null = null;
	private text = "";
	private resolved = false;

	constructor(
		app: App,
		private readonly host: Pick<YaosUiHost, "rkChecksum">,
		private readonly purpose: { readonly title: string; readonly intro: string; readonly confirmText: string },
		private readonly done: (rk: Uint8Array | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.purpose.title);
		this.contentEl.addClass("yaos-recovery-key-modal");
		const loading = this.contentEl.createEl("p", { text: "Making a recovery key…" });
		newRecoveryKey(defaultRandomBytes, (s) => this.host.rkChecksum(s)).then(
			({ rk, text }) => {
				if (this.resolved) {
					rk.fill(0);
					return;
				}
				this.rk = rk;
				this.text = text;
				loading.remove();
				this.showKey();
			},
			(err: unknown) => {
				loading.setText(`Could not make a recovery key: ${errorMessage(err)}`);
				loading.addClass("mod-warning");
			},
		);
	}

	private showKey(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: this.purpose.intro });
		contentEl.createEl("p", { text: "YAOS shows this key only now and keeps no copy you can view later. Anyone who has it can read this vault." });
		contentEl.createEl("p", { cls: "mod-warning", text: `${STORE_RK_ADVICE}.` });
		const code = contentEl.createEl("pre", { cls: "yaos-recovery-key-text yaos-mono" });
		code.setText(this.text);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Copy").onClick(() => {
				copyText(this.text).then(() => new Notice("Recovery key copied."), () => new Notice("Could not copy the recovery key. Write it down instead.", 6000));
			}))
			.addButton((b) => b.setButtonText("I saved it").setCta().onClick(() => this.showConfirm()));
	}

	private showConfirm(): void {
		const { contentEl } = this;
		contentEl.empty();
		const groups = recoveryKeyGroups(this.text);
		const [i, j] = pickConfirmGroups(defaultRandomBytes);
		contentEl.createEl("p", { text: `To check that you saved it, type group ${i + 1} and group ${j + 1} of your recovery key (of ${groups.length} groups after YAOS-RK1-).` });
		const typed = ["", ""];
		let confirm: ButtonComponent | null = null;
		const check = (): void => { confirm?.setDisabled(!(groupMatches(typed[0]!, groups[i]!) && groupMatches(typed[1]!, groups[j]!))); };
		inputFor(new Setting(contentEl).setName(`Group ${i + 1}`), { placeholder: "XXXX", mono: true }, (v) => { typed[0] = v; check(); });
		inputFor(new Setting(contentEl).setName(`Group ${j + 1}`), { placeholder: "XXXX", mono: true }, (v) => { typed[1] = v; check(); });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Show the key again").onClick(() => this.showKey()))
			.addButton((b) => {
				confirm = b;
				b.setButtonText(this.purpose.confirmText).setCta().setDisabled(true).onClick(() => {
					const rk = this.rk;
					if (!rk) return;
					this.rk = null;
					this.resolved = true;
					this.close();
					this.done(rk);
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		this.text = "";
		this.rk?.fill(0);
		this.rk = null;
		if (!this.resolved) {
			this.resolved = true;
			this.done(null);
		}
	}
}

/** Opens RecoveryKeyModal and resolves with the confirmed key, or null. */
export function askNewRecoveryKey(app: App, host: Pick<YaosUiHost, "rkChecksum">, purpose: ConstructorParameters<typeof RecoveryKeyModal>[2]): Promise<Uint8Array | null> {
	return new Promise((resolve) => new RecoveryKeyModal(app, host, purpose, resolve).open());
}

// ---------------------------------------------------------------------------
// Re-key QR (§14.2 step 3)
// ---------------------------------------------------------------------------

export class RekeyQrModal extends Modal {
	private hideQr: (() => void) | null = null;

	constructor(app: App, private readonly host: YaosUiHost, private readonly afterRevoke: boolean) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.afterRevoke ? "Re-key your other devices" : "Re-key QR");
		contentEl.createEl("p", {
			text: this.afterRevoke
				? `The vault key was changed. ${REKEY_EVERY_DEVICE_TEXT}`
				: "This QR code carries the vault's current key, for one of your devices that is paired with this vault but lacks it (after a re-key, or when it lost its key). Scan it with that device's camera, or open the re-key link there.",
		});
		const qrSlot = contentEl.createDiv();
		const showSetting = new Setting(contentEl)
			.setName("Re-key QR")
			.setDesc("Shown only on request, and hidden when you close this dialog.")
			.addButton((b) => b.setButtonText("Show re-key QR").setCta().onClick(() => {
				if (this.hideQr) {
					this.hideQr();
					this.hideQr = null;
					b.setButtonText("Show re-key QR");
					return;
				}
				const link = rekeyLinkNow(this.host);
				if (!link) {
					new Notice("YAOS: this device does not hold the vault's current key.", 8000);
					return;
				}
				this.hideQr = drawQr(qrSlot, link, "QR code with the vault key for your other devices");
				b.setButtonText("Hide re-key QR");
			}));
		showSetting.settingEl.addClass("yaos-rekey-show");
		new Setting(contentEl)
			.setName("Copy re-key link")
			.setDesc(COPY_LINK_WARNING)
			.addButton((b) => b.setButtonText("Copy re-key link").onClick(() => {
				const link = rekeyLinkNow(this.host);
				if (!link) {
					new Notice("YAOS: this device does not hold the vault's current key.", 8000);
					return;
				}
				copyText(link).then(() => new Notice("Re-key link copied."), () => new Notice("Could not copy the re-key link.", 6000));
			}));
		new Setting(contentEl).addButton((b) => b.setButtonText("Done").onClick(() => this.close()));
	}

	onClose(): void {
		this.hideQr?.();
		this.hideQr = null;
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Re-key after a revoke (§14.2, D1, D8)
// ---------------------------------------------------------------------------

export class RekeyAfterRevokeModal extends Modal {
	private typed = "";
	private busy = false;
	private open_ = false;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private readonly host: YaosUiHost, private readonly openRekeyQr: () => void) {
		super(app);
	}

	onOpen(): void {
		this.open_ = true;
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Re-key after revoking a device");
		const blocked = rekeyBlocked(this.host);
		if (blocked) {
			contentEl.createEl("p", { cls: "mod-warning", text: blocked });
			return;
		}
		contentEl.createEl("p", { text: "Do this after you removed a device in your server console. YAOS makes a new vault key that the removed device never gets, so it cannot read changes made from now on. Notes it already synced stay readable to it." });
		contentEl.createEl("p", { text: "The new key is wrapped under a recovery key. Enter the one you have, or make a new one: the old recovery key then opens only the older keys." });
		const s = new Setting(contentEl).setName("Your recovery key");
		const input = inputFor(s, { placeholder: "YAOS-RK1-XXXX-XXXX-…", mono: true }, (v) => { this.typed = v; });
		input.type = "password";
		s.addButton((b) => b.setButtonText("Re-key with this recovery key").setCta().onClick(() => { void this.withTypedKey(); }));
		new Setting(contentEl)
			.setName("Generate a new recovery key")
			.setDesc("Shown once; you confirm you saved it before the key changes.")
			.addButton((b) => b.setButtonText("Generate a new recovery key").onClick(() => { void this.withNewKey(); }));
		this.statusEl = contentEl.createEl("p", { cls: "yaos-pair-status" });
	}

	private setStatus(text: string, warn: boolean): void {
		if (!this.open_ || !this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("mod-warning", warn);
	}

	private async withTypedKey(): Promise<void> {
		if (this.busy) return;
		const read = await readRecoveryKey(this.typed, (s) => this.host.rkChecksum(s)).catch((err: unknown) => {
			this.setStatus(errorMessage(err), true);
			return null;
		});
		if (!read) return;
		if (!read.ok) {
			this.setStatus(read.reason === "malformed" ? RK_MALFORMED_MESSAGE : RK_CHECKSUM_MESSAGE, true);
			return;
		}
		await this.rekey(read.rk);
	}

	private async withNewKey(): Promise<void> {
		if (this.busy) return;
		const rk = await askNewRecoveryKey(this.app, this.host, {
			title: "New recovery key",
			intro: "This is the vault's new recovery key. From now on it is the only recovery key that opens the new vault key.",
			confirmText: "Change the vault key",
		});
		if (rk) await this.rekey(rk);
	}

	private async rekey(rk: Uint8Array): Promise<void> {
		this.busy = true;
		this.setStatus("Changing the vault key…", false);
		try {
			await revokeRekey(this.host, rk);
			this.typed = "";
			new Notice("YAOS: the vault key was changed. Re-key every other device you keep.", 10000);
			if (this.open_) this.close();
			this.openRekeyQr();
		} catch (err) {
			this.setStatus(errorMessage(err), true);
			if (!this.open_) new Notice(`YAOS: ${errorMessage(err)}`, 10000);
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.open_ = false;
		this.typed = "";
		this.statusEl = null;
		this.contentEl.empty();
	}
}
