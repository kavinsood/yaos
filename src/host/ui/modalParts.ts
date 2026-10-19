/** Pieces the pairing, vault-creation and key modals share. */

/**
 * A modal's status line. set() writes it, `warn` styles it as a warning; it does nothing while no line is attached
 * (before the modal drew one, after it redrew or closed), so a late async step cannot write into a closed modal.
 */
export class StatusLine {
	private el: HTMLElement | null = null;

	attach(parent: HTMLElement): void {
		this.el = parent.createEl("p", { cls: "yaos-pair-status" });
	}

	detach(): void {
		this.el = null;
	}

	set(text: string, warn: boolean): void {
		if (!this.el) return;
		this.el.setText(text);
		this.el.toggleClass("mod-warning", warn);
	}
}

/** An input for an address, code or key: no autocomplete, no spellcheck; `secret` also masks what is typed. */
export function plainInput(input: HTMLInputElement, opts: { readonly secret?: boolean } = {}): HTMLInputElement {
	if (opts.secret) input.type = "password";
	input.autocomplete = "off";
	input.spellcheck = false;
	return input;
}
