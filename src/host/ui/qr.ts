/**
 * QR codes the plugin draws itself (e2ee-design §12.1, §14.2 step 3): the text may be a SECRET link (it carries the
 * vault key), so it is drawn only after an explicit click, never logged, and the canvas is blanked and removed when
 * the caller hides it (code expiry, modal close).
 */

import { toCanvas } from "qrcode";

/** Draws `text` into a new element under `parent`. Returns the disposer that blanks and removes it. */
export function drawQr(parent: HTMLElement, text: string, label: string): () => void {
	const wrap = parent.createDiv({ cls: "yaos-pairing-qr" });
	const canvas = wrap.createEl("canvas", { cls: "yaos-pairing-qr-canvas", attr: { role: "img", "aria-label": label } });
	canvas.hidden = true;
	let gone = false;
	// Error correction M as the old client drew its QR (adfa7a7:src/settings/PairDeviceModal.ts:40-65); a link with a
	// key is about 200 characters, so the code is drawn a little larger.
	toCanvas(canvas, text, { width: 260, margin: 1, errorCorrectionLevel: "M" }).then(
		() => { if (!gone) canvas.hidden = false; },
		() => {
			if (gone) return;
			canvas.remove();
			wrap.createEl("p", { cls: "mod-warning", text: "Could not draw the QR code." });
		},
	);
	return () => {
		if (gone) return;
		gone = true;
		canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		canvas.width = 0;
		canvas.height = 0;
		wrap.remove();
	};
}
