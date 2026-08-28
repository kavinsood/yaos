import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	SettingsSyncClient,
	SettingsSyncHttpError,
	parseSettingsSyncState,
} from "../../src/sync/settingsSync/protocol";
import { suite } from "../harness.ts";

const s = suite("settings-sync-protocol");
const requests: RequestUrlParam[] = [];
const request = async (input: RequestUrlParam): Promise<RequestUrlResponse> => {
	requests.push(input);
	return {
		status: input.method === "GET" ? 200 : 204,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: input.method === "GET" ? { seeded: false } : undefined,
		text: input.method === "GET" ? '{"seeded":false}' : "",
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
		s.check(url.searchParams.getAll("settingsFormatVersion").join() === "1", "exactly one current format is declared");
		s.check(sent.headers?.Authorization === "Bearer device-secret", "device bearer authenticates request");
	}
	s.check(new URL(requests[2]!.url).searchParams.get("path") === "hotkeys.json", "delete path remains encoded as query data");
});

s.test("response parser rejects malformed rows rather than filtering", () => {
	let error: unknown;
	try {
		parseSettingsSyncState({
			seeded: true,
			envRev: 1,
			files: [{ path: "app.json", sha256: "A".repeat(64), size: 0, rev: 1, bodyBase64: "" }],
			intents: [], themes: [], tombstones: [], pluginData: [],
		});
	} catch (caught) {
		error = caught;
	}
	s.check(error instanceof SettingsSyncHttpError && error.code === "invalid_response", "invalid hash fails the whole response");
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
