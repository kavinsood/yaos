#!/usr/bin/env node
/**
 * Minimal s01 runner — connects to already-running Obsidian and runs the scenario.
 * Does NOT reload plugins (reload puts plugin into cold-sync state, lengthening waits).
 */
import WebSocket from "ws";

async function cdpConnect(port = 9222) {
  const res = await fetch(`http://localhost:${port}/json/list`);
  const targets = await res.json();
  const t = targets.find((t) => t.type === "page" && t.title.includes("Obsidian") && !t.title.includes("DevTools"));
  if (!t) throw new Error("No Obsidian page found on port " + port);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on("open", r));
  function eval_(expr, ms = 150000) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${ms}ms`)); }, ms);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
        else resolve(m.result?.result?.value);
      });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  }
  return { eval_, close: () => ws.close() };
}

async function main() {
  const { eval_, close } = await cdpConnect();
  console.log("Running s01 single-device-basic-edit...");
  const result = await eval_(
    `(async () => {
      const qa = window.__YAOS_QA__;
      if (!qa) throw new Error('__YAOS_QA__ not found');
      return qa.run('single-device-basic-edit', { timeoutMs: 120000 });
    })()`,
    130000
  );
  console.log(JSON.stringify(result, null, 2));
  close();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
