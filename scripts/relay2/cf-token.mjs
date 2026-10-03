// Emits the `cf` CLI OAuth access token on stdout for capture into CLOUDFLARE_API_TOKEN (never echo it).
// Refreshes via `cf auth whoami` when within 5 min of expiry. Refuses to write to a terminal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const CFG = `${process.env.HOME}/Library/Preferences/cloudflare/config/default.json`;
const CF = process.env.CF_BIN ?? "/opt/homebrew/bin/cf";
export function cfToken() {
	const read = () => JSON.parse(readFileSync(CFG, "utf8"));
	let j = read();
	if (!j.oauth_token || !j.expiration_time || Date.parse(j.expiration_time) < Date.now() + 300_000) {
		const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
		execFileSync(CF, ["auth", "whoami"], { env, stdio: "ignore" });
		j = read();
	}
	if (!j.oauth_token || Date.parse(j.expiration_time) < Date.now() + 60_000) throw new Error("cf oauth token missing or expired; run `cf auth login`");
	return j.oauth_token;
}
if (process.argv[1]?.endsWith("cf-token.mjs")) {
	if (process.stdout.isTTY) { console.error("refusing to print token to a terminal"); process.exit(2); }
	process.stdout.write(cfToken());
}
