import WebSocket from "ws";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { deviceBearerHeaders, fetchSocketTicket, requireLiveIdentityContext } from "./liveIdentity.ts";

const { deviceA, deviceB, operatorCookie } = requireLiveIdentityContext();
const vaultPath = `/operator/vaults/${encodeURIComponent(deviceA.vaultId)}`;
const operatorHeaders = { Cookie: operatorCookie };
const staleTicket = (await fetchSocketTicket(deviceA)).ticket;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

async function destroy(): Promise<{ response: Response; body: Record<string, unknown> | null }> {
	const response = await fetch(`${deviceA.host}${vaultPath}`, { method: "DELETE", headers: operatorHeaders });
	const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
	return { response, body };
}

console.log("\n--- Operator generation-scoped destroy smoke ---");
let result = await destroy();
assert(result.response.status === 202, `operator destroy enters bounded purge (${result.response.status})`);
let pending = result.body?.pending as Record<string, unknown> | undefined;
assert(typeof pending?.vaultGeneration === "string", "pending destroy exposes its vault generation fence");
assert(pending.purgeJobId === `purge:${deviceA.vaultId}:${pending.vaultGeneration}`, "purge job identity is scoped to the exact vault generation");
assert(["pending", "queued", "purging", "retrying", "complete"].includes(String(pending.purgeState)), `purge status is explicit (${String(pending.purgeState)})`);
const status = await fetch(`${deviceA.host}${vaultPath}/deletion`, { headers: operatorHeaders });
const statusBody = await status.json().catch(() => null) as { pending?: Record<string, unknown> } | null;
assert(status.status === 200 && statusBody?.pending?.purgeJobId === pending.purgeJobId, "operator deletion status preserves the generation-scoped retry obligation");
result = await destroy();
assert(result.response.status === 202 || result.response.status === 200, "repeating destroy retries idempotently instead of creating another purge generation");
if (result.response.status === 202) {
	pending = result.body?.pending as Record<string, unknown> | undefined;
	assert(pending?.purgeJobId === statusBody?.pending?.purgeJobId, "destroy retry retains the original purge job identity");
}

const deadline = Date.now() + 15_000;
while (result.response.status !== 200 && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	result = await destroy();
}
assert(result.response.status === 200 && result.body?.completed === true, `generation purge and SQL deletion complete (${result.response.status})`);

for (const [label, identity] of [["A", deviceA], ["B", deviceB]] as const) {
	const ticket = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/auth/ticket`, {
		method: "POST",
		headers: deviceBearerHeaders(identity),
	});
	assert(ticket.status === 401, `destroy revokes device ${label} membership`);
	const root = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/root`, {
		headers: deviceBearerHeaders(identity),
	});
	assert(root.status === 401 || root.status === 404 || root.status === 409, `device ${label} cannot read root storage after purge (${root.status})`);
	const body = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/heads`, {
		headers: deviceBearerHeaders(identity),
	});
	assert(body.status === 401 || body.status === 404 || body.status === 409, `device ${label} cannot read catalog storage after purge (${body.status})`);
}

const staleSocketFrame = await new Promise<FatalFrame | null>((resolve, reject) => {
	const staleProbe = new URL(`${deviceA.host}/vault/${encodeURIComponent(deviceA.vaultId)}/ws/root`);
	staleProbe.protocol = staleProbe.protocol === "https:" ? "wss:" : "ws:";
	staleProbe.searchParams.set("ticket", staleTicket);
	staleProbe.searchParams.set("schemaVersion", "4");
	staleProbe.searchParams.set("protocolVersion", "1");
	const socket = new WebSocket(staleProbe);
	let frame: FatalFrame | null = null;
	const timeout = setTimeout(() => {
		socket.terminate();
		reject(new Error("post-destroy socket probe timed out"));
	}, 5_000);
	socket.on("message", (data) => {
		const text = data.toString();
		frame = parseFatalFrame(text.startsWith("__YPS:") ? text.slice(6) : text) ?? frame;
	});
	socket.on("close", () => {
		clearTimeout(timeout);
		resolve(frame);
	});
	socket.on("error", (error) => {
		clearTimeout(timeout);
		reject(error);
	});
});
assert(staleSocketFrame?.code === "unauthorized", "pre-destroy socket ticket is rejected after purge completion");
console.log("\n✓ Operator destroy revoked membership and completed generation-scoped purge");
