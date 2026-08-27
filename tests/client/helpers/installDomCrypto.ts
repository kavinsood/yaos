import { webcrypto } from "node:crypto";

function isDomCrypto(value: unknown): value is Crypto {
	if (typeof value !== "object" || value === null) return false;
	if (!("subtle" in value) || typeof value.subtle !== "object" || value.subtle === null) return false;
	if (!("digest" in value.subtle) || typeof value.subtle.digest !== "function") return false;
	if (!("getRandomValues" in value) || typeof value.getRandomValues !== "function") return false;
	return "randomUUID" in value && typeof value.randomUUID === "function";
}

export function installDomCrypto(): void {
	if (typeof globalThis.crypto !== "undefined") return;
	const candidate: unknown = webcrypto;
	if (!isDomCrypto(candidate)) {
		throw new Error("node:crypto webcrypto lacks the Crypto surface required by client tests");
	}
	globalThis.crypto = candidate;
}
