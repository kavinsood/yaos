interface SetupPageOptions {
	host: string;
	deployRepo?: string;
}

interface RunningPageOptions {
	host: string;
	authMode: "env" | "claim";
	attachments: boolean;
	snapshots: boolean;
}

interface MobileSetupPageOptions {
	host: string;
	deployRepo?: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const IS_MARKETPLACE_APPROVED = true;
const DEFAULT_DEPLOY_REPO = "kavinsood/yaos";

function normalizeDeployRepo(value: string | undefined): string {
	const raw = value?.trim();
	if (!raw) return DEFAULT_DEPLOY_REPO;
	// Keep this strict: owner/repo style slug only.
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
		return DEFAULT_DEPLOY_REPO;
	}
	return raw;
}

export function renderSetupPage(options: SetupPageOptions): string {
	const safeHost = escapeHtml(options.host);

	// Cleaned up the installation copy slightly for better reading
	const installationStep = `<div class="step-text">
              In Obsidian, open <em>Settings → Community plugins</em>, search for <strong>YAOS</strong>, install it, and make sure it is <strong>enabled</strong>.
           </div>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claim YAOS Server</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at 20% 20%, rgba(123, 223, 246, 0.12), transparent 40%),
        radial-gradient(circle at 80% 0%, rgba(255, 197, 90, 0.08), transparent 30%),
        linear-gradient(180deg, #08111d 0%, #0d1725 100%);
      color: #f4f7fb;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: min(640px, 100%);
      background: rgba(8, 17, 29, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(161, 205, 255, 0.15);
      border-radius: 24px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      position: relative;
      overflow: hidden;
    }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
    p { margin: 0; line-height: 1.5; color: #a9c0d8; }

    .hero { text-align: center; margin-bottom: 32px; display: flex; flex-direction: column; align-items: center;}
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 6px 12px;
      background: rgba(123, 223, 246, 0.1);
      border: 1px solid rgba(123, 223, 246, 0.15);
      color: #7bdff6;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    .host-badge {
      display: inline-block;
      margin-top: 12px;
      padding: 6px 12px;
      background: rgba(4, 10, 18, 0.6);
      border: 1px solid rgba(161, 205, 255, 0.1);
      border-radius: 8px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: #7bdff6;
    }

    button, a.cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 12px;
      padding: 14px 24px;
      background: #f4f7fb;
      color: #08111d;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    button:hover, a.cta:hover { background: #ffffff; transform: translateY(-1px); box-shadow: 0 8px 20px rgba(255,255,255,0.15); }
    button[disabled] { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

    .ghost-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.05);
      color: #f4f7fb;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      font-weight: 600;
    }
    .ghost-btn:hover { background: rgba(255,255,255,0.1); }

    #status { text-align: center; margin-top: 16px; font-size: 13px; color: #7bdff6; min-height: 20px; }

    /* The Success State */
    .success-flow {
      display: none;
      animation: fade-in 0.5s ease forwards;
    }
    .success-flow.show { display: block; }

    .flow-step {
      background: rgba(4, 10, 18, 0.4);
      border: 1px solid rgba(161, 205, 255, 0.1);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .step-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .step-number {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #7bdff6;
      color: #08111d;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
    }
    .step-header h2 { margin: 0; font-size: 16px; color: #f4f7fb; font-weight: 600;}

    .step-text ol { margin: 0; padding-left: 20px; color: #a9c0d8; font-size: 14px; line-height: 1.6;}
    .step-text li { margin-bottom: 6px; }
    .micro-text { font-size: 12px; color: #6984a3; margin-top: 12px; }
    .micro-text a { color: #7bdff6; text-decoration: none; }
    .micro-text a:hover { text-decoration: underline; }

    .checkbox-wrapper {
      margin-top: 16px;
      padding: 12px 16px;
      background: rgba(123, 223, 246, 0.05);
      border: 1px solid rgba(123, 223, 246, 0.15);
      border-radius: 10px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    .checkbox-wrapper:hover { background: rgba(123, 223, 246, 0.08); }
    .checkbox-wrapper input { width: 18px; height: 18px; accent-color: #7bdff6; cursor: pointer;}
    .checkbox-wrapper span { font-size: 14px; color: #f4f7fb; font-weight: 500;}
    .step-recovery {
      margin-top: 14px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .step-recovery .ghost-btn {
      padding: 10px 14px;
      font-size: 13px;
      text-decoration: none;
      box-sizing: border-box;
    }
    .step-recovery .ghost-btn.ghost-btn--light {
      background: #f4f7fb;
      color: #08111d;
      border-color: transparent;
    }
    .step-recovery .ghost-btn.ghost-btn--light:hover {
      background: #ffffff;
    }

    /* Step 2 states */
    .target-actions {
      display: flex;
      gap: 24px;
      margin-top: 16px;
      opacity: 1;
      transition: opacity 0.3s ease;
    }
    .disabled-step { opacity: 0.3; pointer-events: none; user-select: none; filter: grayscale(1); }

    .action-box {
      flex: 1;
      background: rgba(255,255,255,0.03);
      border: 1px dashed rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 12px;
    }
    .action-box p { font-size: 13px; margin-bottom: 4px;}

    #qr { background: #fff; padding: 8px; border-radius: 12px; display: inline-block;}
    #qr canvas { display: block; border-radius: 4px; width: 120px; height: 120px;}

    /* Manual Fallback Accordion */
    details {
      margin-top: 24px;
      background: rgba(4, 10, 18, 0.6);
      border: 1px solid rgba(161, 205, 255, 0.1);
      border-radius: 12px;
      overflow: hidden;
    }
    summary {
      padding: 14px 16px;
      font-size: 13px;
      color: #a9c0d8;
      cursor: pointer;
      font-weight: 500;
      user-select: none;
    }
    summary:hover { color: #f4f7fb; }
    .manual-content {
      padding: 0 16px 16px 16px;
      border-top: 1px solid rgba(161, 205, 255, 0.05);
      display: grid;
      gap: 12px;
      margin-top: 12px;
    }
    .manual-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .manual-label {
      display: block;
      font-size: 11px;
      color: #6984a3;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .manual-content input {
      flex: 1;
      background: rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.1);
      color: #7bdff6;
      font-family: monospace;
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 8px;
    }

    @keyframes fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 600px) {
      .target-actions { flex-direction: column; }
      .card { padding: 24px; }
    }
  </style>
</head>
<body>
  <main class="card">

    <div id="initial-view">
      <section class="hero">
        <div class="eyebrow">Zero-Config Setup</div>
        <h1>Claim your sync server</h1>
        <p>Your edge server is online. Claim it to generate your secure pairing token.</p>
        <div class="host-badge">${safeHost}</div>
      </section>
      <div style="display: flex; justify-content: center;">
        <button id="claim">Claim Server</button>
      </div>
      <div id="status" aria-live="polite"></div>
    </div>

    <div id="success-flow" class="success-flow">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1>Server Claimed!</h1>
        <p>Keep this page open. Let's connect your vault.</p>
      </div>

      <div class="flow-step">
        <div class="step-header">
          <div class="step-number">1</div>
          <h2>Get the YAOS plugin</h2>
        </div>
        ${installationStep}
        <label class="checkbox-wrapper">
          <input id="installed" type="checkbox" />
          <span>I have installed and <strong>enabled</strong> YAOS.</span>
        </label>
      </div>

      <div id="step2" class="flow-step disabled-step">
        <div class="step-header">
          <div class="step-number">2</div>
          <h2>Connect Obsidian</h2>
        </div>

        <div class="target-actions">
          <div class="action-box">
            <p>On this device</p>
            <a id="open" class="cta" aria-disabled="true">Auto-Configure</a>
          </div>
          <div class="action-box">
            <p>On a mobile device</p>
            <div id="qr" aria-label="YAOS mobile setup QR"></div>
          </div>
        </div>

        <details>
          <summary>Advanced: Manual Setup Token</summary>
	          <div class="manual-content">
	            <div>
	              <label for="host-input" class="manual-label">Server link</label>
	              <div class="manual-row">
	                <input id="host-input" type="text" readonly />
	                <button id="copy-host" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
	              </div>
	            </div>
	            <div>
	              <label for="token-input" class="manual-label">Token</label>
	              <div class="manual-row">
	                <input id="token-input" type="text" readonly />
	                <button id="copy-token" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
	              </div>
	            </div>
	            <div>
	              <label for="vault-input" class="manual-label">Vault ID</label>
	              <div class="manual-row">
	                <input id="vault-input" type="text" readonly />
	                <button id="copy-vault" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
	              </div>
	            </div>
	          </div>
	        </details>
	      </div>
    </div>

  </main>

  <script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"></script>
  <script>
    const initialView = document.getElementById("initial-view");
    const successFlow = document.getElementById("success-flow");
    const claimButton = document.getElementById("claim");
    const statusEl = document.getElementById("status");

    const installedCheckbox = document.getElementById("installed");
    const step2El = document.getElementById("step2");
    const openBtn = document.getElementById("open");
    const qrEl = document.getElementById("qr");

	    const hostInput = document.getElementById("host-input");
	    const tokenInput = document.getElementById("token-input");
	    const vaultInput = document.getElementById("vault-input");
	    const copyHostBtn = document.getElementById("copy-host");
	    const copyTokenBtn = document.getElementById("copy-token");
	    const copyVaultBtn = document.getElementById("copy-vault");

	    function randomToken() {
	      const bytes = new Uint8Array(32);
	      crypto.getRandomValues(bytes);
	      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
	    }

	    function randomVaultId() {
	      const bytes = new Uint8Array(16);
	      crypto.getRandomValues(bytes);
	      let binary = "";
	      for (const b of bytes) binary += String.fromCharCode(b);
	      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
	    }

	    function buildMobileSetupUrl(host, token, vaultId) {
	      const hash = new URLSearchParams({ host: host, token: token, vaultId: vaultId }).toString();
	      return host + "/mobile-setup#" + hash;
	    }

    function renderQr(text) {
      if (!text || !window.QRious) return;
      qrEl.innerHTML = "";
      const canvas = document.createElement("canvas");
      qrEl.appendChild(canvas);
      new window.QRious({
        element: canvas,
        value: text,
        size: 240,
        level: "M",
        foreground: "#08111d",
        background: "#ffffff",
      });
    }

    // Toggle Step 2 state based on checkbox
    installedCheckbox.addEventListener("change", (e) => {
      const isChecked = e.target.checked;
      if (isChecked) {
        step2El.classList.remove("disabled-step");
        openBtn.removeAttribute("aria-disabled");
      } else {
        step2El.classList.add("disabled-step");
        openBtn.setAttribute("aria-disabled", "true");
      }
    });

    // Prevent click on auto-configure if disabled
    openBtn.addEventListener("click", (e) => {
      if (!installedCheckbox.checked) {
        e.preventDefault();
      }
    });

    copyHostBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(hostInput.value);
      const originalText = copyHostBtn.textContent;
      copyHostBtn.textContent = "Copied!";
      setTimeout(() => copyHostBtn.textContent = originalText, 2000);
    });

    // Copy token logic
	    copyTokenBtn.addEventListener("click", async () => {
	      await navigator.clipboard.writeText(tokenInput.value);
	      const originalText = copyTokenBtn.textContent;
	      copyTokenBtn.textContent = "Copied!";
	      setTimeout(() => copyTokenBtn.textContent = originalText, 2000);
	    });

	    copyVaultBtn.addEventListener("click", async () => {
	      await navigator.clipboard.writeText(vaultInput.value);
	      const originalText = copyVaultBtn.textContent;
	      copyVaultBtn.textContent = "Copied!";
	      setTimeout(() => copyVaultBtn.textContent = originalText, 2000);
	    });

	    claimButton.addEventListener("click", async () => {
	      claimButton.disabled = true;
	      statusEl.textContent = "Claiming server...";
	      const token = randomToken();
	      const vaultId = randomVaultId();

	      try {
	        const res = await fetch("/claim", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ token, vaultId }),
	        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Claim failed");
        }

	        // Setup the UI state
	        hostInput.value = window.location.origin;
	        tokenInput.value = token;
	        vaultInput.value = vaultId;

	        // Deep link for local button
	        const deepLink = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host: window.location.origin, token: token, vaultId: vaultId }).toString();
	        openBtn.href = deepLink;

	        // QR Code pointing to the trampoline page
	        renderQr(buildMobileSetupUrl(window.location.origin, token, vaultId));

        // Switch Views
        initialView.style.display = "none";
        successFlow.classList.add("show");

      } catch (error) {
        statusEl.textContent = error.message;
        claimButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export function renderMobileSetupPage(options: MobileSetupPageOptions): string {
	const safeHost = escapeHtml(options.host);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect YAOS</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh;
      display: grid; place-items: center; padding: 24px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #08111d; color: #f4f7fb;
    }
    .card {
      width: min(400px, 100%);
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px; padding: 32px 24px;
      text-align: center;
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 24px; color: #a9c0d8; font-size: 15px; line-height: 1.5;}

    .cta {
      display: flex; align-items: center; justify-content: center;
      width: 100%; border-radius: 12px; padding: 16px;
      background: #7bdff6; color: #08111d;
      font-weight: 600; font-size: 16px; text-decoration: none;
      transition: opacity 0.2s; box-sizing: border-box;
    }
    .cta:active { opacity: 0.8; }
    .cta[aria-disabled="true"] { opacity: 0.5; pointer-events: none; background: #4a5a6a;}

    .status { margin-top: 16px; font-size: 13px; color: #7bdff6; min-height: 20px;}
    .recovery {
      margin-top: 16px;
      text-align: left;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 12px;
    }
    .recovery p {
      margin: 0 0 8px;
      font-size: 13px;
      color: #a9c0d8;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .ghost {
      flex: 1;
      border-radius: 10px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: #f4f7fb;
      text-decoration: none;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      box-sizing: border-box;
    }
    .ghost:active { opacity: 0.8; }

    details { margin-top: 32px; text-align: left; }
    summary { color: #6984a3; font-size: 13px; cursor: pointer; padding: 8px 0;}
    .manual-box {
      margin-top: 12px; background: rgba(0,0,0,0.3);
      padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05);
    }
    .manual-box label { display: block; font-size: 11px; color: #a9c0d8; margin-bottom: 4px;}
    .manual-box input {
      width: 100%; background: transparent; border: none;
      color: #7bdff6; font-family: monospace; margin-bottom: 12px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect YAOS</h1>
    <p>Link this phone to <strong>${safeHost}</strong> in two steps.</p>

    <a id="connect-button" class="cta" href="#" aria-disabled="true">Connect Obsidian</a>
    <div id="status" class="status">Loading setup data...</div>
    <div class="recovery">
      <p>Don't have YAOS installed on this phone yet?</p>
      <p style="margin-top: 6px;">1. In Obsidian, open <strong>Community plugins</strong>.</p>
      <p style="margin-top: 4px;">2. Search for <strong>YAOS</strong>, install it, and enable it.</p>
      <p style="margin-top: 4px; margin-bottom: 0;">3. Come back here and tap <strong>Connect Obsidian</strong>.</p>
    </div>

	    <details>
	      <summary>Manual Fallback</summary>
	      <div class="manual-box">
	        <label>Host</label>
	        <input id="host-input" readonly />
	        <label>Token</label>
	        <input id="token-input" readonly />
	        <label>Vault ID</label>
	        <input id="vault-input" readonly />
	        <p style="font-size: 11px; margin: 0; color: #6984a3;">Copy these to YAOS settings if the button fails.</p>
	      </div>
	    </details>
  </main>

  <script>
    const connectBtn = document.getElementById("connect-button");
	    const statusEl = document.getElementById("status");
	    const hostInput = document.getElementById("host-input");
	    const tokenInput = document.getElementById("token-input");
	    const vaultInput = document.getElementById("vault-input");

    function parseHash() {
      const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
      const params = new URLSearchParams(hash);
	      return {
	        host: (params.get("host") || "").trim().replace(/\\/$/, ""),
	        token: (params.get("token") || "").trim(),
	        vaultId: (params.get("vaultId") || "").trim(),
	      };
	    }

	    const { host, token, vaultId } = parseHash();

	    if (!host || !token || !vaultId) {
	      statusEl.textContent = "Error: Invalid setup link. Please re-scan the QR code.";
	      statusEl.style.color = "#ff6b6b";
	    } else {
	      hostInput.value = host;
	      tokenInput.value = token;
	      vaultInput.value = vaultId;

	      const deepLink = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host, token, vaultId }).toString();
	      connectBtn.href = deepLink;
	      connectBtn.removeAttribute("aria-disabled");

      // Scrub the URL history to hide the token fragment immediately
      window.history.replaceState(null, "", window.location.pathname);

      statusEl.textContent = "Ready. Install YAOS from Community plugins if needed, then tap Connect Obsidian.";
    }
  </script>
</body>
</html>`;
}

export function renderRunningPage(options: RunningPageOptions): string {
	const authLabel =
		options.authMode === "env"
			? "Secured by an environment token."
			: "This server has been claimed and is locked.";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YAOS Server Running</title>
  <style>
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
      background: #08111d; color: #f4f7fb;
      min-height: 100vh; display: grid; place-items: center; padding: 24px;
    }
    .card {
      width: min(480px, 100%); background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px;
      text-align: center;
    }
    .pulse-dot {
      width: 12px; height: 12px; background: #88ffb8; border-radius: 50%;
      display: inline-block; margin-right: 8px;
      box-shadow: 0 0 12px rgba(136, 255, 184, 0.5);
    }
    h1 { margin: 0 0 12px; font-size: 24px; display: flex; align-items: center; justify-content: center;}
    p { margin: 0 0 24px; color: #a9c0d8; line-height: 1.5; }
    .features { display: flex; gap: 16px; justify-content: center; }
    .badge { padding: 6px 12px; background: rgba(255,255,255,0.05); border-radius: 999px; font-size: 12px; border: 1px solid rgba(255,255,255,0.1);}
    .badge.active { color: #88ffb8; border-color: rgba(136, 255, 184, 0.3); }
    .badge.inactive { color: #6984a3; }
  </style>
</head>
<body>
  <main class="card">
    <h1><span class="pulse-dot"></span>YAOS Server is Online</h1>
    <p>${authLabel}</p>
    <div class="features">
      <div class="badge active">Text Sync</div>
      <div class="badge ${options.attachments ? "active" : "inactive"}">Attachments: ${options.attachments ? "ON" : "OFF"}</div>
      <div class="badge ${options.snapshots ? "active" : "inactive"}">Snapshots: ${options.snapshots ? "ON" : "OFF"}</div>
    </div>
  </main>
</body>
</html>`;
}
