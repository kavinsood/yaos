import * as Y from "yjs";
import { MAX_SV_ECHO_BASE64_BYTES, SV_ECHO_SCHEMA, SV_ECHO_TYPE } from "./svEchoProtocol";

// y-partyserver custom-message wire prefix. Verified in
// engineering/server-ack-spike.md against y-partyserver@2.1.2; rerun that
// spike and tests/provider-manual-connect.mjs when upgrading y-partyserver.
const Y_PARTYSERVER_CUSTOM_PREFIX = "__YPS:";
const WS_READY_STATE_OPEN = 1;

export type SvEchoKind = "baseline" | "postApply";

export type SvEchoSendResult =
	| { ok: true; kind: SvEchoKind; bytes: number }
	| { ok: false; kind: SvEchoKind; bytes: number; failure: "not_open" | "oversize" | "send_failed" };

type SendableConnection = {
	readyState?: number;
	send(message: string): void;
};

function encodeBytesBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		s += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(s);
}

function framedByteLength(payload: string): number {
	return new TextEncoder().encode(`${Y_PARTYSERVER_CUSTOM_PREFIX}${payload}`).byteLength;
}

export function makeSvEchoCustomMessage(serverSv: Uint8Array): string {
	return JSON.stringify({
		type: SV_ECHO_TYPE,
		schema: SV_ECHO_SCHEMA,
		sv: encodeBytesBase64(serverSv),
	});
}

export function makeSvEchoCustomMessageForDoc(doc: Y.Doc): string {
	return makeSvEchoCustomMessage(Y.encodeStateVector(doc));
}

export function trySendSvEchoStateVector(
	connection: SendableConnection,
	serverSv: Uint8Array,
	kind: SvEchoKind,
): SvEchoSendResult {
	if (connection.readyState !== undefined && connection.readyState !== WS_READY_STATE_OPEN) {
		return { ok: false, kind, bytes: 0, failure: "not_open" };
	}

	const encodedSv = encodeBytesBase64(serverSv);
	if (encodedSv.length > MAX_SV_ECHO_BASE64_BYTES) {
		const bytes = framedByteLength(JSON.stringify({
			type: SV_ECHO_TYPE,
			schema: SV_ECHO_SCHEMA,
			sv: encodedSv,
		}));
		return { ok: false, kind, bytes, failure: "oversize" };
	}

	const payload = JSON.stringify({
		type: SV_ECHO_TYPE,
		schema: SV_ECHO_SCHEMA,
		sv: encodedSv,
	});
	const framedMessage = `${Y_PARTYSERVER_CUSTOM_PREFIX}${payload}`;
	const bytes = new TextEncoder().encode(framedMessage).byteLength;

	try {
		connection.send(framedMessage);
		return { ok: true, kind, bytes };
	} catch {
		return { ok: false, kind, bytes, failure: "send_failed" };
	}
}

export function trySendSvEcho(
	connection: SendableConnection,
	doc: Y.Doc,
	kind: SvEchoKind,
): SvEchoSendResult {
	return trySendSvEchoStateVector(connection, Y.encodeStateVector(doc), kind);
}
