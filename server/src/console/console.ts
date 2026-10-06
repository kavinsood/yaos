// Operator console, `GET /` (DECISIONS D5): one static page with inline CSS and JS and no external asset. It calls
// exactly the D5 operator routes of §2.2 with the D5, D7, D8a and D8b bodies, and maps every documented error code to
// a plain message. Secrets: the recovery key lives only in a form field until claim or sign-in, a pairing code only in
// the pairing panel. Neither is logged, sent in a request URL or written to web storage; the session cookie is HttpOnly.
//
// DECISIONS-GAP (response shapes §2.2/D5 leave open; the console reads only these fields and tolerates their absence):
// - `GET /operator/state` → `{vaults: [{vaultId, name, createdAt?}], pendingRestores: [{vaultId, at}]}`; the banner
//   comes from `pendingRestores` (§2.2 table: "also lists pending restore journal rows").
// - `GET …/devices` → `{devices: [{deviceId, deviceName, enrolledAt?}]}`.
// - owner-code → the §5 row 2.5 body plus `mobileSetupQrDataUrl` (the claim already has it); without it the panel
//   shows code + link and no QR, because setupQr.ts renders server-side.
// - The setup link is built from `location.origin`, not from a response `host`/`obsidianUrl`, so it always names the
//   server that served the console.
// - Every non-GET sends `Content-Type: application/json` and a JSON body (`{}` for logout and revoke); GETs send none.
// - Claim: the key is generated in the page and must be confirmed saved before `/claim` is sent, so a lost 200 cannot
//   lose it; 0/500/≥502 read as "may have gone through" (D5: a failure after the claim is 503; re-probe and log in).
// - Create needs a non-empty name (maxlength 80, no server limit is specified). Not a gap: login sends nothing under
//   32 characters, the §2.2 claim minimum (the generated key is 64 hex).
import { inlineJson, staticPage } from "./page";

/**
 * Plain messages by error code: every code the operator routes document (§2.2, D3, D5, D7, D8a, D8b, §5 row 2.7), the
 * P1 Worker codes (G8 `internal_error`, `not_implemented`), and the console's own (`network`, `wrong_key`,
 * `claim_unknown`).
 */
export const CONSOLE_MESSAGES: Readonly<Record<string, string>> = {
	network: "Could not reach the server. Check the connection and try again.",
	unauthorized: "Your session has ended. Sign in again.",
	wrong_key: "That recovery key does not match this server.",
	already_claimed: "This server is already claimed. Sign in with its recovery key (if you just claimed it, the key you saved).",
	claim_unknown: "The claim may have gone through. Keep the key you saved, reload this page and sign in, then use Pair a device on the vault.",
	// DECISIONS-GAP: D2.1 names an in-memory login-failure limiter but no code; D3's `too_many_attempts` (and any 429).
	too_many_attempts: "Too many failed attempts. Wait a minute and try again.",
	confirmation_mismatch: "The typed vault ID does not match this vault. Nothing was changed.",
	purge_incomplete: "The vault is closed, but some attachments are not removed yet. Press Delete vault again to finish.",
	restore_in_progress: "A restore of this vault has not finished. Pairing, revoking and resetting wait for it; press Restore to resume it.",
	restore_incomplete: "The restore started but has not finished. The server finishes it on its own within about a minute, or press Restore to resume it now.",
	invalid_restore_point: "That restore point is not usable. Enter an ISO 8601 time within the last 30 days and not in the future.",
	restore_unsupported: "This server cannot restore: Cloudflare point-in-time recovery is not available here (local development).",
	cf_daily_limit: "The Cloudflare free-plan daily limit is used up. Try again after it resets.",
	not_found: "That vault or device no longer exists. Reload the page.",
	unknown_vault: "That vault no longer exists. Reload the page.",
	invalid_purpose: "The server refused the pairing code purpose. Reload the page and try again.",
	body_too_large: "The request was too large for the server.",
	internal_error: "The server hit an unexpected error. Try again.",
	not_implemented: "This server build does not support that action yet.",
};

/** The console page, served by router.ts for `GET /`. */
export function consolePage(): Response {
	return staticPage(renderConsole, "'self'");
}

function renderConsole(nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>YAOS server</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
body { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
section { border: 1px solid #8886; border-radius: 8px; padding: 4px 16px 12px; margin: 16px 0; }
input, button { font: inherit; padding: 6px 10px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
.mono { font-family: ui-monospace, monospace; min-width: 22em; }
.warn { border-left: 4px solid #d80; padding-left: 10px; }
.err { color: #d33; } .ok { color: #2a7; } .muted { opacity: .7; font-size: 13px; }
img.qr { width: 240px; height: 240px; background: #fff; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<h1>YAOS server</h1>
<p id="info" class="muted"></p>
<noscript><p>The console needs JavaScript.</p></noscript>
<p id="msg" role="status" aria-live="polite"></p>
<div id="pair"></div>
<section id="claim" hidden>
<h2>Claim this server</h2>
<p>This server has no operator yet. Claiming makes you its operator and creates your first vault.</p>
<button id="claim-start">Generate a recovery key</button>
<div id="claim-step" hidden>
<p class="warn"><strong>Save this operator recovery key in your password manager now.</strong> It is shown only
once and is the only way to sign in to this console; nobody can reset it. It is not a device pairing code: never
paste it into Obsidian.</p>
<div class="row"><input id="claim-key" class="mono" readonly autocomplete="off" aria-label="Operator recovery key"><button id="claim-copy">Copy</button></div>
<label class="row"><input id="claim-saved" type="checkbox"> I have saved the recovery key.</label>
<button id="claim-go" disabled>Claim server</button>
</div>
</section>
<section id="login" hidden>
<h2>Sign in</h2>
<p>Paste the operator recovery key you saved when you claimed this server.</p>
<form id="login-form" class="row"><input id="login-key" class="mono" type="password" autocomplete="current-password" aria-label="Operator recovery key"><button>Sign in</button></form>
</section>
<div id="main" hidden>
<div class="row"><input id="new-name" maxlength="80" placeholder="New vault name" aria-label="New vault name"><button id="create">Create vault</button><button id="logout">Sign out</button></div>
<div id="vaults"></div>
</div>
<script nonce="${nonce}">
"use strict";
const MESSAGES = ${inlineJson(CONSOLE_MESSAGES)};
const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
function h(tag, props, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}
function say(text, kind) { $("msg").textContent = text; $("msg").className = kind || ""; }
function when(value) {
  const date = new Date(value);
  return value == null || isNaN(date.getTime()) ? "an unknown time" : date.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function copy(text) {
  navigator.clipboard.writeText(text).then(() => say("Copied.", "ok"), () => say("Copy failed: select the text and copy it by hand.", "err"));
}
function show(view) {
  for (const id of ["claim", "login", "main"]) $(id).hidden = id !== view;
  if (view !== "claim") $("claim-key").value = "";
}
async function api(method, path, body) {
  const init = { method, headers: {} };
  if (method !== "GET") { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body || {}); }
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => null);
    return { status: res.status, data: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, data: { error: "network" } };
  }
}
function failure(action, r) {
  const code = typeof r.data.error === "string" ? r.data.error : "";
  if (r.status === 401) { show("login"); return action + ": " + MESSAGES.unauthorized; }
  let text = MESSAGES[code] || (r.status === 429 ? MESSAGES.too_many_attempts : "unexpected answer (HTTP " + r.status + (code ? ", " + code : "") + ").");
  if (code === "cf_daily_limit" && r.data.resetAt) text += " It resets at " + when(r.data.resetAt) + ".";
  return action + ": " + text;
}
async function load() {
  const r = await api("GET", "/operator/state");
  if (r.status === 401) return show("login");
  if (r.status !== 200) return say(failure("Loading the vaults", r), "err");
  show("main");
  const pending = new Map((Array.isArray(r.data.pendingRestores) ? r.data.pendingRestores : []).map((p) => [p.vaultId, p]));
  const vaults = Array.isArray(r.data.vaults) ? r.data.vaults : [];
  $("vaults").replaceChildren(...(vaults.length ? vaults.map((v) => vaultCard(v, pending.get(v.vaultId))) : [h("p", { textContent: "No vaults yet." })]));
}
function showCode(data, label) {
  const code = typeof data.pairingCode === "string" ? data.pairingCode : "";
  if (!code) return say("The server returned no pairing code. Reload and try again.", "err");
  const link = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host: location.origin, pairingCode: code });
  const qr = typeof data.mobileSetupQrDataUrl === "string" && data.mobileSetupQrDataUrl.startsWith("data:image/svg+xml;base64,")
    ? h("img", { className: "qr", src: data.mobileSetupQrDataUrl, alt: "Mobile setup QR code" })
    : h("p", { className: "muted", textContent: "No QR code came with this code; use the link or copy the code." });
  $("pair").replaceChildren(h("section", { className: "warn" },
    h("h2", { textContent: "Pair a device with " + label }),
    h("p", { textContent: "One-time pairing code, valid until " + when(data.expiresAt || data.pairingExpiresAt) + ". It is shown only here; reloading removes it." }),
    h("div", { className: "row" }, h("input", { className: "mono", readOnly: true, value: code }), h("button", { textContent: "Copy", onclick: () => copy(code) })),
    h("p", {}, h("a", { href: link, textContent: "Open in Obsidian on this device" })),
    qr,
    h("p", { className: "muted", textContent: "On a phone: scan the QR code with the camera, then tap Connect Obsidian." }),
    h("button", { textContent: "Done", onclick: () => $("pair").replaceChildren() })));
}
function vaultCard(v, pending) {
  const id = v.vaultId, label = v.name || id, base = "/operator/vaults/" + enc(id);
  const devices = h("div");
  const at = h("input", { className: "mono", value: new Date(Date.now() - 3600000).toISOString(), ariaLabel: "Restore point (ISO 8601)" });
  const act = (text, onclick) => h("button", { textContent: text, onclick });
  const done = (r, action, ok) => r.status === 200 ? (say(ok, "ok"), load()) : say(failure(action, r), "err");
  function typed(text, run) {
    const input = h("input", { className: "mono", placeholder: "Type " + id + " to confirm" });
    const button = h("button", { textContent: text, disabled: true, onclick: () => run(input.value.trim()) });
    input.oninput = () => { button.disabled = input.value.trim() !== id; };
    return h("div", { className: "row" }, input, button);
  }
  async function listDevices() {
    const r = await api("GET", base + "/devices");
    if (r.status !== 200) return say(failure("Devices", r), "err");
    const list = Array.isArray(r.data.devices) ? r.data.devices : [];
    devices.replaceChildren(...(list.length ? list.map(deviceRow) : [h("p", { textContent: "No paired devices." })]));
  }
  function deviceRow(d) {
    const name = d.deviceName || "Unnamed device";
    return h("div", { className: "row" },
      h("span", { textContent: name + " (" + d.deviceId + ")" + (d.enrolledAt ? ", paired " + when(d.enrolledAt) : "") }),
      act("Revoke", async () => {
        if (!confirm("Revoke " + name + "? It stops syncing at once and has to be paired again.")) return;
        const r = await api("DELETE", base + "/devices/" + enc(d.deviceId), {});
        if (r.status !== 200) return say(failure("Revoke", r), "err");
        say(r.data.revoked === false ? name + " was already revoked." : name + " is revoked.", "ok");
        listDevices();
      }));
  }
  async function restore() {
    const t = Date.parse(at.value.trim());
    if (!Number.isFinite(t)) return say("Restore: " + MESSAGES.invalid_restore_point, "err");
    const point = new Date(t).toISOString();
    if (!confirm("Restore " + label + " to " + point + "? Synced content written after that point is discarded on the server.")) return;
    say("Restoring " + label + "; this takes a few seconds.");
    const r = await api("POST", base + "/restore", { at: point });
    done(r, "Restore", r.data.resumed
      ? "Finished the pending restore to " + when(r.data.at) + "; the time you entered was not used. Press Restore again to use it."
      : label + " is restored to " + point + ". Devices start again from the new epoch.");
    if (r.status !== 200) load();
  }
  return h("section", {},
    h("h3", { textContent: label }),
    h("p", { className: "muted", textContent: "Vault ID " + id + (v.createdAt ? ", created " + when(v.createdAt) : "") }),
    pending ? h("p", { className: "warn", textContent: "Restore incomplete: the restore to " + when(pending.at) + " has not finished. " + MESSAGES.restore_incomplete }) : "",
    h("div", { className: "row" },
      act("Pair a device", async () => {
        const r = await api("POST", base + "/owner-code", { purpose: "owner-bootstrap" });
        if (r.status === 200) showCode(r.data, label); else say(failure("Pairing code", r), "err");
      }),
      act("Devices", listDevices)),
    devices,
    h("details", {},
      h("summary", { textContent: "Reset, restore or delete" }),
      h("p", { textContent: "Reset streams deletes all synced content of this vault on the server and starts a new epoch. Devices stay paired and upload again from their files; attachments are kept." }),
      typed("Reset streams", async (confirmVaultId) => {
        const r = await api("POST", base + "/reset-streams", { confirmVaultId });
        done(r, "Reset streams", label + " is reset. Devices upload again from their files.");
      }),
      h("p", { textContent: "Restore rewinds synced content to a point within the last 30 days (Cloudflare point-in-time recovery; not in local development). Devices stay paired as they are now; unused pairing codes are cancelled." }),
      h("div", { className: "row" }, at, act("Restore", restore)),
      h("p", { textContent: "Delete vault removes the vault, its devices and its attachments for good." }),
      typed("Delete vault", async (confirmVaultId) => {
        const r = await api("DELETE", base, { confirmVaultId });
        done(r, "Delete vault", label + " is deleted. Its devices can no longer sync.");
      })));
}
$("claim-start").onclick = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  $("claim-key").value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  $("claim-start").hidden = true;
  $("claim-step").hidden = false;
};
$("claim-copy").onclick = () => copy($("claim-key").value);
$("claim-saved").onchange = () => { $("claim-go").disabled = !$("claim-saved").checked; };
$("claim-go").onclick = async () => {
  $("claim-go").disabled = true;
  say("Claiming the server…");
  const r = await api("POST", "/claim", { operatorRecoveryKey: $("claim-key").value });
  $("claim-go").disabled = false;
  if (r.status === 200) {
    show("main");
    showCode(r.data, r.data.vaultName || "your first vault");
    say("Server claimed. Pair your first device with the code below.", "ok");
    return load();
  }
  if (r.data.error === "already_claimed") { show("login"); return say(MESSAGES.already_claimed, "err"); }
  say(r.status === 0 || r.status === 500 || r.status >= 502 ? MESSAGES.claim_unknown : failure("Claim", r), "err");
};
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  const key = $("login-key").value.trim();
  if (key.length < 32) return say("A recovery key has at least 32 characters.", "err");
  const r = await api("POST", "/operator/login", { operatorRecoveryKey: key });
  if (r.status !== 200) return say(r.status === 401 ? MESSAGES.wrong_key : failure("Sign in", r), "err");
  $("login-key").value = "";
  say("Signed in.", "ok");
  load();
};
$("logout").onclick = async () => {
  await api("POST", "/operator/logout", {});
  $("pair").replaceChildren();
  show("login");
  say("Signed out.");
};
$("create").onclick = async () => {
  const name = $("new-name").value.trim();
  if (!name) return say("Enter a name for the new vault.", "err");
  const r = await api("POST", "/operator/vaults", { name });
  if (r.status !== 200) return say(failure("Create vault", r), "err");
  $("new-name").value = "";
  say(name + " is created. Use Pair a device to connect Obsidian to it.", "ok");
  load();
};
(async () => {
  const caps = await api("GET", "/api/capabilities");
  if (caps.status !== 200) return say(failure("Reaching the server", caps), "err");
  $("info").textContent = "Server " + caps.data.serverVersion + ", attachments " + (caps.data.attachments ? "on (R2)" : "off");
  if (caps.data.claimed === true) return load();
  show("claim");
})();
</script>
</body>
</html>
`;
}
