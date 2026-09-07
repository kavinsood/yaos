interface SetupPageOptions {
	host: string;
}

interface OperatorPageOptions {
	host: string;
	attachments?: boolean;
	snapshots?: boolean;
}

interface MobileSetupPageOptions {
	host: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function operatorDestroyStatusMessage(status: number): string {
	if (status === 200) return "Vault cleanup is complete.";
	if (status === 202) return "Vault access is revoked; physical cleanup is still pending.";
	if (status === 401) return "Session expired. Reload and sign in.";
	if (status === 400) return "Vault destroy request was rejected.";
	if (status === 404) return "Vault was not found.";
	if (status >= 500) return "Server or configuration error prevented vault destruction.";
	return `Vault destruction failed (HTTP ${status}).`;
}

export function operatorStateLoadFailureMessage(status: number | null): string {
	return status === 401
		? "Session expired. Reload and sign in."
		: "Could not load server configuration. Try again.";
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
    #qr img { display: block; border-radius: 4px; width: 120px; height: 120px;}

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
        <p style="margin-bottom: 12px;">This Obsidian folder is one vault. The pairing code works once for 15 minutes. After enrollment, this device is a peer and can add devices.</p>
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
          <summary>Save your operator recovery key, then connect</summary>
          <div class="manual-content">
            <div>
              <label for="host-input" class="manual-label">Server link</label>
              <div class="manual-row">
                <input id="host-input" type="text" readonly />
                <button id="copy-host" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
              </div>
            </div>
            <div>
              <label for="operator-recovery-key-input" class="manual-label">Operator recovery key — password manager only</label>
              <div class="manual-row">
                <input id="operator-recovery-key-input" type="text" readonly />
                <button id="copy-operator-recovery-key" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
              </div>
            </div>
            <div>
              <label for="pairing-input" class="manual-label">One-time pairing code</label>
              <div class="manual-row">
                <input id="pairing-input" type="text" readonly />
                <button id="copy-pairing" class="ghost-btn" style="padding: 10px 16px;">Copy</button>
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>

  </main>

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
    const operatorRecoveryKeyInput = document.getElementById("operator-recovery-key-input");
    const pairingInput = document.getElementById("pairing-input");
    const copyHostBtn = document.getElementById("copy-host");
    const copyOperatorRecoveryKeyBtn = document.getElementById("copy-operator-recovery-key");
    const copyPairingBtn = document.getElementById("copy-pairing");

    function randomOperatorRecoveryKey() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    }

    function renderQr(dataUrl) {
      if (!dataUrl || !dataUrl.startsWith("data:image/svg+xml;base64,")) return;
      qrEl.replaceChildren();
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = "YAOS mobile setup QR";
      qrEl.appendChild(image);
    }

    function copyFrom(input, button) {
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(input.value);
        const originalText = button.textContent;
        button.textContent = "Copied!";
        setTimeout(() => button.textContent = originalText, 2000);
      });
    }

    installedCheckbox.addEventListener("change", (event) => {
      if (event.target.checked) {
        step2El.classList.remove("disabled-step");
        openBtn.removeAttribute("aria-disabled");
      } else {
        step2El.classList.add("disabled-step");
        openBtn.setAttribute("aria-disabled", "true");
      }
    });
    openBtn.addEventListener("click", (event) => {
      if (!installedCheckbox.checked) event.preventDefault();
    });
    copyFrom(hostInput, copyHostBtn);
    copyFrom(operatorRecoveryKeyInput, copyOperatorRecoveryKeyBtn);
    copyFrom(pairingInput, copyPairingBtn);

    claimButton.addEventListener("click", async () => {
      claimButton.disabled = true;
      statusEl.textContent = "Claiming server...";
      const operatorRecoveryKey = randomOperatorRecoveryKey();
      try {
        const res = await fetch("/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operatorRecoveryKey }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || "Claim failed");
        if (!data || typeof data.mobileSetupQrDataUrl !== "string" || typeof data.pairingCode !== "string" || typeof data.obsidianUrl !== "string") {
          throw new Error("Setup QR generation failed");
        }
        hostInput.value = window.location.origin;
        operatorRecoveryKeyInput.value = operatorRecoveryKey;
        pairingInput.value = data.pairingCode;
        openBtn.href = data.obsidianUrl;
        renderQr(data.mobileSetupQrDataUrl);
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
    <p>Link this phone to <strong>${safeHost}</strong>. The pairing code works once for 15 minutes.</p>

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
	        <label>Pairing code</label>
	        <input id="pairing-code-input" readonly />
	        <p style="font-size: 11px; margin: 0; color: #6984a3;">Copy these to YAOS settings if the button fails.</p>
	      </div>
	    </details>
  </main>

  <script>
    const connectBtn = document.getElementById("connect-button");
    const statusEl = document.getElementById("status");
    const hostInput = document.getElementById("host-input");
    const pairingCodeInput = document.getElementById("pairing-code-input");

    function parseHash() {
      const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
      const params = new URLSearchParams(hash);
      return {
        host: (params.get("host") || "").trim().replace(/\\/$/, ""),
        pairingCode: (params.get("pairingCode") || "").trim(),
      };
    }

    const { host, pairingCode } = parseHash();
    if (!host || !pairingCode) {
      statusEl.textContent = "Error: Invalid setup link. Please re-scan the QR code.";
      statusEl.style.color = "#ff6b6b";
    } else {
      hostInput.value = host;
      pairingCodeInput.value = pairingCode;
      connectBtn.href = "obsidian://yaos?" + new URLSearchParams({ action: "setup", host, pairingCode }).toString();
      connectBtn.removeAttribute("aria-disabled");
      window.history.replaceState(null, "", window.location.pathname);
      statusEl.textContent = "Ready. Install YAOS from Community plugins if needed, then tap Connect Obsidian.";
    }
  </script>
</body>
</html>`;
}

export function renderOperatorLogin(options: OperatorPageOptions): string {
	const safeHost = escapeHtml(options.host);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YAOS operator</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #08111d; color: #f4f7fb; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(440px, 100%); background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { color: #a9c0d8; line-height: 1.5; }
    input { width: 100%; box-sizing: border-box; margin: 12px 0; padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: #040a12; color: #7bdff6; font-family: monospace; }
    button { width: 100%; padding: 12px; border: 0; border-radius: 10px; background: #7bdff6; color: #08111d; font-weight: 600; cursor: pointer; }
    .status { min-height: 20px; font-size: 13px; color: #ff8a8a; }
    .host { font-size: 12px; color: #6984a3; }
  </style>
</head>
<body>
  <main class="card">
    <div class="host">${safeHost}</div>
    <h1>Operator sign-in</h1>
    <p>Paste the recovery key you saved when you claimed this server. This is not a device pairing code.</p>
    <input id="operator-recovery-key" type="password" autocomplete="current-password" placeholder="Operator recovery key" />
    <button id="login">Open console</button>
    <p id="status" class="status"></p>
  </main>
  <script>
    document.getElementById("login").addEventListener("click", async () => {
      const operatorRecoveryKey = document.getElementById("operator-recovery-key").value.trim();
      const status = document.getElementById("status");
      status.textContent = "";
      const res = await fetch("/operator/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorRecoveryKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        status.textContent = (data && data.message) || "That key does not match this server.";
        return;
      }
      window.location.reload();
    });
  </script>
</body>
</html>`;
}

export function renderOperatorConsole(options: OperatorPageOptions): string {
	const attachments = options.attachments ? "ON" : "OFF";
	const snapshots = options.snapshots ? "ON" : "OFF";
	const destroyStatusMessages = JSON.stringify({
		200: operatorDestroyStatusMessage(200),
		202: operatorDestroyStatusMessage(202),
		400: operatorDestroyStatusMessage(400),
		401: operatorDestroyStatusMessage(401),
		404: operatorDestroyStatusMessage(404),
		500: operatorDestroyStatusMessage(500),
	});
	const stateLoadMessages = JSON.stringify({
		401: operatorStateLoadFailureMessage(401),
		failure: operatorStateLoadFailureMessage(null),
	});
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YAOS console</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #08111d; color: #f4f7fb; padding: 32px 16px; }
    main { width: min(720px, 100%); margin: 0 auto; }
    h1 { font-size: 24px; }
    p, li, label { color: #a9c0d8; line-height: 1.5; }
    button, input { border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: #040a12; color: #f4f7fb; padding: 8px 12px; }
    button { cursor: pointer; background: #163044; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 16px; }
    .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    code { color: #7bdff6; }
    .err { color: #ff8a8a; }
    .danger { color: #ff8a8a; }
    .collaboration-action { margin: 16px 0; padding: 14px; border: 1px solid rgba(123,223,246,0.2); border-radius: 10px; background: rgba(123,223,246,0.04); }
    .collaboration-action h3 { margin: 0 0 8px; font-size: 16px; }
    .collaboration-action fieldset { margin: 12px 0; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }
    .collaboration-action label { display: block; margin: 6px 0; }
    .collaboration-action input[type="text"] { box-sizing: border-box; width: min(360px, 100%); }
    .collaboration-action .row label { margin: 0; }
    .action-status { min-height: 1.5em; }
    .secret-result { overflow-wrap: anywhere; }
    .secret-result a { color: #7bdff6; }
  </style>
</head>
<body>
  <main>
    <h1>YAOS console</h1>
    <p>Attachments ${attachments} · Snapshots ${snapshots}. Each vault has one owner and full content members. People invite people; each person links their own additional devices. Operator owner codes work once for 15 minutes and are only for bootstrap or lost-owner recovery.</p>
    <div class="row">
      <input id="vault-name" placeholder="New vault name" />
      <button id="create-vault" disabled>Create vault</button>
      <button id="logout">Sign out</button>
    </div>
    <div class="row">
      <input id="update-repo" placeholder="Deployment repository URL" style="min-width: 280px;" />
      <input id="update-branch" placeholder="Branch" style="width: 120px;" />
      <button id="save-update">Save updater</button>
    </div>
    <p id="status" class="err"></p>
    <div id="vaults"></div>
  </main>
  <script>
    const status = document.getElementById("status");
    const root = document.getElementById("vaults");
    const createVault = document.getElementById("create-vault");
    const destroyStatusMessages = ${destroyStatusMessages};
    const stateLoadMessages = ${stateLoadMessages};
    let stateLoadVersion = 0;
    function formatWhen(ts) {
      if (typeof ts !== "number" || !isFinite(ts)) return "";
      const date = new Date(ts);
      return isNaN(date.getTime()) ? "" : date.toISOString();
    }
    function actionError(data, fallback) {
      const error = data && typeof data.error === "string" ? data.error : "";
      if (error === "owner_invariant") return fallback + " The vault owner state changed; reload and review it.";
      if (error === "authority_superseded") return fallback + " Vault authority changed; reload before retrying.";
      if (error === "already_migrated") return "This vault already has collaboration identities. Reload the console.";
      return error ? fallback + " (" + error + ")" : fallback;
    }
    function showOwnerCode(slot, purpose, data) {
      slot.replaceChildren();
      if (!data || typeof data.pairingCode !== "string" || !data.pairingCode) {
        slot.textContent = "The owner code response was invalid. Reload before trying again.";
        slot.classList.add("err");
        return;
      }
      slot.classList.remove("err");
      slot.classList.add("secret-result");
      const warning = document.createElement("p");
      warning.textContent = (purpose === "owner-recovery" ? "Owner recovery" : "Owner setup") +
        " code (once, expires " + (formatWhen(data.expiresAt) || "in 15 minutes") + "):";
      slot.appendChild(warning);
      const code = document.createElement("code");
      code.textContent = data.pairingCode;
      slot.appendChild(code);
      const disclosure = document.createElement("p");
      disclosure.textContent = "This secret is shown only in this result. Use it now; reloading removes it from the console.";
      slot.appendChild(disclosure);
      const links = document.createElement("p");
      if (typeof data.obsidianUrl === "string" && data.obsidianUrl) {
        const desktop = document.createElement("a");
        desktop.href = data.obsidianUrl;
        desktop.textContent = "Open in Obsidian";
        links.appendChild(desktop);
      }
      if (typeof data.mobileSetupUrl === "string" && data.mobileSetupUrl) {
        if (links.childNodes.length > 0) links.appendChild(document.createTextNode(" · "));
        const mobile = document.createElement("a");
        mobile.href = data.mobileSetupUrl;
        mobile.textContent = "Open mobile setup";
        links.appendChild(mobile);
      }
      if (links.childNodes.length > 0) slot.appendChild(links);
    }
    function updateMigrationButton(card) {
      const button = card && card.querySelector("[data-collaboration-migrate]");
      if (!button || button.dataset.pending === "true") return;
      const displayName = card.querySelector(".owner-display-name");
      const confirmation = card.querySelector(".migration-confirm");
      const selected = card.querySelectorAll(".migration-owner-device:checked");
      button.disabled = !displayName || !displayName.value.trim() || selected.length === 0 || !confirmation || !confirmation.checked;
    }
    async function requestOwnerCode(vaultId, purpose, button, slot) {
      button.disabled = true;
      button.dataset.pending = "true";
      slot.classList.remove("err");
      slot.textContent = purpose === "owner-recovery" ? "Issuing owner recovery code…" : "Issuing owner setup code…";
      let response;
      try {
        response = await fetch("/operator/vaults/" + encodeURIComponent(vaultId) + "/owner-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purpose }),
        });
      } catch {
        slot.classList.add("err");
        slot.textContent = "Could not reach the server to issue the owner code.";
        button.disabled = false;
        button.dataset.pending = "false";
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        slot.classList.add("err");
        slot.textContent = actionError(data, "Could not issue the owner code.");
        button.disabled = false;
        button.dataset.pending = "false";
        return;
      }
      button.textContent = "Code issued";
      showOwnerCode(slot, purpose, data);
    }
    function isOperatorState(data) {
      return data !== null
        && typeof data === "object"
        && !Array.isArray(data)
        && data.ok === true
        && Array.isArray(data.vaults)
        && data.vaults.every((vault) =>
          vault !== null
          && typeof vault === "object"
          && !Array.isArray(vault)
          && typeof vault.vaultId === "string"
          && typeof vault.name === "string")
        && Array.isArray(data.devices)
        && data.devices.every((device) =>
          device !== null
          && typeof device === "object"
          && !Array.isArray(device)
          && typeof device.vaultId === "string"
          && typeof device.deviceId === "string"
          && typeof device.name === "string")
        && Array.isArray(data.pairingCodes)
        && data.pairingCodes.every((code) =>
          code !== null
          && typeof code === "object"
          && !Array.isArray(code)
          && typeof code.vaultId === "string"
          && typeof code.codeId === "string"
          && typeof code.purpose === "string")
        && Array.isArray(data.pendingDestroys)
        && data.pendingDestroys.every((pending) =>
          pending !== null
          && typeof pending === "object"
          && !Array.isArray(pending)
          && typeof pending.vaultId === "string"
          && typeof pending.roomComplete === "boolean"
          && typeof pending.r2Complete === "boolean"
          && (pending.lastError === null || typeof pending.lastError === "string"))
        && Array.isArray(data.pendingDeviceRevocations)
        && data.pendingDeviceRevocations.every((pending) =>
          pending !== null
          && typeof pending === "object"
          && !Array.isArray(pending)
          && typeof pending.vaultId === "string"
          && typeof pending.vaultGeneration === "string"
          && typeof pending.deviceId === "string"
          && typeof pending.requestedAt === "number"
          && (pending.lastError === null || typeof pending.lastError === "string"))
        && Array.isArray(data.principals)
        && data.principals.every((principal) =>
          principal !== null
          && typeof principal === "object"
          && !Array.isArray(principal)
          && typeof principal.vaultId === "string"
          && typeof principal.principalId === "string"
          && typeof principal.displayName === "string")
        && Array.isArray(data.memberships)
        && data.memberships.every((membership) =>
          membership !== null
          && typeof membership === "object"
          && !Array.isArray(membership)
          && typeof membership.vaultId === "string"
          && typeof membership.principalId === "string"
          && (membership.role === "owner" || membership.role === "member")
          && typeof membership.state === "string")
        && Array.isArray(data.authorizationChanges)
        && data.authorizationChanges.every((change) =>
          change !== null
          && typeof change === "object"
          && !Array.isArray(change)
          && typeof change.changeId === "string"
          && typeof change.vaultId === "string"
          && typeof change.kind === "string"
          && typeof change.state === "string")
        && Array.isArray(data.vaultGovernanceRequests)
        && data.vaultGovernanceRequests.every((request) =>
          request !== null
          && typeof request === "object"
          && !Array.isArray(request)
          && typeof request.governanceRequestId === "string"
          && typeof request.vaultId === "string"
          && typeof request.kind === "string"
          && typeof request.state === "string");
    }
    function showDestroyStatus(responseStatus) {
      if (responseStatus >= 500) {
        status.textContent = destroyStatusMessages["500"];
        return;
      }
      status.textContent = destroyStatusMessages[String(responseStatus)]
        || "Vault destruction failed (HTTP " + responseStatus + ").";
    }
    async function requestVaultDestroy(vaultId, governanceRequestId) {
      try {
        const res = await fetch("/operator/vaults/" + encodeURIComponent(vaultId), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ governanceRequestId }),
        });
        showDestroyStatus(res.status);
      } catch {
        status.textContent = "Could not reach the server to destroy the vault.";
      }
      await load(true);
    }
    async function requestEmergencyVaultDestroy(vaultId, reason) {
      try {
        const res = await fetch("/operator/vaults/" + encodeURIComponent(vaultId) + "/emergency-destroy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: crypto.randomUUID().replaceAll("-", ""), reason }),
        });
        showDestroyStatus(res.status);
      } catch {
        status.textContent = "Could not reach the server for emergency vault destruction.";
      }
      await load(true);
    }
    async function load(preserveStatus = false) {
      const loadVersion = ++stateLoadVersion;
      createVault.disabled = true;
      root.replaceChildren();
      let res;
      try {
        res = await fetch("/operator/state");
      } catch {
        if (loadVersion === stateLoadVersion) status.textContent = stateLoadMessages.failure;
        return;
      }
      if (loadVersion !== stateLoadVersion) return;
      if (res.status === 401) {
        status.textContent = stateLoadMessages["401"];
        return;
      }
      if (!res.ok) {
        status.textContent = stateLoadMessages.failure;
        return;
      }
      const data = await res.json().catch(() => null);
      if (loadVersion !== stateLoadVersion) return;
      if (!isOperatorState(data)) {
        status.textContent = stateLoadMessages.failure;
        return;
      }
      try {
        const capsRes = await fetch("/api/capabilities");
        if (capsRes.ok) {
          const caps = await capsRes.json().catch(() => null);
          if (caps) {
            const repo = document.getElementById("update-repo");
            const branch = document.getElementById("update-branch");
            if (repo && typeof caps.updateRepoUrl === "string") repo.value = caps.updateRepoUrl;
            if (branch && typeof caps.updateRepoBranch === "string") branch.value = caps.updateRepoBranch;
          }
        }
      } catch {}
      if (loadVersion !== stateLoadVersion) return;
      const rendered = document.createDocumentFragment();
      for (const vault of data.vaults || []) {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.vaultId = vault.vaultId;
        card.dataset.vaultName = vault.name;

        const heading = document.createElement("h2");
        heading.textContent = vault.name;
        card.appendChild(heading);

        const idLine = document.createElement("p");
        const idCode = document.createElement("code");
        idCode.textContent = vault.vaultId;
        idLine.appendChild(idCode);
        card.appendChild(idLine);

        const devices = (data.devices || []).filter((device) => device.vaultId === vault.vaultId);
        const memberships = (data.memberships || []).filter((membership) => membership.vaultId === vault.vaultId);
        const ownerMembership = memberships.find((membership) => membership.role === "owner" && membership.state !== "revoked");
        const ownerPrincipal = ownerMembership
          ? (data.principals || []).find((principal) => principal.principalId === ownerMembership.principalId)
          : null;
        const pendingMigration = (data.authorizationChanges || []).find((change) =>
          change.vaultId === vault.vaultId
          && change.kind === "authority-install"
          && change.changeId.indexOf("collab_migrate_") === 0
          && change.state !== "complete");
        const needsMigration = devices.length > 0 && memberships.length === 0
          && devices.every((device) => typeof device.principalId !== "string");

        if (vault.state === "provisioning") {
          const provisioning = document.createElement("p");
          provisioning.className = "err";
          provisioning.textContent = "Provisioning is incomplete. Retry the same vault generation.";
          card.appendChild(provisioning);
          const retryProvision = document.createElement("button");
          retryProvision.textContent = "Retry provisioning";
          retryProvision.dataset.retryProvision = vault.vaultId;
          card.appendChild(retryProvision);
        }

        if (vault.state === "awaiting_owner") {
          const ownerSetup = document.createElement("section");
          ownerSetup.className = "collaboration-action";
          const ownerSetupHeading = document.createElement("h3");
          ownerSetupHeading.textContent = "Set up the vault owner";
          ownerSetup.appendChild(ownerSetupHeading);
          const ownerSetupDetail = document.createElement("p");
          ownerSetupDetail.textContent = ownerMembership
            ? "Owner enrollment exists and its vault authority installation is still pending. Do not issue another bootstrap identity."
            : "This vault has no owner yet. Issue one one-use code, then enroll the owner's first Obsidian device.";
          ownerSetup.appendChild(ownerSetupDetail);
          if (!ownerMembership) {
            const ownerSetupButton = document.createElement("button");
            ownerSetupButton.textContent = "Issue owner setup code";
            ownerSetupButton.dataset.ownerCode = vault.vaultId;
            ownerSetupButton.dataset.ownerCodePurpose = "owner-bootstrap";
            ownerSetup.appendChild(ownerSetupButton);
            const ownerSetupResult = document.createElement("div");
            ownerSetupResult.className = "owner-code-result action-status";
            ownerSetup.appendChild(ownerSetupResult);
          }
          card.appendChild(ownerSetup);
        }

        if (needsMigration || pendingMigration) {
          const migration = document.createElement("section");
          migration.className = "collaboration-action migration-action";
          migration.dataset.locked = pendingMigration ? "true" : "false";
          const migrationHeading = document.createElement("h3");
          migrationHeading.textContent = pendingMigration ? "Finish collaboration migration" : "Upgrade to human collaboration";
          migration.appendChild(migrationHeading);
          const migrationDetail = document.createElement("p");
          migrationDetail.textContent = pendingMigration
            ? "The identity migration was prepared but did not finish installing vault authority. Review the locked owner grouping and retry the exact operation."
            : "Choose every existing device that belongs to the owner. Selected devices become one owner identity; every unselected device becomes a separate full member. This cannot be inferred or safely undone.";
          migration.appendChild(migrationDetail);
          if (pendingMigration && pendingMigration.lastError) {
            const migrationError = document.createElement("p");
            migrationError.className = "err";
            migrationError.textContent = "Last authority installation error: " + pendingMigration.lastError;
            migration.appendChild(migrationError);
          }
          const nameLabel = document.createElement("label");
          nameLabel.textContent = "Owner display name";
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.className = "owner-display-name";
          nameInput.maxLength = 80;
          nameInput.placeholder = "Owner name";
          nameInput.value = ownerPrincipal ? ownerPrincipal.displayName : "";
          nameInput.disabled = Boolean(pendingMigration);
          nameLabel.appendChild(document.createElement("br"));
          nameLabel.appendChild(nameInput);
          migration.appendChild(nameLabel);
          const ownerDevices = document.createElement("fieldset");
          const ownerDevicesLegend = document.createElement("legend");
          ownerDevicesLegend.textContent = "Devices belonging to the owner";
          ownerDevices.appendChild(ownerDevicesLegend);
          for (const device of devices) {
            const deviceLabel = document.createElement("label");
            const deviceInput = document.createElement("input");
            deviceInput.type = "checkbox";
            deviceInput.className = "migration-owner-device";
            deviceInput.value = device.deviceId;
            deviceInput.checked = Boolean(ownerMembership && device.principalId === ownerMembership.principalId);
            deviceInput.disabled = Boolean(pendingMigration);
            deviceLabel.appendChild(deviceInput);
            deviceLabel.appendChild(document.createTextNode(" " + device.name + " (" + device.deviceId.slice(0, 8) + ")"));
            ownerDevices.appendChild(deviceLabel);
          }
          migration.appendChild(ownerDevices);
          const migrationConfirmLabel = document.createElement("label");
          const migrationConfirm = document.createElement("input");
          migrationConfirm.type = "checkbox";
          migrationConfirm.className = "migration-confirm";
          migrationConfirmLabel.appendChild(migrationConfirm);
          migrationConfirmLabel.appendChild(document.createTextNode(pendingMigration
            ? " I reviewed this locked grouping and want to retry the incomplete migration."
            : " I reviewed every device and understand unselected devices become separate members."));
          migration.appendChild(migrationConfirmLabel);
          const migrationButton = document.createElement("button");
          migrationButton.textContent = pendingMigration ? "Retry collaboration migration" : "Migrate collaboration identities";
          migrationButton.dataset.collaborationMigrate = vault.vaultId;
          migrationButton.disabled = true;
          migration.appendChild(migrationButton);
          const migrationStatus = document.createElement("p");
          migrationStatus.className = "migration-status action-status";
          migration.appendChild(migrationStatus);
          card.appendChild(migration);
        }

        if (vault.state === "active" && ownerMembership && ownerMembership.state === "active") {
          const recovery = document.createElement("section");
          recovery.className = "collaboration-action owner-recovery-action";
          const recoveryHeading = document.createElement("h3");
          recoveryHeading.textContent = "Owner access recovery";
          recovery.appendChild(recoveryHeading);
          const recoveryDetail = document.createElement("p");
          recoveryDetail.textContent = "Use only when the existing owner has lost access to every enrolled device. Recovery links a replacement device to that same person; it does not create a new owner.";
          recovery.appendChild(recoveryDetail);
          const recoveryConfirmLabel = document.createElement("label");
          const recoveryConfirm = document.createElement("input");
          recoveryConfirm.type = "checkbox";
          recoveryConfirm.className = "owner-recovery-confirm";
          recoveryConfirmLabel.appendChild(recoveryConfirm);
          recoveryConfirmLabel.appendChild(document.createTextNode(" I confirm the owner cannot use any enrolled device."));
          recovery.appendChild(recoveryConfirmLabel);
          const recoveryButton = document.createElement("button");
          recoveryButton.textContent = "Issue owner recovery code";
          recoveryButton.dataset.ownerCode = vault.vaultId;
          recoveryButton.dataset.ownerCodePurpose = "owner-recovery";
          recoveryButton.disabled = true;
          recovery.appendChild(recoveryButton);
          const recoveryResult = document.createElement("div");
          recoveryResult.className = "owner-code-result action-status";
          recovery.appendChild(recoveryResult);
          card.appendChild(recovery);
        }

        if (memberships.length === 0) {
          const renameRow = document.createElement("div");
          renameRow.className = "row";
          const renameInput = document.createElement("input");
          renameInput.className = "rename-input";
          renameInput.value = vault.name;
          renameInput.setAttribute("aria-label", "Vault nickname");
          const renameBtn = document.createElement("button");
          renameBtn.textContent = "Rename";
          renameBtn.dataset.rename = vault.vaultId;
          renameRow.appendChild(renameInput);
          renameRow.appendChild(renameBtn);
          card.appendChild(renameRow);
        }

        const list = document.createElement("ul");
        if (devices.length === 0) {
          const empty = document.createElement("li");
          empty.textContent = "No devices enrolled yet.";
          list.appendChild(empty);
        } else {
          for (const d of devices) {
            const item = document.createElement("li");
            item.appendChild(document.createTextNode(d.name + " "));
            const deviceCode = document.createElement("code");
            deviceCode.textContent = d.deviceId.slice(0, 8);
            item.appendChild(deviceCode);
            if (typeof d.lastSeenAt === "number") {
              item.appendChild(document.createTextNode(" last seen " + formatWhen(d.lastSeenAt)));
            }
            item.appendChild(document.createTextNode(" "));
            if (!d.principalId) {
              const kickBtn = document.createElement("button");
              kickBtn.textContent = "Kick";
              kickBtn.dataset.kick = d.deviceId;
              item.appendChild(kickBtn);
            }
            list.appendChild(item);
          }
        }
        card.appendChild(list);

        if (memberships.length > 0) {
          const collaborationHint = document.createElement("p");
          collaborationHint.textContent = "Vault membership and personal device links are managed by enrolled participants in YAOS Settings. The operator can only bootstrap or recover the owner.";
          card.appendChild(collaborationHint);
        }

        if (vault.state === "active" && memberships.length === 0 && !needsMigration) {
          const codesHeading = document.createElement("p");
          codesHeading.textContent = "Unused legacy pairing codes";
          card.appendChild(codesHeading);
          const codeList = document.createElement("ul");
          const codes = (data.pairingCodes || []).filter((c) => c.vaultId === vault.vaultId);
          if (codes.length === 0) {
            const emptyCode = document.createElement("li");
            emptyCode.textContent = "None.";
            codeList.appendChild(emptyCode);
          } else {
            for (const c of codes) {
              const item = document.createElement("li");
              const purposeLabel = c.purpose === "invite" ? "Invite" : "Add-device";
              const expiry = formatWhen(c.exp) || "unknown";
              item.appendChild(document.createTextNode(purposeLabel + " · expires " + expiry + " "));
              if (c.codeId) {
                const revokeBtn = document.createElement("button");
                revokeBtn.textContent = "Revoke";
                revokeBtn.dataset.revoke = c.codeId;
                item.appendChild(revokeBtn);
              }
              codeList.appendChild(item);
            }
          }
          card.appendChild(codeList);

        }

        const ownerDestroyRequest = (data.vaultGovernanceRequests || []).find((request) =>
          request.vaultId === vault.vaultId
          && request.kind !== "vault-rename"
          && (request.state === "awaiting-operator-confirmation" || request.state === "confirmed"));
        if (ownerDestroyRequest) {
          const destroyHint = document.createElement("p");
          destroyHint.className = "danger";
          destroyHint.textContent = ownerDestroyRequest.kind === "vault-destroy"
            ? "The vault owner requested permanent destruction. Type the nickname to independently confirm the purge."
            : "An audited emergency destruction override is prepared. Type the nickname to execute the purge.";
          card.appendChild(destroyHint);
          const destroyRow = document.createElement("div");
          destroyRow.className = "row";
          const destroyInput = document.createElement("input");
          destroyInput.className = "destroy-confirm";
          destroyInput.setAttribute("aria-label", "Type vault nickname to confirm owner destruction request");
          destroyInput.placeholder = "Type " + vault.name + " to confirm";
          const destroyBtn = document.createElement("button");
          destroyBtn.textContent = "Confirm owner request";
          destroyBtn.dataset.destroy = vault.vaultId;
          destroyBtn.dataset.governanceRequestId = ownerDestroyRequest.governanceRequestId;
          destroyBtn.disabled = true;
          destroyRow.appendChild(destroyInput);
          destroyRow.appendChild(destroyBtn);
          card.appendChild(destroyRow);
        } else {
          const emergency = document.createElement("section");
          emergency.className = "collaboration-action";
          const emergencyHeading = document.createElement("h3");
          emergencyHeading.textContent = "Emergency destruction repair";
          emergency.appendChild(emergencyHeading);
          const emergencyDetail = document.createElement("p");
          emergencyDetail.textContent = "No owner request is pending. This explicit override is only for an unrecoverable vault; its reason is durably recorded.";
          emergency.appendChild(emergencyDetail);
          const emergencyReason = document.createElement("input");
          emergencyReason.className = "emergency-destroy-reason";
          emergencyReason.placeholder = "Required repair reason";
          emergencyReason.maxLength = 512;
          emergency.appendChild(emergencyReason);
          const emergencyBtn = document.createElement("button");
          emergencyBtn.textContent = "Emergency destroy";
          emergencyBtn.dataset.emergencyDestroy = vault.vaultId;
          emergency.appendChild(emergencyBtn);
          card.appendChild(emergency);
        }

        rendered.appendChild(card);
      }
      for (const pending of data.pendingDeviceRevocations || []) {
        const card = document.createElement("div");
        card.className = "card";

        const heading = document.createElement("h2");
        heading.textContent = "Device revocation pending";
        card.appendChild(heading);

        const identity = document.createElement("p");
        identity.appendChild(document.createTextNode("Device "));
        const deviceCode = document.createElement("code");
        deviceCode.textContent = pending.deviceId;
        identity.appendChild(deviceCode);
        identity.appendChild(document.createTextNode(" · vault "));
        const vaultCode = document.createElement("code");
        vaultCode.textContent = pending.vaultId;
        identity.appendChild(vaultCode);
        card.appendChild(identity);

        const requested = document.createElement("p");
        requested.textContent = "Membership removed · runtime fence requested " +
          (formatWhen(pending.requestedAt) || "unknown");
        card.appendChild(requested);
        if (pending.lastError) {
          const lastError = document.createElement("p");
          lastError.className = "err";
          lastError.textContent = pending.lastError;
          card.appendChild(lastError);
        }
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "Retry device fence";
        retryBtn.dataset.retryRevocation = pending.deviceId;
        card.appendChild(retryBtn);
        rendered.appendChild(card);
      }
      for (const pending of data.pendingDestroys || []) {
        const card = document.createElement("div");
        card.className = "card";

        const heading = document.createElement("h2");
        heading.textContent = "Vault cleanup pending";
        card.appendChild(heading);

        const idLine = document.createElement("p");
        idLine.appendChild(document.createTextNode("Vault "));
        const idCode = document.createElement("code");
        idCode.textContent = pending.vaultId;
        idLine.appendChild(idCode);
        card.appendChild(idLine);

        const cleanupState = document.createElement("p");
        cleanupState.textContent =
          "Room: " + (pending.roomComplete ? "complete" : "pending") +
          " · R2: " + (pending.r2Complete ? "complete" : "pending") +
          " · requested " + (formatWhen(pending.requestedAt) || "unknown");
        card.appendChild(cleanupState);

        if (pending.lastError) {
          const lastError = document.createElement("p");
          lastError.className = "err";
          lastError.textContent = pending.lastError;
          card.appendChild(lastError);
        }

        const retryBtn = document.createElement("button");
        retryBtn.textContent = "Retry cleanup";
        retryBtn.dataset.retryDestroy = pending.vaultId;
        const executingGovernance = (data.vaultGovernanceRequests || []).find((request) =>
          request.vaultId === pending.vaultId && request.state === "executing");
        if (executingGovernance) retryBtn.dataset.governanceRequestId = executingGovernance.governanceRequestId;
        else retryBtn.disabled = true;
        card.appendChild(retryBtn);
        rendered.appendChild(card);
      }
      for (const change of (data.authorizationChanges || []).filter((record) =>
        record.state !== "complete" && record.kind !== "authority-install")) {
        const card = document.createElement("div");
        card.className = "card";
        const heading = document.createElement("h2");
        heading.textContent = "Authorization fence repair";
        card.appendChild(heading);
        const detail = document.createElement("p");
        detail.textContent = change.kind + " · " + change.state + " · " + change.changeId;
        card.appendChild(detail);
        if (change.lastError) {
          const error = document.createElement("p");
          error.className = "err";
          error.textContent = change.lastError;
          card.appendChild(error);
        }
        const retry = document.createElement("button");
        retry.textContent = "Retry authority fence";
        retry.dataset.retryAuthorization = change.changeId;
        retry.dataset.vaultId = change.vaultId;
        card.appendChild(retry);
        rendered.appendChild(card);
      }
      root.replaceChildren(rendered);
      createVault.disabled = false;
      if (!preserveStatus) status.textContent = "";
    }
    createVault.addEventListener("click", async () => {
      const name = document.getElementById("vault-name").value.trim();
      createVault.disabled = true;
      status.textContent = "Creating and provisioning vault…";
      let res;
      try {
        res = await fetch("/operator/vaults", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      } catch {
        status.textContent = "Could not reach the server to create the vault. Reload to inspect whether provisioning started.";
        createVault.disabled = false;
        return;
      }
      const created = await res.json().catch(() => null);
      if (!res.ok) { status.textContent = actionError(created, "Could not create vault."); createVault.disabled = false; return; }
      const vaultId = created && created.vault && created.vault.vaultId;
      await load();
      if (vaultId) {
        const card = Array.from(document.querySelectorAll("#vaults .card")).find((c) => c.dataset.vaultId === vaultId);
        const button = card && card.querySelector('[data-owner-code-purpose="owner-bootstrap"]');
        const slot = card && card.querySelector(".owner-code-result");
        if (button && slot) await requestOwnerCode(vaultId, "owner-bootstrap", button, slot);
        else status.textContent = "Vault created. Review its provisioning state below.";
      }
    });
    document.getElementById("save-update").addEventListener("click", async () => {
      const updateRepoUrl = document.getElementById("update-repo").value.trim();
      const updateRepoBranch = document.getElementById("update-branch").value.trim();
      let updateProvider = "unknown";
      try {
        const host = new URL(updateRepoUrl).hostname;
        if (host === "github.com" || host.endsWith(".github.com")) updateProvider = "github";
        else if (host === "gitlab.com" || host.endsWith(".gitlab.com")) updateProvider = "gitlab";
      } catch {}
      const res = await fetch("/api/update-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateRepoUrl, updateRepoBranch, updateProvider }),
      });
      if (!res.ok) { status.textContent = "Could not save updater settings."; return; }
      status.textContent = "";
    });
    document.getElementById("logout").addEventListener("click", async () => {
      await fetch("/operator/logout", { method: "POST" });
      window.location.reload();
    });
    document.getElementById("vaults").addEventListener("input", (event) => {
      const input = event.target;
      if (!input || !input.classList) return;
      const card = input.closest(".card");
      if (input.classList.contains("destroy-confirm")) {
        const btn = card && card.querySelector("[data-destroy]");
        if (btn) btn.disabled = input.value !== (card.dataset.vaultName || "");
      }
      if (input.classList.contains("owner-recovery-confirm")) {
        const btn = card && card.querySelector('[data-owner-code-purpose="owner-recovery"]');
        if (btn && btn.dataset.pending !== "true") btn.disabled = !input.checked;
      }
      if (input.classList.contains("owner-display-name")
        || input.classList.contains("migration-owner-device")
        || input.classList.contains("migration-confirm")) updateMigrationButton(card);
    });
    document.getElementById("vaults").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.getAttribute) return;
      const kick = target.getAttribute("data-kick");
      const rename = target.getAttribute("data-rename");
      const destroy = target.getAttribute("data-destroy");
      const emergencyDestroy = target.getAttribute("data-emergency-destroy");
      const retryDestroy = target.getAttribute("data-retry-destroy");
      const retryAuthorization = target.getAttribute("data-retry-authorization");
      const retryProvision = target.getAttribute("data-retry-provision");
      const revoke = target.getAttribute("data-revoke");
      const retryRevocation = target.getAttribute("data-retry-revocation");
      const ownerCode = target.getAttribute("data-owner-code");
      const ownerCodePurpose = target.getAttribute("data-owner-code-purpose");
      const collaborationMigrate = target.getAttribute("data-collaboration-migrate");
      if (ownerCode && ownerCodePurpose) {
        const card = target.closest(".card");
        const slot = target.closest(".collaboration-action").querySelector(".owner-code-result");
        if (ownerCodePurpose === "owner-recovery") {
          const confirmation = card && card.querySelector(".owner-recovery-confirm");
          if (!confirmation || !confirmation.checked) return;
        }
        await requestOwnerCode(ownerCode, ownerCodePurpose, target, slot);
        return;
      }
      if (collaborationMigrate) {
        const card = target.closest(".card");
        const action = target.closest(".migration-action");
        const migrationStatus = action && action.querySelector(".migration-status");
        const ownerDisplayNameInput = action && action.querySelector(".owner-display-name");
        const confirmation = action && action.querySelector(".migration-confirm");
        const ownerDeviceIds = action
          ? Array.from(action.querySelectorAll(".migration-owner-device:checked")).map((input) => input.value)
          : [];
        const ownerDisplayName = ownerDisplayNameInput ? ownerDisplayNameInput.value.trim() : "";
        if (!migrationStatus || !confirmation || !confirmation.checked || !ownerDisplayName || ownerDeviceIds.length === 0) return;
        target.disabled = true;
        target.dataset.pending = "true";
        for (const input of action.querySelectorAll("input")) input.disabled = true;
        migrationStatus.classList.remove("err");
        migrationStatus.textContent = "Installing collaboration identities and vault authority. Do not repeat this action…";
        let migrationResponse;
        try {
          migrationResponse = await fetch("/operator/vaults/" + encodeURIComponent(collaborationMigrate) + "/collaboration-migrate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerDeviceIds, ownerDisplayName }),
          });
        } catch {
          status.textContent = "The migration response was lost. Its durable state is shown below; confirm and retry only if it is marked incomplete.";
          await load(true);
          return;
        }
        const migrationData = await migrationResponse.json().catch(() => null);
        if (!migrationResponse.ok) {
          if (migrationData && migrationData.repairable) {
            status.textContent = actionError(migrationData,
              "Migration did not finish, but its prepared authority change is repairable. Review the locked grouping below and retry it.");
            await load(true);
            return;
          }
          migrationStatus.classList.add("err");
          migrationStatus.textContent = actionError(migrationData, "Could not migrate collaboration identities.");
          target.dataset.pending = "false";
          for (const input of action.querySelectorAll("input")) {
            input.disabled = action.dataset.locked === "true" && !input.classList.contains("migration-confirm");
          }
          updateMigrationButton(card);
          return;
        }
        status.textContent = "Collaboration migration completed. Historical work remains unattributed; every device now belongs to a person.";
        await load(true);
        return;
      }
      if (retryRevocation) {
        const res = await fetch("/operator/devices/" + encodeURIComponent(retryRevocation), { method: "DELETE" });
        status.textContent = res.status === 202
          ? "Membership is removed, but the vault runtime fence is still pending."
          : res.ok ? "" : "Could not retry the device runtime fence.";
        await load(true);
        return;
      }
      if (retryProvision) {
        const res = await fetch("/operator/vaults/" + encodeURIComponent(retryProvision) + "/provision", { method: "POST" });
        if (!res.ok) { status.textContent = "Could not provision vault."; return; }
        status.textContent = "";
        await load();
        return;
      }
      if (retryDestroy) {
        const governanceRequestId = target.getAttribute("data-governance-request-id");
        if (governanceRequestId) await requestVaultDestroy(retryDestroy, governanceRequestId);
        return;
      }
      if (retryAuthorization) {
        const vaultId = target.getAttribute("data-vault-id");
        if (!vaultId) return;
        const res = await fetch("/operator/vaults/" + encodeURIComponent(vaultId)
          + "/authorization-changes/" + encodeURIComponent(retryAuthorization) + "/retry", { method: "POST" });
        status.textContent = res.status === 202 ? "Authorization fence is still pending." : res.ok ? "Authorization fence completed." : "Could not retry authorization fence.";
        await load(true);
        return;
      }
      if (kick) {
        const res = await fetch("/operator/devices/" + encodeURIComponent(kick), { method: "DELETE" });
        status.textContent = res.status === 202
          ? "Membership is removed, but the vault runtime fence is pending."
          : res.ok ? "" : "Could not revoke device membership.";
        await load(true);
        return;
      }
      if (rename) {
        const card = target.closest(".card");
        const input = card && card.querySelector(".rename-input");
        const name = input ? input.value.trim() : "";
        const res = await fetch("/operator/vaults/" + encodeURIComponent(rename), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) { status.textContent = "Could not rename vault."; return; }
        status.textContent = "";
        await load();
        return;
      }
      if (destroy) {
        const card = target.closest(".card");
        const input = card && card.querySelector(".destroy-confirm");
        const expected = card ? (card.dataset.vaultName || "") : "";
        if (!input || input.value !== expected) return;
        const governanceRequestId = target.getAttribute("data-governance-request-id");
        if (!governanceRequestId) return;
        await requestVaultDestroy(destroy, governanceRequestId);
        return;
      }
      if (emergencyDestroy) {
        const card = target.closest(".card");
        const reasonInput = card && card.querySelector(".emergency-destroy-reason");
        const reason = reasonInput ? reasonInput.value.trim() : "";
        if (reason.length < 8) { status.textContent = "Enter a specific emergency repair reason (at least 8 characters)."; return; }
        await requestEmergencyVaultDestroy(emergencyDestroy, reason);
        return;
      }
      if (revoke) {
        const res = await fetch("/operator/pairing-codes/" + encodeURIComponent(revoke), { method: "DELETE" });
        if (!res.ok) { status.textContent = "Could not revoke pairing code."; return; }
        status.textContent = "";
        await load();
        return;
      }
    });
    load();
  </script>
</body>
</html>`;
}
