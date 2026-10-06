// Static HTML pages of the Worker (DECISIONS D5): the operator console and the mobile setup page. Each response is
// self-contained (inline CSS and JS, no external asset) and carries a strict CSP whose only script and style source is
// a fresh per-response nonce. No DO call, no CORS headers (§2.2: they are not under /api/, /enroll or /vault/).
import { randomBase64Url } from "../base64url";
import { html } from "../http";

/** `connect` is the CSP `connect-src`: `'self'` for the console's fetches, `'none'` for a page that makes none. */
export function staticPage(render: (nonce: string) => string, connect: "'self'" | "'none'"): Response {
	const nonce = randomBase64Url(16);
	const response = html(render(nonce));
	response.headers.set("Content-Security-Policy", [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		`style-src 'nonce-${nonce}'`,
		"img-src data:",
		`connect-src ${connect}`,
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; "));
	response.headers.set("Referrer-Policy", "no-referrer");
	response.headers.set("X-Content-Type-Options", "nosniff");
	return response;
}

/** JSON for an inline `<script>`: `<` is escaped so no value can close the element. */
export function inlineJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}
