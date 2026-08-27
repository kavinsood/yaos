import { handleClaimRoute } from "../../server/src/routes/auth";
import type { AuthState, Env } from "../../server/src/routes/types";
import { renderMobileSetupPage, renderSetupPage } from "../../server/src/setupPage";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../../server/src/setupQr";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("setup-page-qr");
const host = "https://example.test";
const pairingCode = "pairing-code-for-one-device";

function decodeSvgDataUrl(dataUrl: string): string {
	const prefix = "data:image/svg+xml;base64,";
	if (!dataUrl.startsWith(prefix)) throw new Error("expected an SVG data URL");
	return Buffer.from(dataUrl.slice(prefix.length), "base64").toString("utf8");
}

s.section("setup QR carries only host and pairing code");
{
	const mobileUrl = buildMobileSetupUrl(host, pairingCode);
	const parsed = new URL(mobileUrl);
	const params = new URLSearchParams(parsed.hash.slice(1));
	s.check(params.get("host") === host, "fragment carries host");
	s.check(params.get("pairingCode") === pairingCode, "fragment carries pairing code");
	s.check([...params.keys()].length === 2, "fragment has no recovery key or identity data");
	const rendered = await renderSetupQrDataUrl(mobileUrl);
	const svg = decodeSvgDataUrl(rendered);
	s.check(svg.includes("<svg ") && !svg.includes("<script"), "QR is local inert SVG");
}

s.section("setup pages use honest identity names");
{
	const setup = renderSetupPage({ host });
	const mobile = renderMobileSetupPage({ host });
	s.check(setup.includes("operatorRecoveryKey"), "claim body names the operator recovery key");
	s.check(setup.includes("pairingCode"), "claim page uses pairing code for enrollment");
	s.check(mobile.includes('params.get("pairingCode")'), "mobile page reads pairingCode");
}

s.section("claim stores only recovery hash and returns pairing material");
{
	let claimBody: Record<string, unknown> = {};
	const stored = {
		configFormat: 2,
		claimed: true,
		operatorRecoveryHash: "placeholder",
		ticketSigningKey: "signing-key",
		updateProvider: null,
		updateRepoUrl: null,
		updateRepoBranch: null,
	};
	const env: Env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (request) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/__yaos/claim") {
				claimBody = await request.json() as Record<string, unknown>;
				return Response.json({
					ok: true,
					vaultId: claimBody.vaultId,
					vaultGeneration: "generation-setup-qr-aa",
					vaultName: claimBody.vaultName,
				});
			}
			if (pathname === "/__yaos/activate-vault") {
				return Response.json({
					ok: true,
					pairingExp: Date.now() + 15 * 60_000,
					vault: {
						vaultId: claimBody.vaultId,
						vaultGeneration: "generation-setup-qr-aa",
						name: claimBody.vaultName,
						state: "active",
						createdAt: 1,
						provisionedAt: 2,
					},
				});
			}
			if (pathname === "/__yaos/create-session") return Response.json({ ok: true });
			if (pathname === "/__yaos/config") return Response.json(stored);
			throw new Error(`unexpected config request: ${pathname}`);
		}),
		YAOS_SYNC: makeVaultSyncNamespace(async (request) =>
			new URL(request.url).pathname === "/__yaos/provision"
				? Response.json({ created: true }, { status: 201 })
				: Response.json({ error: "not found" }, { status: 404 })),
	});
	const unclaimed: AuthState = { mode: "unclaimed", claimed: false };
	const operatorRecoveryKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const response = await handleClaimRoute(new Request(`${host}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	}), env, unclaimed);
	const body = await response.json() as { pairingCode?: string; vaultId?: string; operatorRecoveryKey?: string };
	s.check(response.ok && typeof body.pairingCode === "string" && typeof body.vaultId === "string", "claim returns first-vault pairing material");
	s.check(body.operatorRecoveryKey === undefined, "recovery key is not echoed");
	s.check(typeof claimBody.operatorRecoveryHash === "string", "claim persists recovery hash");
	s.check(!("operatorRecoveryKey" in claimBody), "raw recovery key never enters config storage");
}

await s.done();
