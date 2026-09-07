import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	SettingsSyncClient,
	SettingsSyncHttpError,
	parseSettingsSyncState,
} from "../../src/sync/settingsSync/protocol";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope";
import { suite } from "../harness.ts";

const s = suite("settings-sync-protocol");
const requests: RequestUrlParam[] = [];
const request = async (input: RequestUrlParam): Promise<RequestUrlResponse> => {
	requests.push(input);
	const responseBody = input.method === "GET" ? encodeBinaryEnvelope({ seeded: false }) : new Uint8Array(0);
	return {
		status: input.method === "GET" ? 200 : 204,
		headers: input.method === "GET" ? { "content-type": YAOS_BINARY_CONTENT_TYPE } : {},
		arrayBuffer: responseBody.slice().buffer,
		json: undefined,
		text: "",
	};
};
const client = new SettingsSyncClient({
	host: "https://sync.example.test/",
	deviceToken: "device-secret",
	vaultId: "vault/id",
	request,
});

s.test("current vault route uses device bearer and one format declaration", async () => {
	await client.getEnvironment(".obsidian");
	await client.putIntent(".obsidian", { id: "calendar", repo: "owner/repo", version: "1.0.0", enabled: true });
	await client.deleteFile(".obsidian", "hotkeys.json");
	for (const sent of requests) {
		const url = new URL(sent.url);
		s.check(url.pathname.startsWith("/vault/vault%2Fid/settings-sync/.obsidian"), "vault-scoped settings route is used");
		s.check(url.searchParams.getAll("settingsFormatVersion").join() === "2", "exactly one current format is declared");
		s.check(sent.headers?.Authorization === "Bearer device-secret", "device bearer authenticates request");
	}
	s.check(requests[1]!.contentType === YAOS_BINARY_CONTENT_TYPE, "mutations declare the binary envelope media type");
	s.check((decodeBinaryEnvelope(new Uint8Array(requests[1]!.body as ArrayBuffer)) as { id: string }).id === "calendar", "mutation metadata survives binary framing");
	s.check(new URL(requests[2]!.url).searchParams.get("path") === "hotkeys.json", "delete path remains encoded as query data");
});

s.test("response parser rejects malformed rows rather than filtering", () => {
	let error: unknown;
	try {
		parseSettingsSyncState({
			seeded: true,
			envRev: 1,
			files: [{ path: "app.json", sha256: "A".repeat(64), size: 0, rev: 1, body: new Uint8Array(0) }],
			intents: [], themes: [], tombstones: [], pluginData: [],
		});
	} catch (caught) {
		error = caught;
	}
	s.check(error instanceof SettingsSyncHttpError && error.code === "invalid_response", "invalid hash fails the whole response");
});

s.test("binary request and response preserve large bodies without base64 expansion", async () => {
	const body = new Uint8Array(600_000);
	for (let index = 0; index < body.length; index++) body[index] = index % 239;
	let wireBytes = 0;
	const roundTrip = new SettingsSyncClient({
		host: "https://sync.example.test",
		deviceToken: "token",
		vaultId: "vault",
		request: async (input): Promise<RequestUrlResponse> => {
			const requestBytes = new Uint8Array(input.body as ArrayBuffer);
			wireBytes = requestBytes.byteLength;
			const decoded = decodeBinaryEnvelope(requestBytes) as { body: Uint8Array };
			const responseBytes = encodeBinaryEnvelope({
				seeded: true, envRev: 1,
				files: [{ path: "snippets/large.css", sha256: "a".repeat(64), size: decoded.body.byteLength, rev: 1, body: decoded.body }],
				intents: [], themes: [], tombstones: [], pluginData: [],
			});
			return { status: 200, headers: { "content-type": YAOS_BINARY_CONTENT_TYPE }, arrayBuffer: responseBytes.slice().buffer, json: undefined, text: "" };
		},
	});
	const result = await roundTrip.putFile(".obsidian", { path: "snippets/large.css", sha256: "a".repeat(64), body });
	const state = parseSettingsSyncState(result);
	s.check(state.seeded && state.files[0]?.body.byteLength === body.byteLength, "raw bytes survive both binary-envelope boundaries");
	const oldJsonBytes = new TextEncoder().encode(JSON.stringify({
		path: "snippets/large.css", sha256: "a".repeat(64), legacyEncodedBody: Buffer.from(body).toString("base64"),
	})).byteLength;
	s.check(wireBytes < oldJsonBytes * 0.8, "wire body avoids the base64 4:3 tax");
});

s.test("response parser rejects duplicate identities", () => {
	const row = { id: "calendar", repo: "owner/repo", version: "1", enabled: true, rev: 1 };
	let rejected = false;
	try {
		parseSettingsSyncState({ seeded: true, envRev: 1, files: [], intents: [row, row], themes: [], tombstones: [], pluginData: [] });
	} catch {
		rejected = true;
	}
	s.check(rejected, "duplicate intent is rejected");
});

await s.done();
