/** b3-clientblob: deployed blob PUT correctness (stream + R2 sha256): good, wrong-hash, small, round trip. args: <host> */
import { randomBytes, createHash } from "node:crypto";
import { vaultRoute } from "../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../tests/live/liveIdentity";
import { loadContext } from "../relay2/lib/context";
const host = process.argv[2]!.replace(/\/+$/, "");
const id = loadContext(host).devices.A!;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const put = async (hash: string, body: Uint8Array) => { const r = await fetch(vaultRoute(id, `blobs/${hash}`), { method: "PUT", headers: deviceBearerHeaders(id, { "Content-Type": "application/octet-stream" }), body }); return { status: r.status, body: (await r.text()).slice(0, 120) }; };
const get = async (hash: string) => { const r = await fetch(vaultRoute(id, `blobs/${hash}`), { headers: deviceBearerHeaders(id) }); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, sha: r.ok ? sha(b) : null, bytes: b.byteLength }; };
const out: Record<string, unknown> = {};
const good = new Uint8Array(randomBytes(3 * 1024 * 1024)); const gh = sha(good);
out.goodPut = await put(gh, good); const g = await get(gh); out.goodGet = { status: g.status, shaMatches: g.sha === gh, bytes: g.bytes };
const bad = new Uint8Array(randomBytes(2 * 1024 * 1024)); const wrong = sha(new Uint8Array(randomBytes(16)));
out.wrongHashPut = await put(wrong, bad); out.wrongHashGet = (await get(wrong)).status;
const small = new Uint8Array(randomBytes(10)); const sh = sha(small);
out.smallPut = await put(sh, small); const s2 = await get(sh); out.smallGet = { status: s2.status, shaMatches: s2.sha === sh };
console.log(JSON.stringify(out));
process.exit(0);
