// Operator console, `GET /` (DECISIONS D5): one static page with inline CSS and JS and no external asset. It calls
// exactly the D5 operator routes of §2.2 with the D5, D7, D8a and D8b bodies, and maps every documented error code to
// a plain message. Secrets: the recovery key lives only in a form field until sign-in, a pairing code only in the
// pairing panel. Neither is logged, sent in a request URL or written to web storage; the session cookie is HttpOnly.
//
// DECISIONS-GAP (response shapes §2.2/D5 leave open; the console reads only these fields and tolerates their absence):
// - `GET /operator/state` → `{vaults: [{vaultId, name, createdAt?}], pendingRestores: [{vaultId, at, failedAt?, reason?}]}`; the
//   banner comes from `pendingRestores` (§2.2 table: "also lists pending restore journal rows"); `failedAt` marks a
//   restore the server stopped retrying (config/restore.ts RESTORE_GIVE_UP_MS).
// - `GET …/devices` → `{devices: [{deviceId, deviceName, enrolledAt?, grantId?, lastSeenDay?}], grants?: [{grantId, name,
//   createdAt, revokedAt, liveDevices, lastSeenDay}]}` (identity-per-store §6.3). Devices are grouped under their live
//   pairing grant; a device without a grant (paired before grants) is listed alone with "Revoke", as before; revoked
//   grants are counted, not listed. "Revoke pairing" (`DELETE …/grants/:grantId`) blocks the install; "Remove device"
//   (`DELETE …/devices/:deviceId`) tidies one store, which comes back as a new device while its install is paired.
//   "Rotate secret" (`POST …/grants/:grantId/rotate` → `{rotated}`) replaces the pairing secret: the install's live
//   stores fetch the new one, a copy of the old data.json alone no longer registers (identity-per-store §3.4).
//   Devices not seen for 90 days are retired by the server itself (§6.2) and drop off the list.
// - The setup link and the setup QR's URL are built from `location.origin`, not from a response
//   `host`/`obsidianUrl`/`mobileSetupUrl`, so they always name the server that served the console.
// - Every non-GET sends `Content-Type: application/json` and a JSON body (`{}` for logout and revoke); GETs send none.
// - The console never claims the server or creates a vault: only a client's "Create a new vault" may pin a vault's
//   encryption (e2ee-design §15.1), so a vault made here could never be opened. An unclaimed server's page only says
//   to run that command in Obsidian, which sends `/claim` (or `/operator/vaults` on a claimed server) itself and shows
//   the operator recovery key. The console manages existing vaults: list, devices, owner code, reset, restore, delete.
// - Not a gap: login sends nothing under 32 characters, the §2.2 claim minimum.
import { inlineJson, staticPage } from "./page";
// The page draws the setup QR: in the Worker it cost owner-code up to 46 ms of CPU (DECISIONS O12).
// The encoder is qrcode-generator's browser build, inlined verbatim as its own nonce script; it only defines the
// global `qrcode`. wrangler.toml's Text rule makes this import the file's source text; the Node tests alias it to
// tests/mocks/qrcodeScript.ts.
import QRCODE_SCRIPT from "qrcode-generator/dist/qrcode.js";

/**
 * Plain messages by error code: every code the operator routes document (§2.2, D3, D5, D7, D8a, D8b, §5 row 2.7), the
 * P1 Worker codes (G8 `internal_error`, `not_implemented`), and the console's own (`network`, `wrong_key`).
 */
export const CONSOLE_MESSAGES: Readonly<Record<string, string>> = {
	network: "Could not reach the server. Check the connection and try again.",
	unauthorized: "Your session has ended. Sign in again.",
	wrong_key: "That recovery key does not match this server.",
	// DECISIONS-GAP: D2.1 names an in-memory login-failure limiter but no code; D3's `too_many_attempts` (and any 429).
	too_many_attempts: "Too many failed attempts. Wait a minute and try again.",
	confirmation_mismatch: "The typed vault ID does not match this vault. Nothing was changed.",
	purge_incomplete: "The vault is closed, but some attachments are not removed yet. Press Delete vault again to finish.",
	restore_in_progress: "A restore of this vault has not finished. Pairing, revoking and resetting wait for it; press Restore to resume it.",
	restore_incomplete: "The restore started but has not finished. The server finishes it on its own within about a minute, or press Restore to resume it now.",
	invalid_restore_point: "That restore point is not usable. Enter an ISO 8601 time within the last 30 days, not in the future and at least a minute after the vault was created (Cloudflare keeps no earlier history).",
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
.mono { font-family: ui-monospace, monospace; min-width: min(22em, 100%); box-sizing: border-box; }
.warn { border-left: 4px solid #d80; padding-left: 10px; }
.err { color: #d33; } .ok { color: #2a7; } .muted { opacity: .7; font-size: 13px; }
img.qr { width: 240px; height: 240px; background: #fff; }
.grant { border-top: 1px solid #8884; padding-top: 4px; } .store { margin-left: 24px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<h1>YAOS server</h1>
<p id="info" class="muted"></p>
<noscript><p>The console needs JavaScript.</p></noscript>
<p id="msg" role="status" aria-live="polite"></p>
<div id="pair"></div>
<section id="unclaimed" hidden>
<h2>Set up this server from Obsidian</h2>
<p>This server has no operator and no vault yet. Vaults are created in Obsidian, not here: open Obsidian, run
<strong>YAOS: Create a new vault</strong> and enter this server's address, <span id="origin" class="mono"></span>.
That device claims the server, shows you the operator recovery key to save, and makes the vault and its keys.
Other devices then join by scanning a QR code from that device.</p>
<p>Afterwards, sign in here with the operator recovery key to see your vaults and revoke devices.</p>
</section>
<section id="login" hidden>
<h2>Sign in</h2>
<p>Paste the operator recovery key you saved when Obsidian set up this server.</p>
<form id="login-form" class="row"><input id="login-key" class="mono" type="password" autocomplete="current-password" aria-label="Operator recovery key"><button>Sign in</button></form>
</section>
<div id="main" hidden>
<div class="row"><button id="logout">Sign out</button></div>
<div id="vaults"></div>
</div>
<script nonce="${nonce}">
${QRCODE_SCRIPT}</script>
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
function day(value) { return typeof value === "string" && value ? value : "not yet"; }
function when(value) {
  const date = new Date(value);
  return value == null || isNaN(date.getTime()) ? "an unknown time" : date.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function copy(text) {
  navigator.clipboard.writeText(text).then(() => say("Copied.", "ok"), () => say("Copy failed: select the text and copy it by hand.", "err"));
}
function show(view) {
  for (const id of ["unclaimed", "login", "main"]) $(id).hidden = id !== view;
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
  $("vaults").replaceChildren(...(vaults.length ? vaults.map((v) => vaultCard(v, pending.get(v.vaultId))) : [h("p", { textContent: "No vaults yet. Create one in Obsidian with YAOS: Create a new vault." })]));
}
/** The setup QR: the URL setupQr.ts's buildMobileSetupUrl builds, as the SVG the Worker used to send (O12). */
function setupQr(code) {
  const qr = qrcode(0, "M");
  qr.addData(location.origin + "/mobile-setup#" + new URLSearchParams({ host: location.origin, pairingCode: code }), "Byte");
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
    .replace("<svg ", '<svg shape-rendering="crispEdges" ').replace('fill="black"', 'fill="#08111d"');
  return h("img", { className: "qr", src: "data:image/svg+xml;base64," + btoa(svg), alt: "Mobile setup QR code" });
}
function showCode(data, label) {
  const code = typeof data.pairingCode === "string" ? data.pairingCode : "";
  if (!code) return say("The server returned no pairing code. Reload and try again.", "err");
  const link = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host: location.origin, pairingCode: code });
  $("pair").replaceChildren(h("section", { className: "warn" },
    h("h2", { textContent: "Pair a device with " + label }),
    h("p", { textContent: "This adds a device to the existing vault " + label + "; it does not set up a vault. An encrypted vault also needs its key on the new device: scan a key QR from one of its devices or enter its recovery key." }),
    h("p", { textContent: "One-time pairing code, valid until " + when(data.expiresAt || data.pairingExpiresAt) + ". It is shown only here; reloading removes it." }),
    h("div", { className: "row" }, h("input", { className: "mono", readOnly: true, value: code }), h("button", { textContent: "Copy", onclick: () => copy(code) })),
    h("p", {}, h("a", { href: link, textContent: "Open in Obsidian on this device" })),
    setupQr(code),
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
    const grants = Array.isArray(r.data.grants) ? r.data.grants : [];
    const live = grants.filter((g) => g.revokedAt == null);
    const rows = [...live.map((g) => grantGroup(g, list.filter((d) => d.grantId === g.grantId))), ...list.filter((d) => !d.grantId).map(deviceRow)];
    if (!rows.length) rows.push(h("p", { textContent: "No paired devices." }));
    const revoked = grants.length - live.length;
    if (revoked) rows.push(h("p", { className: "muted", textContent: revoked + (revoked === 1 ? " revoked pairing is" : " revoked pairings are") + " not shown." }));
    devices.replaceChildren(...rows);
  }
  /** A pairing grant (one paired install) and its stores (identity-per-store §6.3). */
  function grantGroup(g, stores) {
    const name = g.name || "Unnamed device";
    return h("div", { className: "grant" },
      h("div", { className: "row" },
        h("strong", { textContent: name }),
        h("span", { className: "muted", textContent: "paired " + when(g.createdAt) + ", last seen " + day(g.lastSeenDay) + ", " + stores.length + (stores.length === 1 ? " store" : " stores") }),
        act("Rotate secret", async () => {
          if (!confirm("Rotate the pairing secret of " + name + "? Its stores keep syncing and pick up the new secret themselves. A copy of the old secret (an old data.json) can no longer add devices. A store someone else already registered with it is not cut off: remove it below, or revoke the pairing.")) return;
          const r = await api("POST", base + "/grants/" + enc(g.grantId) + "/rotate", {});
          if (r.status !== 200) return say(failure("Rotate secret", r), "err");
          say(r.data.rotated === false ? name + " is no longer paired." : "The pairing secret of " + name + " is rotated.", "ok");
          listDevices();
        }),
        act("Revoke pairing", async () => {
          if (!confirm("Revoke the pairing of " + name + "? Every store of it stops syncing at once, and that install has to be paired again.")) return;
          const r = await api("DELETE", base + "/grants/" + enc(g.grantId), {});
          if (r.status !== 200) return say(failure("Revoke pairing", r), "err");
          say(r.data.revoked === false ? name + " was already unpaired." : name + " is unpaired.", "ok");
          listDevices();
        })),
      ...stores.map((d) => h("div", { className: "row store" },
        h("span", { textContent: "Store " + String(d.deviceId).slice(0, 8) + ", registered " + when(d.enrolledAt) + ", last seen " + day(d.lastSeenDay) }),
        act("Remove device", async () => {
          if (!confirm("Remove this store of " + name + "? It stops syncing at once. While " + name + " is still paired it comes back as a new device on its next start; to block it, use Revoke pairing.")) return;
          const r = await api("DELETE", base + "/devices/" + enc(d.deviceId), {});
          if (r.status !== 200) return say(failure("Remove device", r), "err");
          say(r.data.revoked === false ? "That store of " + name + " was already removed." : "The store of " + name + " is removed.", "ok");
          listDevices();
        }))));
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
    if (!confirm("Restore " + label + " to Cloudflare's last snapshot at or before " + point + "? Synced content written after that snapshot (up to a minute before it) is discarded on the server.")) return;
    say("Restoring " + label + "; this takes a few seconds.");
    const r = await api("POST", base + "/restore", { at: point });
    done(r, "Restore", r.data.resumed
      ? "Finished the pending restore to " + when(r.data.at) + "; the time you entered was not used. Press Restore again to use it."
      : label + " is restored to Cloudflare's last snapshot at or before " + point + ". Devices start again from the new epoch.");
    if (r.status !== 200) load();
  }
  return h("section", {},
    h("h3", { textContent: label }),
    h("p", { className: "muted", textContent: "Vault ID " + id + (v.createdAt ? ", created " + when(v.createdAt) : "") }),
    pending ? h("p", { className: "warn", textContent: pending.failedAt != null
      ? "Restore stopped: the restore to " + when(pending.at) + " did not finish, and the server stopped retrying it at " + when(pending.failedAt) + " (" + String(pending.reason || "unknown reason") + "). Pairing, revoking and resetting wait for it. Press Restore to try it again, or delete the vault."
      : "Restore incomplete: the restore to " + when(pending.at) + " has not finished. " + MESSAGES.restore_incomplete }) : "",
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
      h("p", { textContent: "Restore rewinds synced content to a point within the last 30 days (Cloudflare point-in-time recovery; not in local development). Cloudflare keeps a snapshot about once a minute, so the restore lands up to a minute before the time you enter. Devices stay paired as they are now; unused pairing codes are cancelled." }),
      h("div", { className: "row" }, at, act("Restore", restore)),
      h("p", { textContent: "Delete vault removes the vault, its devices and its attachments for good." }),
      typed("Delete vault", async (confirmVaultId) => {
        const r = await api("DELETE", base, { confirmVaultId });
        done(r, "Delete vault", label + " is deleted. Its devices can no longer sync.");
      })));
}
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
(async () => {
  const caps = await api("GET", "/api/capabilities");
  if (caps.status !== 200) return say(failure("Reaching the server", caps), "err");
  $("info").textContent = "Server " + caps.data.serverVersion + ", attachments " + (caps.data.attachments ? "on (R2)" : "off");
  if (caps.data.claimed === true) return load();
  $("origin").textContent = location.origin;
  show("unclaimed");
})();
</script>
</body>
</html>
`;
}
