import { buildMobileSetupUrl } from "../../server/src/setupQr";
import { suite } from "../harness.ts";

const s = suite("setup-qr");
const host = "https://example.test";
const pairingCode = "pairing-code-for-one-device";

// The console draws the QR of this URL (tests/server/console.ts, DECISIONS O12).
s.section("mobile setup URL carries only host and pairing code");
{
	const mobileUrl = buildMobileSetupUrl(host, pairingCode);
	const parsed = new URL(mobileUrl);
	const params = new URLSearchParams(parsed.hash.slice(1));
	s.check(params.get("host") === host, "fragment carries host");
	s.check(params.get("pairingCode") === pairingCode, "fragment carries pairing code");
	s.check([...params.keys()].length === 2, "fragment has no recovery key or identity data");
}

await s.done();
