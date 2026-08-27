import qrcode from "qrcode-generator";

/**
 * Builds the URL encoded by the setup QR. The one-time pairing code remains in
 * the fragment so scanners never send it in the mobile page request.
 */
export function buildMobileSetupUrl(host: string, pairingCode: string): string {
	const hash = new URLSearchParams({ host, pairingCode }).toString();
	return `${host}/mobile-setup#${hash}`;
}

/**
 * Encodes a mobile setup URL as a self-contained SVG data URL. The QR encoder
 * is bundled with the Worker; no third-party browser script or asset is loaded.
 */
export async function renderSetupQrDataUrl(mobileSetupUrl: string): Promise<string> {
	if (!mobileSetupUrl.trim()) {
		throw new Error("A mobile setup URL is required to render the setup QR code");
	}

	const qr = qrcode(0, "M");
	qr.addData(mobileSetupUrl, "Byte");
	qr.make();
	const svg = qr
		.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
		.replace("<svg ", "<svg shape-rendering=\"crispEdges\" ")
		.replace("fill=\"black\"", "fill=\"#08111d\"");
	return `data:image/svg+xml;base64,${btoa(svg)}`;
}
