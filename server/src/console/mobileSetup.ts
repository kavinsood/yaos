// `GET /mobile-setup` (DECISIONS D5): the target of `mobileSetupUrl` and of the setup QR (setupQr.ts builds
// `<host>/mobile-setup#host=…&pairingCode=…`). Static: the pairing code stays in the fragment, which the browser never
// sends; the page reads it, drops it from the address bar and history, and offers the obsidian://yaos setup link. It
// makes no request (CSP `connect-src 'none'`).
//
// DECISIONS-GAP: D5 does not say what the page checks. It accepts only a D3-format code and a `host` equal to its own
// origin (setupQr.ts always builds both from the same host), so a crafted link cannot point Obsidian at another server.
import { staticPage } from "./page";

/** The mobile setup page. The coordinator wires it as `case "GET /mobile-setup": return mobileSetupPage();`. */
export function mobileSetupPage(): Response {
	return staticPage(renderMobileSetup, "'none'");
}

function renderMobileSetup(nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect YAOS</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 420px; margin: 0 auto; padding: 24px 16px; }
a.go { display: block; padding: 14px; border-radius: 10px; background: #2a7; color: #fff; text-align: center; font-weight: 600; text-decoration: none; }
input { width: 100%; box-sizing: border-box; font: 13px ui-monospace, monospace; padding: 6px; }
.err { color: #d33; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Connect YAOS</h1>
<noscript><p>This page needs JavaScript.</p></noscript>
<p id="msg">Reading the setup link…</p>
<div id="ready" hidden>
<a id="go" class="go">Connect Obsidian</a>
<p>The pairing code works once, for 15 minutes. No YAOS on this phone yet? In Obsidian, open Settings, Community
plugins, search for YAOS, install and enable it, then come back and tap Connect Obsidian.</p>
<details><summary>Enter it by hand</summary>
<p>Server<br><input id="host" readonly aria-label="Server"></p>
<p>Pairing code<br><input id="code" readonly aria-label="Pairing code"></p>
</details>
</div>
<script nonce="${nonce}">
"use strict";
const params = new URLSearchParams(location.hash.slice(1));
const host = (params.get("host") || "").trim().replace(/[/]+$/, "");
const code = (params.get("pairingCode") || "").trim();
history.replaceState(null, "", location.pathname);
const msg = document.getElementById("msg");
if (!/^[A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]{32}$/.test(code)) {
  msg.textContent = "This setup link is incomplete or damaged. Scan the QR code again, or ask for a new pairing code.";
  msg.className = "err";
} else if (host !== location.origin) {
  msg.textContent = "This setup link names a different server. Scan the QR code shown by your own server.";
  msg.className = "err";
} else {
  document.getElementById("go").href = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host, pairingCode: code });
  document.getElementById("host").value = host;
  document.getElementById("code").value = code;
  document.getElementById("ready").hidden = false;
  msg.textContent = "Ready to connect this phone to " + host + ".";
}
</script>
</body>
</html>
`;
}
