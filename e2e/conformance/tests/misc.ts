/** D9 blobs, H3 daily limit. */
import type { TestDef } from "../lib/results.ts";
import { device, operatorCookie, vault } from "../lib/fixture.ts";
import { brief, http, isRouteMissing } from "../lib/http.ts";
import { checkpointPath } from "../lib/streams.ts";
import { StreamSocket } from "../lib/socket.ts";
import { bytesEqual, id, payloadOf, sha256hex, sleep } from "../lib/util.ts";

export const tests: TestDef[] = [
	{
		id: "T-BLOB-OPAQUE", group: "decision", area: "D9 blobs", expectedBefore: "SKIP",
		async run(ctx, t) {
			if (ctx.capabilities?.attachments !== true) { t.skip("capabilities.attachments=false (no R2 bucket)", { attachments: ctx.capabilities?.attachments ?? null }); return; }
			const v = await vault(ctx, "main");
			// Arbitrary non-UTF-8 bytes stand in for an encrypted blob: the server must store and return them verbatim.
			const bytes = payloadOf(`blob-${id(6)}`, 70_000).map((b, i) => (b ^ (i * 7)) & 0xff);
			const hash = sha256hex(bytes);
			t.expect("PUT 204, GET returns identical bytes, exists lists the hash");
			const put = await http(ctx, "PUT", `${v.path}/blobs/${hash}`, { token: v.owner.token, body: bytes });
			t.check("PUT 2xx", put.status >= 200 && put.status < 300, brief(put));
			const response = await fetch(`${ctx.host}${v.path}/blobs/${hash}`, { headers: { Authorization: `Bearer ${device(v, "B").token}` } });
			const got = new Uint8Array(await response.arrayBuffer());
			t.check("GET returns identical bytes", response.status === 200 && bytesEqual(got, bytes), { status: response.status, bytes: got.byteLength });
			const exists = await http(ctx, "POST", `${v.path}/blobs/exists`, { token: v.owner.token, json: { hashes: [hash] } });
			t.check("exists lists the hash", Array.isArray(exists.value?.present) && exists.value.present.includes(hash), brief(exists));
		},
	},
	{
		id: "T-BLOB-UNAVAILABLE", group: "decision", area: "D9 blobs", expectedBefore: "PASS",
		async run(ctx, t) {
			if (ctx.capabilities?.attachments === true) { t.skip("capabilities.attachments=true (bucket bound)"); return; }
			const v = await vault(ctx, "main");
			const bytes = payloadOf("blob", 100);
			const hash = sha256hex(bytes);
			t.expect("503 {error:attachments_unavailable} on PUT, GET and POST exists");
			const cases = [
				["PUT", await http(ctx, "PUT", `${v.path}/blobs/${hash}`, { token: v.owner.token, body: bytes })],
				["GET", await http(ctx, "GET", `${v.path}/blobs/${hash}`, { token: v.owner.token })],
				["POST exists", await http(ctx, "POST", `${v.path}/blobs/exists`, { token: v.owner.token, json: { hashes: [hash] } })],
			] as const;
			for (const [name, response] of cases) {
				t.check(`${name} -> 503 attachments_unavailable`, response.status === 503 && response.value?.error === "attachments_unavailable", brief(response));
			}
		},
	},
	{
		id: "T-DAILY", group: "decision", area: "H3 daily", expectedBefore: "SKIP", timeoutMs: 120000,
		async run(ctx, t) {
			const probeVault = await vault(ctx, "main");
			const cookie = await operatorCookie(ctx);
			const probe = await http(ctx, "POST", `${probeVault.path}/debug/simulate-daily-limit`, { cookie, json: { enabled: false } });
			if (isRouteMissing(probe) || probe.status === 404) {
				t.skip("debug route POST /vault/:id/debug/simulate-daily-limit absent (404: YAOS_TEST_ONLY_DEBUG_ROUTES is not \"true\" on this Worker)", brief(probe));
				return;
			}
			const v = await vault(ctx, "daily", ["A", "B"]);
			const on = await http(ctx, "POST", `${v.path}/debug/simulate-daily-limit`, { cookie, json: { enabled: true } });
			t.check("simulate on 2xx", on.status >= 200 && on.status < 300, brief(on));
			try {
				const a = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
				const b = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
				const fromB = b.mark();
				const from = a.mark();
				a.append("b:daily", "daily-1", payloadOf("daily", 64));
				const got = await a.collect(["daily-1"], from, 5000);
				await sleep(800);
				const err = got.errors.find((e) => e.type === "VAULT_ERROR");
				t.check("append -> VAULT_ERROR cf_daily_limit with resetAt + clientFrameIds", err?.code === "cf_daily_limit"
					&& Number.isFinite(err?.resetAt) && Array.isArray(err?.clientFrameIds) && got.receipts.size === 0,
				{ code: err?.code ?? null, resetAt: typeof err?.resetAt, receipts: got.receipts.size });
				t.check("no PROVISIONAL broadcast to peers", !b.frames(fromB).some((f) => f.kind === "provisional"));
				const ck = await http(ctx, "PUT", checkpointPath(v.path, "b:daily", 1, 0), { token: v.owner.token, body: payloadOf("ck", 16) });
				t.info("checkpoint while latched", brief(ck, { retryAfter: ck.headers.get("retry-after") }));
			} finally {
				const off = await http(ctx, "POST", `${v.path}/debug/simulate-daily-limit`, { cookie, json: { enabled: false } });
				t.check("simulate off 2xx", off.status >= 200 && off.status < 300, brief(off));
			}
		},
	},
];
