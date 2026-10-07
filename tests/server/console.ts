// Operator console (`GET /`) and `GET /mobile-setup` (DECISIONS D5) against §2.2, D7, D8a and D8b: headers and CSP, no
// external asset, the routes and bodies the inline JS sends, a mapped message for every documented error code, and
// secret handling (no log, no web storage, no secret in a request URL). The inline scripts run in node:vm against a
// small fake DOM and a scripted fetch.
import assert from "node:assert/strict";
import vm from "node:vm";

import QRCODE_SCRIPT from "qrcode-generator/dist/qrcode.js";

import { CONSOLE_MESSAGES, consolePage } from "../../server/src/console/console";
import { mobileSetupPage } from "../../server/src/console/mobileSetup";
import { buildMobileSetupUrl } from "../../server/src/setupQr";
import { suite } from "../harness.ts";

const s = suite("console");

const ORIGIN = "https://yaos.test";
const VAULT_ID = "AbCdEfGhIjKlMnOpQrStUv";
const DEVICE_ID = "device-0001-abcdef";
const CODE = `${VAULT_ID}.${"s".repeat(32)}`;

/** §2.2 rows the console may call: discovery plus the D5 operator list (`:id` is any path parameter). */
const ROUTES = [
	"GET /api/capabilities", "POST /claim", "POST /operator/login", "POST /operator/logout", "GET /operator/state",
	"POST /operator/vaults", "POST /operator/vaults/:id/owner-code", "DELETE /operator/vaults/:id",
	"GET /operator/vaults/:id/devices", "DELETE /operator/vaults/:id/devices/:id", "POST /operator/vaults/:id/reset-streams",
	"POST /operator/vaults/:id/restore",
];
/** Error codes the operator routes document: §5 row 2.2, §2.2, D3 (limiter), D5, D8a, D8b, G8. */
const DOCUMENTED_CODES = [
	"already_claimed", "unauthorized", "too_many_attempts", "confirmation_mismatch", "purge_incomplete",
	"restore_in_progress", "restore_incomplete", "invalid_restore_point", "restore_unsupported", "cf_daily_limit",
	"not_found", "body_too_large", "internal_error",
];

// ---- fake DOM and page runner ---------------------------------------------------

type Kid = FakeElement | string;
class FakeElement {
	readonly children: Kid[] = [];
	hidden = false; disabled = false; checked = false; readOnly = false;
	value = ""; className = ""; href = ""; src = ""; alt = ""; placeholder = "";
	onclick?: () => unknown; onchange?: () => unknown; oninput?: () => unknown;
	onsubmit?: (event: { preventDefault(): void }) => unknown;
	private text = "";
	constructor(readonly tagName: string) {}
	get textContent(): string { return this.text + this.children.map((k) => typeof k === "string" ? k : k.textContent).join(""); }
	set textContent(value: string) { this.children.length = 0; this.text = String(value); }
	append(...kids: Kid[]): void { this.children.push(...kids); }
	replaceChildren(...kids: Kid[]): void { this.textContent = ""; this.append(...kids); }
	*walk(): Generator<FakeElement> { yield this; for (const k of this.children) if (typeof k !== "string") yield* k.walk(); }
	find(tag: string, test: (el: FakeElement) => boolean = () => true): FakeElement {
		const found = [...this.walk()].find((el) => el.tagName === tag && test(el));
		assert.ok(found, `no <${tag}> matching in ${this.textContent.slice(0, 80)}`);
		return found;
	}
	button(text: string): FakeElement { return this.find("button", (el) => el.textContent === text); }
	/** The element whose direct children include the button `text` (a `.row`). */
	rowOf(text: string): FakeElement {
		return this.find("div", (el) => el.children.some((k) => typeof k !== "string" && k.tagName === "button" && k.textContent === text));
	}
}

interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }
type Reply = [number, unknown] | "network";

class Page {
	readonly calls: Call[] = [];
	readonly logs: unknown[] = [];
	readonly storage: unknown[] = [];
	readonly confirms: string[] = [];
	readonly replaced: unknown[][] = [];
	readonly replies = new Map<string, Reply>();
	private readonly elements = new Map<string, FakeElement>();

	constructor(readonly html: string, hash = "", pathname = "/") {
		for (const m of html.matchAll(/<(\w+)([^>]*)\sid="([^"]+)"([^>]*)>/g)) {
			const el = new FakeElement(m[1]!);
			const attrs = `${m[2]} ${m[4]}`;
			el.hidden = /\shidden\b/.test(attrs);
			el.disabled = /\sdisabled\b/.test(attrs);
			this.elements.set(m[3]!, el);
		}
		const storage = { setItem: (...a: unknown[]) => this.storage.push(a), getItem: () => null, removeItem: () => undefined };
		const context = vm.createContext({
			document: { getElementById: (id: string) => this.elements.get(id) ?? null, createElement: (tag: string) => new FakeElement(tag) },
			location: { origin: ORIGIN, hash, pathname },
			history: { replaceState: (...a: unknown[]) => this.replaced.push(a) },
			navigator: { clipboard: { writeText: () => Promise.resolve() } },
			crypto: globalThis.crypto, URLSearchParams, setTimeout, btoa,
			confirm: (text: string) => { this.confirms.push(text); return true; },
			console: new Proxy({}, { get: () => (...a: unknown[]) => this.logs.push(a) }),
			localStorage: storage, sessionStorage: storage,
			// Copies keep every recorded value in this realm (deepStrictEqual compares prototypes). The reply is looked up
			// a turn later, so replies set right after construction answer the boot request.
			fetch: (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
				const call = { method: init.method, path, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) };
				this.calls.push(call);
				return new Promise((resolve, reject) => setImmediate(() => {
					const reply = this.replies.get(`${call.method} ${path}`) ?? [404, { error: "not_found" }];
					if (reply === "network") reject(new TypeError("fetch failed"));
					else resolve({ status: reply[0], json: () => Promise.resolve(reply[1]) });
				}));
			},
		});
		for (const script of inlineScripts(html)) vm.runInContext(script, context);
	}

	$(id: string): FakeElement { const el = this.elements.get(id); assert.ok(el, `#${id}`); return el; }
	get msg(): string { return this.$("msg").textContent; }
	visible(): string { return ["claim", "login", "main"].filter((id) => !this.$(id).hidden).join(","); }
	reply(route: string, status: number, body: unknown = {}): void { this.replies.set(route, [status, body]); }
	last(): Call { const call = this.calls.at(-1); assert.ok(call, "a request"); return call; }
	card(): FakeElement { return this.$("vaults").find("section"); }
	async press(el: FakeElement): Promise<void> { assert.equal(el.disabled, false, `${el.textContent} enabled`); el.onclick?.(); await settle(); }
	async type(el: FakeElement, value: string): Promise<void> { el.value = value; el.oninput?.(); await settle(); }
	/** No log line, no web-storage write, no secret in any request URL. */
	assertClean(secrets: string[]): void {
		assert.deepEqual(this.logs, [], "no console output");
		assert.deepEqual(this.storage, [], "no web storage write");
		for (const call of this.calls) for (const secret of secrets) assert.ok(!call.path.includes(secret), `${call.path}: no secret`);
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function inlineScripts(html: string): string[] {
	return [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

/** The page's own script: the console's comes after the QR encoder (O12), the mobile setup page has only its own. */
function inlineScript(html: string): string {
	const scripts = inlineScripts(html);
	assert.equal(scripts.length, html.includes(QRCODE_SCRIPT) ? 2 : 1, "the encoder and the page's own script");
	return scripts.at(-1)!;
}

/**
 * `img` is the setup QR of `code`: an inert SVG data URL whose dark modules (one `M x,y` square each, 4 px cells,
 * margin 4) are those of setupQr.ts's mobile setup URL on ORIGIN at level M, byte mode.
 */
function assertSetupQr(img: FakeElement, code: string): void {
	const prefix = "data:image/svg+xml;base64,";
	assert.ok(img.src.startsWith(prefix), img.src.slice(0, 40));
	assert.equal(img.alt, "Mobile setup QR code");
	const svg = Buffer.from(img.src.slice(prefix.length), "base64").toString("utf8");
	assert.ok(!/<script|<foreignObject|\son[a-z]+=|href/i.test(svg), "inert SVG");
	const context = vm.createContext({});
	vm.runInContext(QRCODE_SCRIPT, context);
	const qr = (context.qrcode as (type: number, level: string) => {
		addData(text: string, mode: string): void; make(): void; getModuleCount(): number; isDark(row: number, col: number): boolean;
	})(0, "M");
	qr.addData(buildMobileSetupUrl(ORIGIN, code), "Byte");
	qr.make();
	const count = qr.getModuleCount();
	const expected: string[] = [];
	for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) expected.push(`${4 + 4 * col},${4 + 4 * row}`);
	assert.ok(svg.includes(` viewBox="0 0 ${8 + 4 * count} ${8 + 4 * count}"`), "module count");
	assert.deepEqual([...svg.matchAll(/M(\d+),(\d+)l/g)].map((m) => `${m[1]},${m[2]}`), expected);
}

async function consoleWith(claimed: boolean, state?: unknown): Promise<Page> {
	const page = new Page(await consolePage().text());
	page.reply("GET /api/capabilities", 200, { claimed, attachments: false, maxBlobUploadBytes: 100000000, serverVersion: "1.0.0", streams: 1 });
	page.reply("GET /operator/state", state === undefined ? 401 : 200, state ?? { error: "unauthorized" });
	await settle();
	return page;
}

const STATE = { vaults: [{ vaultId: VAULT_ID, name: "Notes", createdAt: 1_790_000_000_000 }], pendingRestores: [] };

// ---- static checks ----------------------------------------------------------------

s.test("D5: both pages are 200 HTML with a strict nonce CSP, a fresh nonce each time, and no CORS", async () => {
	for (const [render, connect] of [[consolePage, "'self'"], [mobileSetupPage, "'none'"]] as const) {
		const [a, b] = [render(), render()];
		assert.equal(a.status, 200);
		assert.match(a.headers.get("Content-Type") ?? "", /^text\/html; charset=utf-8$/);
		assert.equal(a.headers.get("Cache-Control"), "no-store");
		assert.equal(a.headers.get("Referrer-Policy"), "no-referrer");
		assert.equal(a.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(a.headers.get("Access-Control-Allow-Origin"), null);
		const csp = a.headers.get("Content-Security-Policy") ?? "";
		const nonce = /'nonce-([A-Za-z0-9_-]{22})'/.exec(csp)?.[1];
		assert.ok(nonce, csp);
		assert.equal(csp, `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; `
			+ `connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
		assert.notEqual(b.headers.get("Content-Security-Policy"), csp, "fresh nonce");
		const html = await a.text();
		const tags = [...html.matchAll(/<(script|style)\b([^>]*)>/g)];
		assert.deepEqual(tags.map((t) => t[1]).sort(), render === consolePage ? ["script", "script", "style"] : ["script", "style"]);
		for (const tag of tags) assert.equal(tag[2], ` nonce="${nonce}"`);
		for (const script of inlineScripts(html)) new vm.Script(script);
	}
});

s.test("D5: no external asset, URL, inline handler or style attribute in either page", async () => {
	// The encoder's own URLs (license comments, the SVG namespace) are checked in the O12 test.
	for (const html of [(await consolePage().text()).replace(QRCODE_SCRIPT, ""), await mobileSetupPage().text()]) {
		const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
		assert.ok(!/https?:|\/\/[\w-]+\.[\w.-]+/i.test(html), "no absolute or protocol-relative URL");
		assert.ok(!/\s(src|href|srcset|action|style|on[a-z]+)\s*=/i.test(markup), "no src/href/action/style/on* attribute");
		assert.ok(!/<(link|iframe|object|embed|base|img|meta http-equiv)\b|url\(|@import|javascript:/i.test(html), "no external element");
	}
});

s.test("O12: the console's first script is qrcode-generator's browser build, verbatim; it defines only `qrcode`", async () => {
	const scripts = inlineScripts(await consolePage().text());
	assert.equal(scripts[0], `\n${QRCODE_SCRIPT}`);
	assert.ok(!/fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(|\beval\(|\bFunction\(|document|window|location|navigator|Storage|indexedDB|cookie|console\./
		.test(QRCODE_SCRIPT), "no network, storage, DOM or eval");
	const code = QRCODE_SCRIPT.replace(/^\s*\/\/.*$/gm, "");
	assert.deepEqual(code.match(/\w+:\/\/[^\s"']*/g), ["http://www.w3.org/2000/svg"], "outside comments, only the SVG namespace");
	const context = vm.createContext({});
	vm.runInContext(QRCODE_SCRIPT, context);
	assert.deepEqual(Object.keys(context), ["qrcode"]);
});

s.test("§2.2: every fetch in the console is a D5 route, and every D5 operator route is used", async () => {
	const script = inlineScript(await consolePage().text());
	assert.equal(script.match(/\bfetch\(/g)?.length, 1, "fetch only inside api()");
	assert.ok(!/XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(|location\.(href|assign|replace)|window\.open/.test(script));
	const base = /base = ("[^"]*" \+ enc\([^)]*\))/.exec(script)?.[1];
	assert.ok(base, "vault base path");
	const sites = [...script.matchAll(/\bapi\("([A-Z]+)", ((?:"[^"]*"|enc\([^)]*\)|base|\s*\+\s*)+)/g)];
	assert.equal(sites.length, script.match(/\bapi\(/g)!.length - 1, "every api() call site parsed");
	const used = new Set(sites.map(([, method, expr]) => `${method} ${expr!.replace(/\bbase\b/g, base).split(/\s*\+\s*/)
		.map((part) => part.startsWith("\"") ? part.slice(1, -1) : ":id").join("")}`));
	for (const route of used) assert.ok(ROUTES.includes(route), `${route} is in the §2.2 table`);
	for (const route of ROUTES) assert.ok(used.has(route), `${route} is used by the console`);
});

s.test("D5: every documented operator error code has a plain message, embedded in the page", async () => {
	for (const code of DOCUMENTED_CODES) assert.ok((CONSOLE_MESSAGES[code] ?? "").length > 20, code);
	const embedded = /const MESSAGES = (\{.*\});/.exec(inlineScript(await consolePage().text()))?.[1];
	assert.deepEqual(JSON.parse(embedded ?? "null"), CONSOLE_MESSAGES);
});

s.test("secrets: no web storage, cookie access or console output anywhere in the scripts", async () => {
	for (const html of [await consolePage().text(), await mobileSetupPage().text()]) {
		assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|console\./.test(inlineScript(html)));
	}
});

// ---- console flows -------------------------------------------------------------------

s.test("claim: the key is shown and confirmed before POST /claim {operatorRecoveryKey}; then code, link and QR", async () => {
	const page = await consoleWith(false);
	assert.equal(page.visible(), "claim");
	await page.press(page.$("claim-start"));
	const key = page.$("claim-key").value;
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.equal(page.$("claim-go").disabled, true, "claim waits for the saved checkbox");
	assert.deepEqual(page.calls.map((c) => c.path), ["/api/capabilities"], "nothing sent before the confirmation");
	page.$("claim-saved").checked = true;
	page.$("claim-saved").onchange?.();
	page.reply("POST /claim", 200, { ok: true, host: ORIGIN, vaultId: VAULT_ID, vaultName: "Personal", pairingCode: CODE,
		pairingExpiresAt: Date.now() + 900_000, obsidianUrl: "obsidian://ignored", capabilities: {} });
	page.reply("GET /operator/state", 200, STATE);
	await page.press(page.$("claim-go"));
	const claim = page.calls.find((c) => c.path === "/claim")!;
	assert.deepEqual([claim.method, claim.headers, claim.body], ["POST", { "Content-Type": "application/json" }, { operatorRecoveryKey: key }]);
	assert.equal(page.last().path, "/operator/state");
	assert.equal(page.visible(), "main");
	assert.equal(page.$("claim-key").value, "", "the key leaves the page");
	const pair = page.$("pair");
	assertSetupQr(pair.find("img"), CODE);
	assert.equal(pair.find("input").value, CODE);
	assert.equal(pair.find("a").href, `obsidian://yaos?action=setup&host=${encodeURIComponent(ORIGIN)}&pairingCode=${encodeURIComponent(CODE)}`);
	assert.match(pair.textContent, /Pair a device with Personal/);
	assert.equal(page.card().find("h3").textContent, "Notes");
	page.assertClean([key, CODE]);
});

s.test("claim: 409 already_claimed → sign-in; 503 or no answer keeps the key and says the claim may have gone through", async () => {
	for (const reply of [[503, { error: "internal_error" }], "network", [409, { error: "already_claimed" }]] as const) {
		const page = await consoleWith(false);
		await page.press(page.$("claim-start"));
		const key = page.$("claim-key").value;
		page.$("claim-saved").checked = true;
		page.$("claim-saved").onchange?.();
		page.replies.set("POST /claim", reply === "network" ? reply : [reply[0], reply[1]]);
		await page.press(page.$("claim-go"));
		if (reply !== "network" && reply[0] === 409) {
			assert.equal(page.visible(), "login");
			assert.equal(page.msg, CONSOLE_MESSAGES.already_claimed);
		} else {
			assert.equal(page.visible(), "claim");
			assert.equal(page.$("claim-key").value, key, "the saved key stays visible");
			assert.equal(page.msg, CONSOLE_MESSAGES.claim_unknown);
		}
		page.assertClean([key]);
	}
});

s.test("login: POST /operator/login {operatorRecoveryKey}; 401 → wrong key; 200 → vault list, field cleared", async () => {
	const page = await consoleWith(true);
	assert.equal(page.visible(), "login");
	const key = "k".repeat(40);
	const submit = async (): Promise<void> => { await page.$("login-form").onsubmit?.({ preventDefault: () => undefined }); await settle(); };
	page.$("login-key").value = "short";
	await submit();
	assert.equal(page.calls.length, 2, "a short key is not sent");
	page.$("login-key").value = key;
	page.reply("POST /operator/login", 401, { error: "unauthorized" });
	await submit();
	assert.deepEqual([page.last().body, page.msg], [{ operatorRecoveryKey: key }, CONSOLE_MESSAGES.wrong_key]);
	page.reply("POST /operator/login", 429, { error: "too_many_attempts" });
	await submit();
	assert.equal(page.msg, `Sign in: ${CONSOLE_MESSAGES.too_many_attempts}`);
	page.reply("POST /operator/login", 200, { ok: true });
	page.reply("GET /operator/state", 200, STATE);
	await submit();
	assert.deepEqual([page.visible(), page.$("login-key").value, page.last().path], ["main", "", "/operator/state"]);
	page.assertClean([key]);
});

s.test("vault: create, owner code + QR, devices + revoke (D7), and the pending-restore banner (D8b)", async () => {
	const page = await consoleWith(true, { ...STATE, pendingRestores: [{ vaultId: VAULT_ID, at: "2026-10-05T10:00:00.000Z" }] });
	assert.match(page.card().textContent, /Restore incomplete: the restore to 2026-10-05 10:00:00 UTC has not finished/);
	page.$("new-name").value = "Work";
	page.reply("POST /operator/vaults", 200, { vault: { vaultId: "WwWwWwWwWwWwWwWwWwWwWw", name: "Work" } });
	await page.press(page.$("create"));
	assert.deepEqual(page.calls.find((c) => c.path === "/operator/vaults")!.body, { name: "Work" });
	assert.equal(page.last().path, "/operator/state");
	const base = `/operator/vaults/${VAULT_ID}`;
	page.reply(`POST ${base}/owner-code`, 409, { error: "restore_in_progress" });
	await page.press(page.card().button("Pair a device"));
	assert.deepEqual([page.last().body, page.msg], [{ purpose: "owner-bootstrap" }, `Pairing code: ${CONSOLE_MESSAGES.restore_in_progress}`]);
	page.reply(`POST ${base}/owner-code`, 200, { pairingCode: CODE, expiresAt: Date.now() + 900_000, purpose: "owner-bootstrap",
		obsidianUrl: "obsidian://ignored", mobileSetupUrl: "https://elsewhere.test/mobile-setup#x" });
	await page.press(page.card().button("Pair a device"));
	assert.equal(page.$("pair").find("input").value, CODE);
	assertSetupQr(page.$("pair").find("img"), CODE);
	page.reply(`GET ${base}/devices`, 200, { devices: [{ deviceId: DEVICE_ID, deviceName: "Phone", enrolledAt: 1_790_000_000_000 }] });
	await page.press(page.card().button("Devices"));
	assert.match(page.card().textContent, /Phone \(device-0001-abcdef\), paired/);
	page.reply(`DELETE ${base}/devices/${DEVICE_ID}`, 200, { ok: true, deviceId: DEVICE_ID, revoked: true });
	await page.press(page.card().button("Revoke"));
	assert.equal(page.confirms.length, 1, "revoke asks first");
	const revoke = page.calls.find((c) => c.method === "DELETE")!;
	assert.deepEqual([revoke.path, revoke.body], [`${base}/devices/${DEVICE_ID}`, {}]);
	assert.deepEqual([page.msg, page.last().path], ["Phone is revoked.", `${base}/devices`]);
	page.reply(`GET ${base}/devices`, 401, { error: "unauthorized" });
	await page.press(page.card().button("Devices"));
	assert.deepEqual([page.visible(), page.msg], ["login", `Devices: ${CONSOLE_MESSAGES.unauthorized}`]);
	page.assertClean([CODE]);
});

s.test("vault: reset (D8a) and delete (D5) need the typed vaultId and send {confirmVaultId}", async () => {
	const page = await consoleWith(true, STATE);
	const base = `/operator/vaults/${VAULT_ID}`;
	for (const [label, route, ok, failCode, failStatus] of [
		["Reset streams", `POST ${base}/reset-streams`, { vaultEpoch: "E".repeat(22) }, "confirmation_mismatch", 400],
		["Delete vault", `DELETE ${base}`, { ok: true }, "purge_incomplete", 503],
	] as const) {
		const row = page.card().rowOf(label);
		const confirm = row.find("input");
		assert.equal(confirm.placeholder, `Type ${VAULT_ID} to confirm`);
		assert.equal(row.button(label).disabled, true, `${label}: off until the id is typed`);
		await page.type(confirm, VAULT_ID.slice(1));
		assert.equal(row.button(label).disabled, true, `${label}: a wrong id keeps the button off`);
		await page.type(confirm, VAULT_ID);
		page.reply(route, failStatus, { error: failCode });
		await page.press(row.button(label));
		assert.deepEqual([`${page.last().method} ${page.last().path}`, page.last().body], [route, { confirmVaultId: VAULT_ID }]);
		assert.equal(page.msg, `${label}: ${CONSOLE_MESSAGES[failCode]}`);
		page.reply(route, 503, { error: "cf_daily_limit", resetAt: Date.UTC(2026, 9, 7) });
		await page.press(row.button(label));
		assert.equal(page.msg, `${label}: ${CONSOLE_MESSAGES.cf_daily_limit} It resets at 2026-10-07 00:00:00 UTC.`);
		page.reply(route, 200, ok);
		await page.press(row.button(label));
		assert.match(page.msg, /is (reset|deleted)/);
		assert.equal(page.last().path, "/operator/state", "the list reloads");
	}
	page.assertClean([]);
});

s.test("vault: restore (D8b) sends {at: ISO}; restore_incomplete, restore_in_progress, invalid_restore_point and restore_unsupported read plainly", async () => {
	const page = await consoleWith(true, STATE);
	const route = `POST /operator/vaults/${VAULT_ID}/restore`;
	const at = (): FakeElement => page.card().rowOf("Restore").find("input");
	at().value = "yesterday";
	await page.press(page.card().button("Restore"));
	assert.deepEqual([page.calls.length, page.msg], [2, `Restore: ${CONSOLE_MESSAGES.invalid_restore_point}`]);
	for (const [status, code] of [[503, "restore_incomplete"], [409, "restore_in_progress"], [400, "invalid_restore_point"], [501, "restore_unsupported"]] as const) {
		at().value = "2026-10-05T10:00:00Z";
		page.reply(route, status, { error: code });
		await page.press(page.card().button("Restore"));
		const sent = page.calls.filter((c) => `${c.method} ${c.path}` === route).at(-1)!;
		assert.deepEqual([sent.headers, sent.body], [{ "Content-Type": "application/json" }, { at: "2026-10-05T10:00:00.000Z" }]);
		assert.equal(page.msg, `Restore: ${CONSOLE_MESSAGES[code]}`, code);
		assert.equal(page.last().path, "/operator/state", `${code}: the list reloads for the banner`);
	}
	page.reply(route, 200, { vaultEpoch: "E".repeat(22), resumed: true, at: "2026-10-04T08:00:00.000Z" });
	await page.press(page.card().button("Restore"));
	assert.match(page.msg, /^Finished the pending restore to 2026-10-04 08:00:00 UTC; the time you entered was not used/);
	page.reply(route, 200, { vaultEpoch: "E".repeat(22) });
	await page.press(page.card().button("Restore"));
	assert.match(page.msg, /^Notes is restored to /);
	assert.equal(page.confirms.length, 6, "every restore asks first");
	page.reply("POST /operator/logout", 200, { ok: true });
	await page.press(page.$("logout"));
	assert.deepEqual([page.last().path, page.last().body, page.visible()], ["/operator/logout", {}, "login"]);
	page.assertClean([]);
});

// ---- mobile setup -------------------------------------------------------------------

s.test("mobile-setup: reads host and code from the fragment, drops it, offers the obsidian:// link, makes no request", async () => {
	const html = await mobileSetupPage().text();
	const hash = `#${new URLSearchParams({ host: ORIGIN, pairingCode: CODE })}`;
	const good = new Page(html, hash, "/mobile-setup");
	assert.equal(good.$("go").href, `obsidian://yaos?action=setup&host=${encodeURIComponent(ORIGIN)}&pairingCode=${encodeURIComponent(CODE)}`);
	assert.deepEqual([good.$("ready").hidden, good.$("host").value, good.$("code").value], [false, ORIGIN, CODE]);
	for (const bad of [`#${new URLSearchParams({ host: "https://evil.test", pairingCode: CODE })}`, `#host=${encodeURIComponent(ORIGIN)}&pairingCode=short`, ""]) {
		const page = new Page(html, bad, "/mobile-setup");
		assert.deepEqual([page.$("ready").hidden, page.$("go").href, page.$("msg").className], [true, "", "err"], bad);
		assert.deepEqual(page.replaced, [[null, "", "/mobile-setup"]], "the fragment is dropped");
	}
	assert.deepEqual(good.replaced, [[null, "", "/mobile-setup"]], "the fragment is dropped");
	assert.deepEqual(good.calls, []);
	good.assertClean([CODE]);
});

await s.done();
