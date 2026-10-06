import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../../server/src/setupQr";
import { suite } from "../harness.ts";

const s = suite("setup-qr");
const host = "https://example.test";
const pairingCode = "pairing-code-for-one-device";

function decodeSvgDataUrl(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	if (!dataUrl.startsWith(prefix)) throw new Error("expected an SVG data URL");
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

s.section("setup QR carries only host and pairing code");
{
	const mobileUrl = buildMobileSetupUrl(host, pairingCode);
	const parsed = new URL(mobileUrl);
	const params = new URLSearchParams(parsed.hash.slice(1));
	s.check(params.get("host") === host, "fragment carries host");
	s.check(params.get("pairingCode") === pairingCode, "fragment carries pairing code");
	s.check([...params.keys()].length === 2, "fragment has no recovery key or identity data");
	const rendered = await renderSetupQrDataUrl(mobileUrl);
	const svg = decodeSvgDataUrl(rendered);
	s.check(svg.includes("<svg ") && !svg.includes("<script"), "QR is local inert SVG");
}

await s.done();
