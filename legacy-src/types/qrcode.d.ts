declare module "qrcode" {
	export interface QRCodeToCanvasOptions {
		width?: number;
		margin?: number;
		errorCorrectionLevel?: "L" | "M" | "Q" | "H";
	}

	export function toCanvas(
		canvas: HTMLCanvasElement,
		text: string,
		options?: QRCodeToCanvasOptions,
	): Promise<void>;
}
