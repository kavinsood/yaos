/**
 * The part of the qrcode package (1.5.x, browser build lib/browser.js) that the pairing modal uses.
 * Ported from adfa7a7:src/types/qrcode.d.ts; the package ships no types.
 */
declare module "qrcode" {
	export interface QRCodeToCanvasOptions {
		width?: number;
		margin?: number;
		errorCorrectionLevel?: "L" | "M" | "Q" | "H";
	}

	export function toCanvas(canvas: HTMLCanvasElement, text: string, options?: QRCodeToCanvasOptions): Promise<void>;
}
