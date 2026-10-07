import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	confirmEmptyVault, createAndEnroll, CreateVaultError, creationCheck, enableEncryption, NOT_EMPTY_MESSAGE,
	optOutOfEncryption, probeServer, resumableCreation, type CreateVaultInput,
} from "./createVault";
import type { HttpRequest, HttpResponse, PairingDeps } from "./pairing";
import { FakeUiHost, identityFor, snapshot } from "./testkit/fakeUiHost";
import { testVaultId } from "../keys/testkit/vaultIds";

const ORIGIN = "https://sync.example.com";
const NEW_VAULT = testVaultId("created");
const OTHER_VAULT = testVaultId("other");
const OPERATOR_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SECRET_PART = "ownerSecretPart_0123456789abcdef";
const OWNER_CODE = `${NEW_VAULT}.${SECRET_PART}`;
const SESSION = "S".repeat(43);

interface Relay {
	readonly log: string[];
	readonly requests: HttpRequest[];
	readonly deps: PairingDeps & { readonly progress: string[] };
}

/** A scripted relay. `routes` maps "METHOD /path" to a response; the log interleaves with the host's calls. */
function relay(log: string[], routes: Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)>): Relay {
	const requests: HttpRequest[] = [];
	const progress: string[] = [];
	return {
		log,
		requests,
		deps: {
			progress,
			onProgress: (t) => progress.push(t),
			sleep: async () => {},
			request: async (req) => {
				requests.push(req);
				const key = `${req.method} ${new URL(req.url).pathname}`;
				log.push(key);
				const r = routes[key];
				if (!r) return { status: 404, json: { error: "not_found" } };
				return typeof r === "function" ? r(req) : r;
			},
		},
	};
}

function enrollOk(vaultId: string) {
	return (req: HttpRequest): HttpResponse => {
		const b = JSON.parse(req.body ?? "{}") as Record<string, string>;
		return { status: 200, json: { host: ORIGIN, vaultId, deviceId: b.deviceId, deviceToken: b.deviceToken, deviceName: b.deviceName ?? "", vaultGeneration: "g1" } };
	};
}

const setCookie = { "set-cookie": [`yaos_op=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Strict`] };

function unclaimedRoutes(code = OWNER_CODE, enrolledVault = NEW_VAULT): Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)> {
	return {
		"GET /api/capabilities": { status: 200, json: { claimed: false, streams: 1 } },
		"POST /claim": { status: 200, json: { ok: true, vaultId: NEW_VAULT, pairingCode: code, obsidianUrl: `obsidian://yaos?action=setup&host=x&pairingCode=${code}` }, headers: setCookie },
		"POST /operator/logout": { status: 200, json: { ok: true } },
		"POST /enroll": enrollOk(enrolledVault),
	};
}

function claimedRoutes(): Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)> {
	return {
		"GET /api/capabilities": { status: 200, json: { claimed: true, streams: 1 } },
		"POST /operator/login": { status: 200, json: { ok: true }, headers: setCookie },
		"POST /operator/vaults": { status: 200, json: { vault: { vaultId: NEW_VAULT, name: "Notes" } } },
		[`POST /operator/vaults/${NEW_VAULT}/owner-code`]: { status: 200, json: { pairingCode: OWNER_CODE, expiresAt: 1 } },
		"POST /operator/logout": { status: 200, json: { ok: true } },
		"POST /enroll": enrollOk(NEW_VAULT),
	};
}

/** A host whose host-method calls land in the same log as the relay's requests. */
function loggedHost(log: string[], data: ConstructorParameters<typeof FakeUiHost>[0] = {}): FakeUiHost {
	const host = new FakeUiHost(data);
	const push = host.calls.push.bind(host.calls);
	host.calls.push = (...items: string[]) => { log.push(...items); return push(...items); };
	return host;
}

const input = (claimed: boolean): CreateVaultInput => ({ server: { host: ORIGIN, claimed }, operatorKey: OPERATOR_KEY, vaultName: "Notes", deviceName: "Mac" });

/** Every text a user or a log could see: progress, error messages, the host's call log. */
function assertNoSecrets(texts: readonly string[]): void {
	for (const t of texts) {
		for (const secret of [OPERATOR_KEY, SECRET_PART, SESSION]) assert.ok(!t.includes(secret), "a secret leaked into user-visible text");
	}
}

test("probeServer accepts an unclaimed streams relay (only this flow does)", async () => {
	const r = relay([], unclaimedRoutes());
	assert.deepEqual(await probeServer("sync.example.com/", r.deps), { host: ORIGIN, claimed: false });
	const c = relay([], { "GET /api/capabilities": { status: 200, json: { claimed: true, streams: 0 } } });
	await assert.rejects(probeServer(ORIGIN, c.deps), /does not support/);
});

test("unclaimed: claim with Origin, mark creating right after it, enroll in memory with a key-free body", async () => {
	const log: string[] = [];
	const host = loggedHost(log);
	const r = relay(log, unclaimedRoutes());
	const out = await createAndEnroll(input(false), host, r.deps);
	assert.deepEqual(out, { vaultId: NEW_VAULT, replaced: null });
	assert.deepEqual(log, ["POST /claim", "POST /operator/logout", `markCreating:${NEW_VAULT}`, "POST /enroll", "updateData"]);

	const claim = r.requests.find((q) => q.url.endsWith("/claim"))!;
	assert.equal(claim.headers?.Origin, ORIGIN);
	assert.equal(claim.headers?.["Content-Type"], "application/json");
	assert.deepEqual(JSON.parse(claim.body!), { operatorRecoveryKey: OPERATOR_KEY });
	const logout = r.requests.find((q) => q.url.endsWith("/operator/logout"))!;
	assert.equal(logout.headers?.Origin, ORIGIN);
	assert.equal(logout.headers?.Cookie, `yaos_op=${SESSION}`);

	const enroll = r.requests.find((q) => q.url.endsWith("/enroll"))!;
	const body = JSON.parse(enroll.body!) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceName", "deviceToken", "enrollmentRequestId", "pairingCode"]);
	assert.equal(body.pairingCode, OWNER_CODE);
	assert.ok(!/key|suite/i.test(enroll.url));

	const d = host.data();
	assert.equal(d.identity?.vaultId, NEW_VAULT);
	assert.deepEqual(d.creating, { vaultId: NEW_VAULT });
	assert.equal(d.e2ee, undefined, "no pin is set before step 3");
	assert.equal(d.pendingEnrollment, undefined, "the owner code is never persisted");
	assertNoSecrets([...r.deps.progress, ...host.calls]);
});

test("claimed: login, create, owner code and logout all carry Origin; the session ends even on failure", async () => {
	const log: string[] = [];
	const host = loggedHost(log);
	const r = relay(log, claimedRoutes());
	await createAndEnroll(input(true), host, r.deps);
	assert.deepEqual(log, [
		"POST /operator/login", "POST /operator/vaults", `POST /operator/vaults/${NEW_VAULT}/owner-code`, "POST /operator/logout",
		`markCreating:${NEW_VAULT}`, "POST /enroll", "updateData",
	]);
	for (const q of r.requests.filter((x) => new URL(x.url).pathname.startsWith("/operator/"))) assert.equal(q.headers?.Origin, ORIGIN);
	assert.deepEqual(JSON.parse(r.requests[1]!.body!), { name: "Notes" });

	const log2: string[] = [];
	const host2 = loggedHost(log2);
	const failing = relay(log2, { ...claimedRoutes(), "POST /operator/vaults": { status: 403, json: { error: "forbidden_origin" } } });
	const err = await createAndEnroll(input(true), host2, failing.deps).then(() => null, (e: unknown) => e as Error);
	assert.match(err!.message, /Origin header/);
	assert.deepEqual(log2, ["POST /operator/login", "POST /operator/vaults", "POST /operator/logout"]);
	assert.equal(host2.data().creating, undefined);
	assertNoSecrets([err!.message, ...failing.deps.progress]);
});

test("a code for another vault, a failed enroll or an enroll into another vault drop the marker and store nothing", async () => {
	for (const [name, routes] of [
		["code for another vault", unclaimedRoutes(`${OTHER_VAULT}.${SECRET_PART}`)],
		["enroll refused", { ...unclaimedRoutes(), "POST /enroll": { status: 404, json: { error: "unknown_code" } } }],
		["enrolled elsewhere", unclaimedRoutes(OWNER_CODE, OTHER_VAULT)],
	] as const) {
		const log: string[] = [];
		const prior = identityFor(testVaultId("prior"));
		const host = loggedHost(log, { identity: prior, e2ee: { suite: 1 } });
		const r = relay(log, routes);
		const err = await createAndEnroll(input(false), host, r.deps).then(() => null, (e: unknown) => e as Error);
		assert.ok(err, name);
		assert.ok(log.includes(`abandonCreating:${NEW_VAULT}`), name);
		assert.ok(!log.includes("updateData"), name);
		assert.equal(host.data().creating, undefined, name);
		assert.deepEqual(host.data().identity, prior, name);
		assert.deepEqual(host.data().e2ee, { suite: 1 }, name);
		if (name === "code for another vault") assert.ok(!log.includes("POST /enroll"));
		assertNoSecrets([err!.message, ...r.deps.progress]);
	}
});

test("replacing a pairing reports the old identity, and the new vault's marker survives the identity change", async () => {
	const log: string[] = [];
	const prior = identityFor(testVaultId("prior"));
	const host = loggedHost(log, { identity: prior, e2ee: { suite: 0 } });
	const out = await createAndEnroll(input(false), host, relay(log, unclaimedRoutes()).deps);
	assert.deepEqual(out.replaced, prior);
	assert.equal(host.data().e2ee, undefined, "the old vault's pin is not carried over");
	assert.deepEqual(host.data().creating, { vaultId: NEW_VAULT });
	assert.equal(resumableCreation(host.data()), NEW_VAULT);
});

function creatingHost(): FakeUiHost {
	return new FakeUiHost({ identity: identityFor(NEW_VAULT), creating: { vaultId: NEW_VAULT } });
}

/** Timers the test fires by hand. */
function manualTimers() {
	const pending: (() => void)[] = [];
	return {
		fire: () => { for (const f of pending.splice(0)) f(); },
		opts: { setTimer: (_ms: number, fn: () => void) => { pending.push(fn); return pending.length; }, clearTimer: () => { pending.length = 0; } },
	};
}

test("creationCheck: creatable only from the engine; a key record or a head above 0 is not empty", () => {
	const d = creatingHost().data();
	assert.equal(creationCheck(d, null, NEW_VAULT), "wait");
	assert.equal(creationCheck(d, snapshot("key-missing"), NEW_VAULT), "wait");
	assert.equal(creationCheck(d, snapshot("key-missing", { creatable: true }), NEW_VAULT), "creatable");
	assert.equal(creationCheck(d, snapshot("key-missing", { keyringSeen: true }), NEW_VAULT), "not-empty");
	assert.equal(creationCheck(d, snapshot("key-missing", {}, { headSeq: 3 }), NEW_VAULT), "not-empty");
	assert.equal(creationCheck(d, snapshot("offline", {}, { headSeq: 3, relay: { connected: false, lastCloseCode: null, reconnectInMs: 1, rttMs: null } }), NEW_VAULT), "wait");
	assert.equal(creationCheck({ ...d, e2ee: { suite: null, keyringSeen: true } }, null, NEW_VAULT), "not-empty", "main saw a key record (sticky)");
	assert.equal(creationCheck({ ...d, e2ee: { suite: 1 } }, null, NEW_VAULT), "stopped");
	assert.equal(creationCheck(d, null, OTHER_VAULT), "stopped");
	const { creating: _c, ...noMarker } = d;
	assert.equal(creationCheck(noMarker, snapshot("key-missing", { creatable: true }), NEW_VAULT), "stopped");
});

test("confirmEmptyVault resolves once the engine reports creatable and unsubscribes", async () => {
	const host = creatingHost();
	const t = manualTimers();
	const p = confirmEmptyVault(host, NEW_VAULT, t.opts);
	host.setStatus(snapshot("starting"));
	host.setStatus(snapshot("key-missing", { creatable: true }));
	await p;
	assert.equal(host.listenerCount, 0);
	assert.deepEqual(host.data().creating, { vaultId: NEW_VAULT });
});

test("confirmEmptyVault aborts on a non-empty vault: marker dropped, no pin, NOT_EMPTY_MESSAGE", async () => {
	for (const s of [snapshot("key-missing", { keyringSeen: true }), snapshot("key-missing", {}, { headSeq: 12 })]) {
		const host = creatingHost();
		const p = confirmEmptyVault(host, NEW_VAULT, manualTimers().opts);
		host.setStatus(s);
		await assert.rejects(p, (e: unknown) => e instanceof CreateVaultError && e.code === "not-empty" && e.message === NOT_EMPTY_MESSAGE);
		assert.equal(host.data().creating, undefined);
		assert.equal(host.data().e2ee, undefined);
		assert.equal(host.commands.length, 0);
	}
});

test("confirmEmptyVault keeps the marker when it times out, and stops when the device was pinned meanwhile", async () => {
	const host = creatingHost();
	const t = manualTimers();
	const p = confirmEmptyVault(host, NEW_VAULT, t.opts);
	host.setStatus(snapshot("offline", {}, { relay: { connected: false, lastCloseCode: null, reconnectInMs: 1000, rttMs: null } }));
	t.fire();
	await assert.rejects(p, (e: unknown) => e instanceof CreateVaultError && e.code === "unconfirmed");
	assert.deepEqual(host.data().creating, { vaultId: NEW_VAULT });
	assert.equal(host.listenerCount, 0);

	const p2 = confirmEmptyVault(host, NEW_VAULT, manualTimers().opts);
	host.pin(1);
	await assert.rejects(p2, (e: unknown) => e instanceof CreateVaultError && e.code === "stopped");
});

test("enableEncryption sends enableE2ee with the RK and zero-fills it; nothing is sent unless creatable", async () => {
	const host = creatingHost();
	host.setStatus(snapshot("key-missing", { creatable: true }));
	const rk = new Uint8Array(35).fill(9);
	await enableEncryption(host, NEW_VAULT, rk);
	assert.equal(host.commands.length, 1);
	const c = host.commands[0]!;
	assert.equal(c.t, "enableE2ee");
	assert.deepEqual(c.t === "enableE2ee" ? [...c.rk] : [], new Array(35).fill(9));
	assert.ok(rk.every((b) => b === 0));

	const early = creatingHost();
	const rk2 = new Uint8Array(35).fill(5);
	await assert.rejects(enableEncryption(early, NEW_VAULT, rk2), (e: unknown) => e instanceof CreateVaultError && e.code === "unconfirmed");
	assert.equal(early.commands.length, 0);
	assert.ok(rk2.every((b) => b === 0));
	assert.deepEqual(early.data().creating, { vaultId: NEW_VAULT });
});

test("a refused choice: a lost genesis race aborts, a transient refusal keeps the marker", async () => {
	const lost = creatingHost();
	lost.setStatus(snapshot("key-missing", { creatable: true }));
	lost.handler = () => { throw new Error("refused: another genesis won; this device stays unpinned"); };
	await assert.rejects(enableEncryption(lost, NEW_VAULT, new Uint8Array(35)), (e: unknown) => e instanceof CreateVaultError && e.code === "not-empty" && e.message === NOT_EMPTY_MESSAGE);
	assert.equal(lost.data().creating, undefined);
	assert.equal(lost.data().e2ee, undefined);

	const transient = creatingHost();
	transient.setStatus(snapshot("key-missing", { creatable: true }));
	transient.handler = () => { throw new Error("refused: k is not read to head yet"); };
	await assert.rejects(optOutOfEncryption(transient, NEW_VAULT), (e: unknown) => e instanceof CreateVaultError && e.code === "unconfirmed" && /still reading/.test(e.message));
	assert.deepEqual(transient.data().creating, { vaultId: NEW_VAULT });

	const raced = creatingHost();
	raced.setStatus(snapshot("key-missing", { creatable: true }));
	raced.handler = (_c, h) => { h.snap = snapshot("key-missing", { keyringSeen: true }); throw new Error("refused: not on the creation path (needs VAULT_READY.head = 0 and an empty k, read on this session)"); };
	await assert.rejects(optOutOfEncryption(raced, NEW_VAULT), (e: unknown) => e instanceof CreateVaultError && e.code === "not-empty");
	assert.equal(raced.data().creating, undefined);
});

test("optOutOfEncryption sends pinSuite0 \"create\" only", async () => {
	const host = creatingHost();
	host.setStatus(snapshot("key-missing", { creatable: true }));
	await optOutOfEncryption(host, NEW_VAULT);
	assert.deepEqual(host.commands, [{ t: "pinSuite0", source: "create" }]);
});

test("resumableCreation needs the marker for the enrolled vault and no pin", () => {
	assert.equal(resumableCreation(creatingHost().data()), NEW_VAULT);
	assert.equal(resumableCreation(new FakeUiHost({ identity: identityFor(OTHER_VAULT), creating: { vaultId: NEW_VAULT } }).data()), null);
	assert.equal(resumableCreation(new FakeUiHost({ identity: identityFor(NEW_VAULT), creating: { vaultId: NEW_VAULT }, e2ee: { suite: 0 } }).data()), null);
	assert.equal(resumableCreation(new FakeUiHost({ creating: { vaultId: NEW_VAULT } }).data()), null);
});

// ---------------------------------------------------------------------------
// §15.1: no other path reaches creation or a creation pin. Source scan over the product UI code.
// ---------------------------------------------------------------------------

const UI_DIR = dirname(fileURLToPath(import.meta.url));

function productUiFiles(): { readonly name: string; readonly text: string }[] {
	return readdirSync(UI_DIR)
		.filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
		.map((name) => ({ name, text: readFileSync(join(UI_DIR, name), "utf8") }));
}

/** Code only: comments and string contents blanked, so prose never counts as a use. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("only createVault.ts sends enableE2ee or pinSuite0 \"create\", or marks a vault as being created", () => {
	const files = productUiFiles();
	assert.ok(files.some((f) => f.name === "createVault.ts"));
	const offenders = files.filter((f) => f.name !== "createVault.ts" && /\bmarkCreating\s*\(|"enableE2ee"|source:\s*"create"/.test(code(f.text).replace(/^\s*markCreating\(vaultId: string\): Promise<void>;$/m, "")));
	assert.deepEqual(offenders.map((f) => f.name), []);
	// Outside the UI, only the controller (the implementation) and the plugin's host object (the wiring) name them.
	const hostDir = join(UI_DIR, "..");
	for (const name of readdirSync(hostDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
		const t = code(readFileSync(join(hostDir, name), "utf8"));
		if (/\.markCreating\s*\(/.test(t)) assert.ok(name === "plugin.ts", `${name} calls markCreating`);
		if (/t:\s*"enableE2ee"|source:\s*"create"/.test(t)) assert.fail(`${name} sends a creation command`);
	}
});

test("createVault.ts is reached only from the create-vault modal, and that only from the command and settings actions", () => {
	const files = productUiFiles();
	const importers = (mod: string) => files.filter((f) => new RegExp(`from\\s+"\\./${mod}"`).test(f.text)).map((f) => f.name).sort();
	assert.deepEqual(importers("createVault"), ["createVaultModal.ts"]);
	assert.deepEqual(importers("createVaultModal"), ["registerUi.ts"]);
	const reg = code(files.find((f) => f.name === "registerUi.ts")!.text);
	const at = reg.indexOf("registerObsidianProtocolHandler(");
	assert.ok(at >= 0);
	const end = reg.indexOf("\n\t});", at);
	assert.ok(end > at);
	const handler = reg.slice(at, end);
	assert.ok(!/[Cc]reateVault|enableE2ee|markCreating/.test(handler), "the protocol handler names creation");
	assert.match(handler, /routeSetupLink\(/);
	// The modules a link, a typed or scanned code or a resumed enrollment go through never import creation.
	for (const name of ["pairing.ts", "pairFlow.ts", "pairModal.ts", "keyActions.ts", "keyModals.ts"]) {
		const f = files.find((x) => x.name === name);
		assert.ok(f, `${name} exists`);
		assert.ok(!/from\s+"\.\/createVault(Modal)?"/.test(f.text), `${name} imports creation`);
	}
});
