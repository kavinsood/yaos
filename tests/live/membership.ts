import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import {
	deviceBearerHeaders,
	fetchSocketTicket,
	type LiveIdentity,
	requireLiveIdentityContext,
} from "./liveIdentity.ts";
import { socketPrefix } from "./schema4Live.ts";

const { deviceA, deviceB } = requireLiveIdentityContext();

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

const rosterResponse = await fetch(`${deviceA.host}/vault/${encodeURIComponent(deviceA.vaultId)}/devices`, {
	headers: deviceBearerHeaders(deviceA),
});
const roster = await rosterResponse.json() as { devices?: Array<{ deviceId?: unknown }> };
assert(rosterResponse.status === 200, "device A can read the provisioned vault roster");
assert(roster.devices?.some((device) => device.deviceId === deviceA.deviceId), "roster contains device A");
assert(roster.devices?.some((device) => device.deviceId === deviceB.deviceId), "roster contains distinct device B");

const pairingResponse = await fetch(`${deviceA.host}/vault/${encodeURIComponent(deviceA.vaultId)}/auth/pairing-code`, {
	method: "POST",
	headers: deviceBearerHeaders(deviceA, { "Content-Type": "application/json" }),
	body: JSON.stringify({ purpose: "device" }),
});
const pairing = await pairingResponse.json() as { pairingCode?: unknown };
assert(pairingResponse.status === 200 && typeof pairing.pairingCode === "string", "device A mints a one-use pairing for a revocation probe");
const enrollment = await fetch(`${deviceA.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ pairingCode: pairing.pairingCode, deviceName: "live-revoked-device" }),
});
const enrolled = await enrollment.json() as Partial<LiveIdentity> & { deviceName?: unknown };
assert(enrollment.status === 200 && typeof enrolled.deviceToken === "string" && typeof enrolled.deviceId === "string", "probe device enrolls once");
const revoked: LiveIdentity = {
	host: deviceA.host,
	vaultId: deviceA.vaultId,
	deviceToken: enrolled.deviceToken,
	deviceId: enrolled.deviceId,
};
const staleTicket = (await fetchSocketTicket(revoked)).ticket;
const activeUrl = new URL(revoked.host);
activeUrl.protocol = activeUrl.protocol === "https:" ? "wss:" : "ws:";
activeUrl.pathname = socketPrefix(revoked, "root", "root");
activeUrl.searchParams.set("ticket", staleTicket);
activeUrl.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
activeUrl.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
const activeSocket = new WebSocket(activeUrl);
await new Promise<void>((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("active revocation probe did not become ready")), 5_000);
	activeSocket.on("message", (data) => {
		if (!data.toString().includes("VAULT_READY")) return;
		clearTimeout(timeout);
		resolve();
	});
	activeSocket.once("error", reject);
});
const activeSocketClosed = new Promise<boolean>((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("revoked active socket received no terminal signal")), 5_000);
	const finish = (): void => {
		clearTimeout(timeout);
		resolve(true);
	};
	activeSocket.once("close", finish);
	activeSocket.on("message", (data) => {
		if (data.toString().includes("unauthorized")) finish();
	});
});
const leave = await fetch(`${revoked.host}/vault/${encodeURIComponent(revoked.vaultId)}/auth/device`, {
	method: "DELETE",
	headers: deviceBearerHeaders(revoked),
});
const leaveBody = await leave.json() as { closedSockets?: unknown };
assert(leave.status === 200, "probe device revokes its membership");
assert(typeof leaveBody.closedSockets === "number" && leaveBody.closedSockets >= 1, "revocation command found the active socket");
assert(await activeSocketClosed, "membership revocation terminates the already-active root socket");
const ticketAfterLeave = await fetch(`${revoked.host}/vault/${encodeURIComponent(revoked.vaultId)}/auth/ticket`, {
	method: "POST",
	headers: deviceBearerHeaders(revoked),
});
assert(ticketAfterLeave.status === 401, "revoked bearer cannot mint another socket ticket");

const revokedSocketFrame = await new Promise<FatalFrame | null>((resolve, reject) => {
	const url = new URL(revoked.host);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = socketPrefix(revoked, "root", "root");
	url.searchParams.set("ticket", staleTicket);
	url.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
	url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
	const socket = new WebSocket(url);
	let frame: FatalFrame | null = null;
	const timeout = setTimeout(() => { socket.terminate(); reject(new Error("revoked socket probe timed out")); }, 5_000);
	socket.on("message", (data) => {
		const text = data.toString();
		frame = parseFatalFrame(text.startsWith("__YPS:") ? text.slice(6) : text) ?? frame;
	});
	socket.on("close", () => { clearTimeout(timeout); resolve(frame); });
	socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
});
assert(revokedSocketFrame?.code === "unauthorized", "a pre-revocation ticket is denied after membership revocation");

const replay = await fetch(`${deviceA.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ pairingCode: pairing.pairingCode, deviceName: "live-replay" }),
});
assert(replay.status === 404, "consumed pairing capability cannot enroll again");
console.log("\n✓ Live membership and stale-ticket revocation passed");
