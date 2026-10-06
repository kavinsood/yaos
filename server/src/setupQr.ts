/**
 * Builds owner-code's `mobileSetupUrl`; the console's setup QR encodes the same URL. The one-time pairing code
 * remains in the fragment so scanners never send it in the mobile page request.
 */
export function buildMobileSetupUrl(host: string, pairingCode: string): string {
	const hash = new URLSearchParams({ host, pairingCode }).toString();
	return `${host}/mobile-setup#${hash}`;
}

/** The `obsidian://yaos` setup link of a pairing code (legacy, removed server/src/routes/auth.ts:269-271). */
export function buildObsidianPairingUrl(host: string, pairingCode: string): string {
	return `obsidian://yaos?${new URLSearchParams({ action: "setup", host, pairingCode }).toString()}`;
}
