import { handleBlobRoute } from "../server/src/routes/blobs";

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string) {
	if (c) {
		console.log(`  PASS  ${m}`);
		passed++;
	} else {
		console.error(`  FAIL  ${m}`);
		failed++;
	}
}
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// In-memory mock blob DO
const stored = new Map<string, { mime: string; bytes: Uint8Array }>();
const mockBlobNs = {
	idFromName: () => "blob-room",
	get: () => ({
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = input instanceof Request ? input : new Request(input, init);
			const url = new URL(req.url);
			if (url.pathname === "/cdn-cgi/partyserver/set-name/") {
				return new Response("ok");
			}
			if (url.pathname === "/put" && req.method === "POST") {
				const body = await req.json() as { hash: string; mime: string; bytes: string };
				const bytes = Uint8Array.from(atob(body.bytes), (c) => c.charCodeAt(0));
				if (stored.has(body.hash)) return new Response(JSON.stringify({ ok: true }));
				stored.set(body.hash, { mime: body.mime, bytes });
				return new Response(JSON.stringify({ ok: true }));
			}
			if (url.pathname === "/get" && req.method === "POST") {
				const { hash } = await req.json() as { hash: string };
				const rec = stored.get(hash);
				if (!rec) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
				const b64 = btoa(String.fromCharCode(...rec.bytes));
				return new Response(JSON.stringify({ mime: rec.mime, bytes: b64 }));
			}
			if (url.pathname === "/exists" && req.method === "POST") {
				const { hashes } = await req.json() as { hashes: string[] };
				return new Response(JSON.stringify({ present: hashes.filter((h) => stored.has(h)) }));
			}
			if (url.pathname === "/status" && req.method === "GET") {
				let used = 0;
				for (const v of stored.values()) used += v.bytes.byteLength;
				return new Response(JSON.stringify({ usedBytes: used, blobCount: stored.size }));
			}
			return new Response("not found", { status: 404 });
		},
	}),
};

const env = { YAOS_BLOBS: mockBlobNs } as any;

console.log("\n--- DO backend: upload + download round-trip ---");
{
	stored.clear();
	const body = new TextEncoder().encode("hello attachment");
	const hash = await sha256Hex(body);
	const putRes = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/${hash}`, { method: "PUT", body }), [hash], json);
	assert(putRes.status === 204, "PUT returns 204");

	const getRes = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/${hash}`, { method: "GET" }), [hash], json);
	assert(getRes.status === 200, "GET returns 200");
	const got = new Uint8Array(await getRes.arrayBuffer());
	assert(got[0] === 104 && got[4] === 111, "GET body matches (hello)");
}

console.log("\n--- DO backend: exists ---");
{
	const hash = await sha256Hex(new TextEncoder().encode("hello attachment"));
	const res = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/exists`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hashes: [hash, "f".repeat(64)] }),
	}), ["exists"], json);
	const payload = await res.json() as { present: string[] };
	assert(payload.present.includes(hash), "exists returns stored hash");
}

console.log("\n--- DO backend: status route ---");
{
	const res = await handleBlobRoute(env, "vault-1", new Request(`https://x/vault/vault-1/blobs/status`, { method: "GET" }), ["status"], json);
	assert(res.status === 200, "GET /blobs/status returns 200");
}

console.log("\n--- R2 preferred when bucket bound ---");
{
	let r2Put = 0;
	const envR2 = { YAOS_BUCKET: { put: async () => { r2Put++; } }, YAOS_BLOBS: mockBlobNs } as any;
	const body = new TextEncoder().encode("r2 wins");
	const hash = await sha256Hex(body);
	await handleBlobRoute(envR2, "v", new Request(`https://x/vault/v/blobs/${hash}`, { method: "PUT", body }), [hash], json);
	assert(r2Put === 1, "R2 backend used when YAOS_BUCKET present");
}

console.log(`\nblob-route-do-backend: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
