interface SetupPageOptions {
	host: string;
}

interface RunningPageOptions {
	host: string;
	authMode: "env" | "claim";
	attachments: boolean;
	snapshots: boolean;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const IS_MARKETPLACE_APPROVED = false;
const DEPLOY_REPO = "kavinsood/yaos";

export function renderSetupPage(options: SetupPageOptions): string {
	const safeHost = escapeHtml(options.host);
	const releaseZipUrl = "https://github.com/kavinsood/yaos/releases/latest/download/yaos.zip";
	const installationStep = IS_MARKETPLACE_APPROVED
		? `<div class="step">
              <strong>Step 1: Install YAOS plugin</strong>
              In Obsidian, open <em>Settings → Community plugins</em>, search for <strong>YAOS</strong>, install it, and make sure it is <strong>enabled</strong>.
            </div>`
		: `<div class="step">
              <strong>Step 1: Install YAOS plugin (beta via BRAT)</strong>
              <ol>
                <li>In Obsidian, open <em>Settings → Community plugins</em> and install <strong>BRAT</strong>.</li>
                <li>Open BRAT settings, select <em>Add beta plugin</em>, then paste <code>${DEPLOY_REPO}</code>.</li>
                <li>Go back to Community plugins and make sure <strong>YAOS</strong> is installed and <strong>enabled</strong>.</li>
              </ol>
              <p class="micro-left">Prefer manual installation? <a href="${releaseZipUrl}">Download the zip here</a>.</p>
            </div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claim YAOS server</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at 20% 20%, rgba(123, 223, 246, 0.16), transparent 38%),
        radial-gradient(circle at 80% 0%, rgba(255, 197, 90, 0.14), transparent 30%),
        linear-gradient(180deg, #08111d 0%, #0d1725 52%, #08111d 100%);
      color: #f4f7fb;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      overflow-x: hidden;
    }
    .card {
      width: min(760px, 100%);
      background: rgba(8, 17, 29, 0.92);
      border: 1px solid rgba(161, 205, 255, 0.22);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(115deg, transparent 28%, rgba(123, 223, 246, 0.12) 48%, transparent 68%);
      transform: translateX(-120%);
      opacity: 0;
      pointer-events: none;
    }
    .card.claimed::before {
      animation: sweep 1.1s ease forwards;
    }
    h1 { margin: 0 0 12px; font-size: 32px; }
    p { margin: 0 0 14px; line-height: 1.5; color: #d9e6f4; }
    .hint { font-size: 13px; color: #a9c0d8; }
    .hero {
      display: grid;
      gap: 10px;
      margin-bottom: 8px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: fit-content;
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(123, 223, 246, 0.1);
      border: 1px solid rgba(123, 223, 246, 0.18);
      color: #bdeffd;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #7bdff6;
      box-shadow: 0 0 16px rgba(123, 223, 246, 0.55);
    }
    button, a.cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: #7bdff6;
      color: #08111d;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
    }
    button:hover, a.cta:hover {
      transform: translateY(-1px);
      box-shadow: 0 12px 26px rgba(123, 223, 246, 0.18);
    }
    button[disabled] { opacity: 0.6; cursor: wait; }
    .stack { display: grid; gap: 12px; margin-top: 18px; }
    .panel {
      display: none;
      background: linear-gradient(180deg, rgba(123, 223, 246, 0.08), rgba(123, 223, 246, 0.03));
      border: 1px solid rgba(123, 223, 246, 0.18);
      border-radius: 18px;
      padding: 18px;
      opacity: 0;
      transform: translateY(14px) scale(0.98);
    }
    .panel.show {
      display: block;
      animation: rise-in 420ms cubic-bezier(.2, .9, .2, 1) forwards;
    }
    code, textarea {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid rgba(161, 205, 255, 0.22);
      background: rgba(4, 10, 18, 0.9);
      color: #f4f7fb;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 12px;
      padding: 10px;
    }
    textarea { min-height: 78px; resize: vertical; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .hero-actions {
      margin-top: 6px;
    }
    .ghost {
      background: transparent;
      color: #d9e6f4;
      border: 1px solid rgba(161, 205, 255, 0.22);
    }
    .ghost:hover {
      box-shadow: none;
      border-color: rgba(161, 205, 255, 0.36);
    }
    #status { min-height: 22px; color: #ffd8a8; margin-top: 8px; }
    .success-layout {
      display: grid;
      gap: 18px;
      align-items: start;
    }
    .success-header {
      display: grid;
      gap: 8px;
    }
    .success-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(136, 255, 184, 0.1);
      border: 1px solid rgba(136, 255, 184, 0.22);
      color: #c8ffd9;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .success-badge::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #88ffb8;
      box-shadow: 0 0 18px rgba(136, 255, 184, 0.45);
      animation: pulse 1.8s ease-in-out infinite;
    }
    .success-grid {
      display: grid;
      gap: 18px;
    }
    .qr-wrap {
      display: grid;
      gap: 12px;
      justify-items: center;
      padding: 18px;
      border-radius: 18px;
      background: rgba(4, 10, 18, 0.55);
      border: 1px solid rgba(161, 205, 255, 0.12);
    }
    #qr {
      display: grid;
      place-items: center;
      width: 220px;
      min-height: 220px;
      padding: 12px;
      border-radius: 18px;
      background: #f4f7fb;
      box-sizing: border-box;
    }
    #qr canvas {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 10px;
    }
    .micro {
      margin: 0;
      font-size: 12px;
      color: #a9c0d8;
      text-align: center;
    }
    .done {
      display: none;
      border-radius: 14px;
      padding: 12px 14px;
      background: rgba(136, 255, 184, 0.1);
      border: 1px solid rgba(136, 255, 184, 0.24);
      color: #c8ffd9;
    }
    .done.show {
      display: block;
    }
    .steps {
      display: grid;
      gap: 10px;
    }
    .step {
      border-radius: 14px;
      padding: 12px 14px;
      background: rgba(4, 10, 18, 0.55);
      border: 1px solid rgba(161, 205, 255, 0.12);
    }
    .step strong {
      display: block;
      margin-bottom: 4px;
      color: #f4f7fb;
      font-size: 13px;
    }
    .step ol {
      margin: 0;
      padding-left: 18px;
      color: #d9e6f4;
      line-height: 1.45;
    }
    .step li + li {
      margin-top: 6px;
    }
    .micro-left {
      margin: 10px 0 0;
      font-size: 12px;
      color: #a9c0d8;
    }
    .micro-left a {
      color: #bdeffd;
    }
    .ack {
      border-radius: 14px;
      padding: 12px 14px;
      border: 1px solid rgba(161, 205, 255, 0.2);
      background: rgba(4, 10, 18, 0.45);
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .ack input[type="checkbox"] {
      margin-top: 2px;
    }
    .step2 {
      border-radius: 14px;
      padding: 12px;
      border: 1px solid rgba(161, 205, 255, 0.2);
      background: rgba(4, 10, 18, 0.45);
      opacity: 1;
      transition: opacity 120ms ease;
    }
    .step2.disabled {
      opacity: 0.45;
    }
    .step2.disabled .cta,
    .step2.disabled button,
    .step2.disabled textarea {
      pointer-events: none;
    }
    .warning {
      margin: 0;
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255, 216, 168, 0.12);
      border: 1px solid rgba(255, 216, 168, 0.35);
      color: #ffd8a8;
      font-size: 12px;
      line-height: 1.4;
    }
    @media (min-width: 780px) {
      .success-grid {
        grid-template-columns: minmax(0, 1.3fr) minmax(220px, 0.7fr);
      }
    }
    @media (max-width: 779px) {
      h1 { font-size: 28px; }
      .card { padding: 22px; border-radius: 20px; }
      #qr {
        width: min(220px, 100%);
        min-height: 0;
      }
    }
    @keyframes rise-in {
      from { opacity: 0; transform: translateY(14px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.75; }
    }
    @keyframes sweep {
      0% { transform: translateX(-120%); opacity: 0; }
      20% { opacity: 1; }
      100% { transform: translateX(120%); opacity: 0; }
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="hero">
      <div class="eyebrow">One-time setup</div>
      <h1 id="hero-title">Claim your YAOS server</h1>
      <p id="hero-copy">This Worker is ready for markdown sync. Claim it once, then connect Obsidian with a one-tap setup link.</p>
      <p class="hint">Server: ${safeHost}</p>
    </section>
    <div id="status" aria-live="polite"></div>
    <div class="row hero-actions">
      <button id="claim">Claim server</button>
    </div>
    <div id="success" class="panel stack">
      <div class="success-layout">
        <div class="success-header">
          <div class="success-badge">Server claimed</div>
          <p><strong>Keep this page open.</strong> Your server is ready, but Obsidian still needs to be linked.</p>
          <p class="warning"><strong>⚠️ Save this deep link or token now.</strong> This page will lock permanently when you leave.</p>
        </div>
        <div class="success-grid">
          <div class="stack">
            <div class="steps">
              ${installationStep}
            </div>
            <label class="ack">
              <input id="installed" type="checkbox" />
              <span>I have installed and <strong>enabled</strong> the YAOS plugin in Obsidian.</span>
            </label>
            <div id="step2" class="step2 disabled">
              <div class="step">
                <strong>Step 2: Connect your vault</strong>
                Use <em>Auto-configure Obsidian</em> on this device, or scan the QR on another device.
              </div>
              <div class="row">
                <a id="open" class="cta" href="#" aria-disabled="true">Auto-configure Obsidian</a>
                <button id="mark-ready" class="ghost" type="button">I scanned it</button>
              </div>
              <label>
                <span class="hint">Token</span>
                <textarea id="token" readonly></textarea>
              </label>
              <label>
                <span class="hint">Obsidian setup link</span>
                <textarea id="pair" readonly></textarea>
              </label>
              <div class="row">
                <button id="copy-token" class="ghost" type="button">Copy token</button>
                <button id="copy-link" class="ghost" type="button">Copy link</button>
              </div>
            </div>
            <div id="done" class="done" aria-live="polite"></div>
          </div>
          <div class="qr-wrap">
            <div id="qr" aria-label="YAOS setup QR code"></div>
            <p class="micro">Scan this on another device to open the same YAOS setup link in Obsidian.</p>
          </div>
        </div>
      </div>
    </div>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"></script>
  <script>
    const cardEl = document.querySelector(".card");
    const claimButton = document.getElementById("claim");
    const statusEl = document.getElementById("status");
    const successEl = document.getElementById("success");
    const heroTitleEl = document.getElementById("hero-title");
    const heroCopyEl = document.getElementById("hero-copy");
    const tokenEl = document.getElementById("token");
    const pairEl = document.getElementById("pair");
    const openEl = document.getElementById("open");
    const markReadyEl = document.getElementById("mark-ready");
    const installedEl = document.getElementById("installed");
    const step2El = document.getElementById("step2");
    const copyTokenEl = document.getElementById("copy-token");
    const copyLinkEl = document.getElementById("copy-link");
    const qrEl = document.getElementById("qr");
    const doneEl = document.getElementById("done");

    function randomToken() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function copy(text) {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "Copied to clipboard.";
    }

    function renderQr(text) {
      if (!text || !qrEl || !window.QRious) {
        return;
      }
      qrEl.textContent = "";
      const canvas = document.createElement("canvas");
      qrEl.appendChild(canvas);
      new window.QRious({
        element: canvas,
        value: text,
        size: 196,
        level: "M",
        foreground: "#08111d",
        background: "#f4f7fb",
      });
    }

    function showReadyState(message) {
      heroTitleEl.textContent = "YAOS is ready";
      heroCopyEl.textContent = "Server claimed and running. You can close this tab.";
      doneEl.textContent = message;
      doneEl.classList.add("show");
      statusEl.textContent = "YAOS is ready. You can close this tab.";
    }

    function setStep2Enabled(enabled) {
      step2El.classList.toggle("disabled", !enabled);
      openEl.setAttribute("aria-disabled", String(!enabled));
      if (!enabled) {
        openEl.removeAttribute("href");
      } else if (pairEl.value) {
        openEl.href = pairEl.value;
      }
    }

    claimButton.addEventListener("click", async () => {
      claimButton.disabled = true;
      statusEl.textContent = "Claiming server...";
      const token = randomToken();

      try {
        const res = await fetch("/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data && data.error ? data.error : "claim failed");
        }

        tokenEl.value = token;
        pairEl.value = data.obsidianUrl || "";
        setStep2Enabled(Boolean(installedEl.checked));
        successEl.classList.add("show");
        cardEl.classList.add("claimed");
        claimButton.closest(".hero-actions").style.display = "none";
        renderQr(data.obsidianUrl || "");
        statusEl.textContent = "Server claimed. Complete Step 1, then continue with Step 2 to link Obsidian.";
      } catch (error) {
        statusEl.textContent = "Claim failed: " + (error && error.message ? error.message : String(error));
        claimButton.disabled = false;
      }
    });
    installedEl.addEventListener("change", () => {
      setStep2Enabled(installedEl.checked);
    });
    copyTokenEl.addEventListener("click", () => copy(tokenEl.value));
    copyLinkEl.addEventListener("click", () => copy(pairEl.value));
    openEl.addEventListener("click", () => {
      if (!installedEl.checked) return;
      showReadyState("Obsidian should open now. If it did, you can close this tab.");
    });
    markReadyEl.addEventListener("click", () => {
      showReadyState("This server is paired. You can close this tab whenever you're done.");
    });
  </script>
</body>
</html>`;
}

export function renderRunningPage(options: RunningPageOptions): string {
	const safeHost = escapeHtml(options.host);
	const authLabel = options.authMode === "env"
		? "This deployment is locked by an environment token."
		: "This deployment has already been claimed.";
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YAOS server</title>
  <style>
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #09111b;
      color: #eef5fb;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: #101b29;
      border: 1px solid #23384f;
      border-radius: 18px;
      padding: 24px;
    }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { margin: 0 0 10px; line-height: 1.5; }
    ul { margin: 14px 0 0; padding-left: 18px; color: #c8d8e8; }
    code { color: #9fe3f6; }
  </style>
</head>
<body>
  <main class="card">
    <h1>YAOS server is running</h1>
    <p>${authLabel}</p>
    <p>Host: <code>${safeHost}</code></p>
    <ul>
      <li>Attachments: ${options.attachments ? "enabled" : "disabled"}</li>
      <li>Snapshots: ${options.snapshots ? "enabled" : "disabled"}</li>
    </ul>
  </main>
</body>
</html>`;
}
