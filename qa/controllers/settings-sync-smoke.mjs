#!/usr/bin/env node
/**
 * Real Obsidian settings-sync smoke. This controller never launches Obsidian or
 * a server: both must already be running, and QA_VAULT_PATH must be disposable.
 *
 * Required environment:
 *   QA_CDP_HOST, QA_CDP_PORT, QA_VAULT_PATH,
 *   QA_YAOS_SERVER_HOST, QA_YAOS_DEVICE_TOKEN, QA_YAOS_VAULT_ID,
 *   QA_SETTINGS_CONFIG_KEY
 * Optional: QA_TIMEOUT_MS (default 60000), QA_EVIDENCE_PATH (JSON output)
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { ObsidianClient } from "./obsidian-client.mjs";

const requiredEnvNames = [
	"QA_CDP_HOST",
	"QA_CDP_PORT",
	"QA_VAULT_PATH",
	"QA_YAOS_SERVER_HOST",
	"QA_YAOS_DEVICE_TOKEN",
	"QA_YAOS_VAULT_ID",
	"QA_SETTINGS_CONFIG_KEY",
];

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function parseInteger(value, name, minimum, maximum) {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return parsed;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function base64(value) {
	return Buffer.from(value, "utf8").toString("base64");
}

async function emitEvidence(value, stderr = false) {
	const json = JSON.stringify(value);
	const evidencePath = process.env.QA_EVIDENCE_PATH?.trim();
	if (evidencePath) {
		const target = resolve(evidencePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, `${json}\n`, "utf8");
	}
	const line = `SETTINGS_SYNC_DESKTOP_EVIDENCE=${json}`;
	if (stderr) console.error(line);
	else console.log(line);
}

function vaultFile(vaultRoot, ...segments) {
	const root = resolve(vaultRoot);
	const candidate = resolve(root, ...segments);
	if (!candidate.startsWith(`${root}${sep}`)) {
		throw new Error(`refusing path outside disposable QA vault: ${candidate}`);
	}
	return candidate;
}

function settingsUrl(host, vaultId, configKey, action) {
	const base = host.replace(/\/$/, "");
	const suffix = action ? `/${action}` : "";
	return `${base}/vault/${encodeURIComponent(vaultId)}/settings-sync/${encodeURIComponent(configKey)}${suffix}?settingsFormatVersion=1`;
}

async function fetchJson(url, init = {}) {
	const response = await fetch(url, init);
	const text = await response.text();
	let body = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} returned non-JSON HTTP ${response.status}`);
		}
	}
	return { response, body };
}

async function waitFor(probe, label, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
}

async function executeYaosCommand(client, commandId) {
	const result = await client.evalRaw(`
		(async () => {
			const registry = app?.commands;
			if (!registry || typeof registry.executeCommandById !== "function") {
				throw new Error("Obsidian command registry is unavailable");
			}
			if (!Object.prototype.hasOwnProperty.call(registry.commands ?? {}, ${JSON.stringify(commandId)})) {
				throw new Error("command is not registered: " + ${JSON.stringify(commandId)});
			}
			const executed = await registry.executeCommandById(${JSON.stringify(commandId)});
			return executed !== false;
		})()
	`, 120_000);
	if (result !== true) throw new Error(`Obsidian declined command ${commandId}`);
}

async function triggerYaosCommand(client, commandId) {
	const started = await client.evalRaw(`
		(() => {
			const registry = app?.commands;
			if (!registry || typeof registry.executeCommandById !== "function") {
				throw new Error("Obsidian command registry is unavailable");
			}
			if (!Object.prototype.hasOwnProperty.call(registry.commands ?? {}, ${JSON.stringify(commandId)})) {
				throw new Error("command is not registered: " + ${JSON.stringify(commandId)});
			}
			const execution = registry.executeCommandById(${JSON.stringify(commandId)});
			if (execution && typeof execution.catch === "function") {
				execution.catch((error) => console.error("[YAOS settings smoke] Calendar command failed", error));
			}
			return execution !== false;
		})()
	`);
	if (started !== true) throw new Error(`Obsidian declined command ${commandId}`);
}

async function clickModalButton(client, label) {
	const clicked = await client.evalRaw(`
		(async () => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const button = [...document.querySelectorAll(".modal-container button")]
					.find((candidate) => candidate.textContent?.trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())});
				if (button) { button.click(); return true; }
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
			}
			return false;
		})()
	`);
	if (clicked !== true) throw new Error(`confirmation button did not appear: ${label}`);
}

async function pluginStatus(client) {
	const status = await client.evalRaw(`
		(() => {
			const plugin = app?.plugins?.plugins?.yaos;
			if (!plugin || typeof plugin.getSettingsSyncStatus !== "function") return null;
			return JSON.parse(JSON.stringify(plugin.getSettingsSyncStatus()));
		})()
	`);
	return isRecord(status) ? status : null;
}

async function main() {
	for (const name of requiredEnvNames) requiredEnv(name);
	const cdpHost = requiredEnv("QA_CDP_HOST");
	const cdpPort = parseInteger(requiredEnv("QA_CDP_PORT"), "QA_CDP_PORT", 1, 65_535);
	const timeoutMs = parseInteger(process.env.QA_TIMEOUT_MS?.trim() || "60000", "QA_TIMEOUT_MS", 1_000, 600_000);
	const vaultPath = resolve(requiredEnv("QA_VAULT_PATH"));
	const serverHost = requiredEnv("QA_YAOS_SERVER_HOST").replace(/\/$/, "");
	const deviceToken = requiredEnv("QA_YAOS_DEVICE_TOKEN");
	const vaultId = requiredEnv("QA_YAOS_VAULT_ID");
	const configKey = requiredEnv("QA_SETTINGS_CONFIG_KEY");
	const authorization = { Authorization: `Bearer ${deviceToken}` };
	const evidence = {
		passed: false,
		startedAt: new Date().toISOString(),
		vaultPath,
		serverOrigin: new URL(serverHost).origin,
		vaultId,
		configKey,
		checks: [],
		decision: null,
		remoteApply: null,
		calendarInstall: null,
	};
	const pass = (name, detail) => {
		evidence.checks.push({ name, passed: true, detail });
		console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
	};
	const requireCheck = (condition, name, detail) => {
		if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
		pass(name, detail);
	};

	const capabilitiesResult = await fetchJson(`${serverHost}/api/capabilities`, { headers: authorization });
	requireCheck(capabilitiesResult.response.status === 200 && isRecord(capabilitiesResult.body), "server capabilities reachable", `HTTP ${capabilitiesResult.response.status}`);
	requireCheck(
		capabilitiesResult.body.settingsSync === true && capabilitiesResult.body.settingsFormatVersion === 1,
		"exact settings capability",
		`settingsSync=${String(capabilitiesResult.body.settingsSync)} settingsFormatVersion=${String(capabilitiesResult.body.settingsFormatVersion)}`,
	);
	const statusResult = await fetchJson(`${serverHost}/vault/${encodeURIComponent(vaultId)}/status`, { headers: authorization });
	requireCheck(statusResult.response.status === 200 && isRecord(statusResult.body), "device-authenticated vault status", `HTTP ${statusResult.response.status}`);
	requireCheck(
		statusResult.body.vaultId === vaultId
			&& statusResult.body.schemaVersion === 4
			&& statusResult.body.protocolVersion === 1
			&& typeof statusResult.body.vaultGeneration === "string"
			&& statusResult.body.vaultGeneration.length > 0,
		"schema-4 generation identity",
		`generation=${String(statusResult.body.vaultGeneration)}`,
	);

	const client = new ObsidianClient({ host: cdpHost, port: cdpPort, connectTimeoutMs: timeoutMs });
	try {
		await client.connect();
		pass("real Obsidian CDP connected", `${cdpHost}:${cdpPort}`);
		const renderer = await client.evalRaw(`
			(() => {
				const plugin = app?.plugins?.plugins?.yaos;
				const registry = app?.commands;
				return {
					basePath: app?.vault?.adapter?.basePath ?? null,
					configDir: app?.vault?.configDir ?? null,
					pluginLoaded: !!plugin,
					settings: plugin?.settings ? {
						host: plugin.settings.host,
						deviceToken: plugin.settings.deviceToken,
						vaultId: plugin.settings.vaultId,
						vaultGeneration: plugin.settings.vaultGeneration,
						settingsSyncEnabled: plugin.settings.settingsSyncEnabled,
					} : null,
					noteConnection: typeof plugin?.getCurrentConnectionState === "function"
						? plugin.getCurrentConnectionState()
						: null,
					providerSynced: plugin?.vaultSync?.providerSynced === true,
					commands: Object.keys(registry?.commands ?? {}),
				};
			})()
		`);
		requireCheck(isRecord(renderer) && renderer.pluginLoaded === true && isRecord(renderer.settings), "Yaos plugin loaded", "renderer registry");
		requireCheck(
			isRecord(renderer.noteConnection)
				&& renderer.noteConnection.kind === "online"
				&& renderer.providerSynced === true,
			"note sync remains online beside settings sync",
			JSON.stringify(renderer.noteConnection),
		);
		const rendererVaultPath = typeof renderer.basePath === "string" ? await realpath(resolve(renderer.basePath)) : "";
		const expectedVaultPath = await realpath(vaultPath);
		requireCheck(rendererVaultPath === expectedVaultPath, "disposable vault identity", rendererVaultPath);
		requireCheck(renderer.configDir === configKey, "configuration key matches Obsidian", String(renderer.configDir));
		requireCheck(
			renderer.settings.host?.replace(/\/$/, "") === serverHost
				&& renderer.settings.deviceToken === deviceToken
				&& renderer.settings.vaultId === vaultId
				&& renderer.settings.vaultGeneration === statusResult.body.vaultGeneration,
			"renderer uses explicit server identity",
			"host, bearer, vault, and generation match",
		);
		requireCheck(renderer.settings.settingsSyncEnabled === true, "settings sync enabled in disposable vault", "true");
		for (const id of [
			"yaos:settings-sync-apply",
			"yaos:settings-sync-seed-this-device",
			"yaos:settings-sync-take-seed",
		]) {
			requireCheck(renderer.commands.includes(id), `command registered: ${id}`, "Obsidian command registry");
		}
		const initialPluginStatus = await pluginStatus(client);
		requireCheck(
			initialPluginStatus !== null
				&& initialPluginStatus.configKey === configKey
				&& ["ok", "unseeded", "decision-required"].includes(initialPluginStatus.reason),
			"settings runtime status available",
			JSON.stringify(initialPluginStatus),
		);

		const environmentEndpoint = settingsUrl(serverHost, vaultId, configKey);
		let remoteResult = await fetchJson(environmentEndpoint, { headers: authorization });
		requireCheck(remoteResult.response.status === 200 && isRecord(remoteResult.body), "settings environment reachable", `HTTP ${remoteResult.response.status}`);
		if (remoteResult.body.seeded === false) {
			const localSeedText = `/* YAOS desktop seed ${Date.now()} */\n.yaos-desktop-seed { opacity: 0.84; }\n`;
			const localSeedPath = vaultFile(vaultPath, configKey, "snippets", "yaos-settings-desktop-seed.css");
			await mkdir(dirname(localSeedPath), { recursive: true });
			await writeFile(localSeedPath, localSeedText, "utf8");
			await executeYaosCommand(client, "yaos:settings-sync-seed-this-device");
			remoteResult = await waitFor(async () => {
				const candidate = await fetchJson(environmentEndpoint, { headers: authorization });
				if (candidate.response.status !== 200 || !isRecord(candidate.body) || candidate.body.seeded !== true || !Array.isArray(candidate.body.files)) return null;
				const row = candidate.body.files.find((entry) => isRecord(entry) && entry.path === "snippets/yaos-settings-desktop-seed.css");
				return isRecord(row) && row.bodyBase64 === base64(localSeedText) ? candidate : null;
			}, "settings seed command evidence", timeoutMs);
			evidence.decision = { kind: "seed-this-device", commandId: "yaos:settings-sync-seed-this-device" };
			pass("seed decision persisted", `envRev=${String(remoteResult.body.envRev)}`);
		} else if (remoteResult.body.seeded === true) {
			if (initialPluginStatus.reason === "decision-required") {
				await triggerYaosCommand(client, "yaos:settings-sync-take-seed");
				await clickModalButton(client, "Take remote");
			} else {
				await executeYaosCommand(client, "yaos:settings-sync-take-seed");
			}
			evidence.decision = { kind: "take-remote-seed", commandId: "yaos:settings-sync-take-seed" };
			pass("take decision executed", `envRev=${String(remoteResult.body.envRev)}`);
		} else {
			throw new Error(`settings environment has invalid seeded state: ${JSON.stringify(remoteResult.body)}`);
		}
		await waitFor(async () => {
			const current = await pluginStatus(client);
			return current?.seeded === true && current.reason === "ok" ? current : null;
		}, "settings runtime to report seeded/ok", timeoutMs);
		pass("settings runtime reports seeded", "reason=ok");

		const remotePath = "snippets/yaos-settings-remote-smoke.css";
		const remoteText = `/* YAOS remote apply ${Date.now()} */\n.yaos-remote-apply { --proof: ${JSON.stringify(vaultId)}; }\n`;
		const putResult = await fetchJson(settingsUrl(serverHost, vaultId, configKey, "file"), {
			method: "PUT",
			headers: { ...authorization, "Content-Type": "application/json" },
			body: JSON.stringify({ path: remotePath, sha256: sha256(remoteText), bodyBase64: base64(remoteText) }),
		});
		requireCheck(
			putResult.response.status === 200
				&& isRecord(putResult.body)
				&& putResult.body.ok === true
				&& Number.isSafeInteger(putResult.body.envRev)
				&& putResult.body.rev === putResult.body.envRev,
			"remote allowlisted file mutation",
			`HTTP ${putResult.response.status} envRev=${String(putResult.body?.envRev)}`,
		);
		await executeYaosCommand(client, "yaos:settings-sync-apply");
		const appliedPath = vaultFile(vaultPath, configKey, remotePath);
		await waitFor(async () => {
			try {
				return await readFile(appliedPath, "utf8") === remoteText;
			} catch {
				return false;
			}
		}, "remote settings command to apply exact bytes to disk", timeoutMs);
		const appliedRemote = await fetchJson(environmentEndpoint, { headers: authorization });
		const remoteRow = isRecord(appliedRemote.body) && Array.isArray(appliedRemote.body.files)
			? appliedRemote.body.files.find((entry) => isRecord(entry) && entry.path === remotePath)
			: null;
		requireCheck(
			appliedRemote.response.status === 200
				&& isRecord(remoteRow)
				&& remoteRow.rev === putResult.body.rev
				&& remoteRow.sha256 === sha256(remoteText)
				&& remoteRow.bodyBase64 === base64(remoteText),
			"remote revision remains exact after disk apply",
			`rev=${String(remoteRow?.rev)}`,
		);
		evidence.remoteApply = { commandId: "yaos:settings-sync-apply", path: remotePath, rev: remoteRow.rev, sha256: remoteRow.sha256 };
		pass("allowed settings file applied to real vault disk", appliedPath);

		const calendarCommands = await client.evalRaw(`
			(() => Object.entries(app?.commands?.commands ?? {})
				.filter(([id, command]) => {
					const text = (id + " " + String(command?.name ?? "")).toLowerCase();
					return id.startsWith("yaos:") && text.includes("calendar") && (text.includes("install") || text.includes("smoke"));
				})
				.map(([id, command]) => ({ id, name: String(command?.name ?? "") })))()
		`);
		if (!Array.isArray(calendarCommands) || calendarCommands.length === 0) {
			evidence.calendarInstall = {
				status: "unavailable",
				reason: "No Yaos debug Calendar installation command is registered in this production build.",
			};
			console.log(`UNAVAILABLE Calendar install — ${evidence.calendarInstall.reason}`);
		} else {
			requireCheck(calendarCommands.length === 1, "unambiguous Calendar debug command", JSON.stringify(calendarCommands));
			const calendarCommand = calendarCommands[0];
			const calendarBefore = await client.evalRaw(`
				(() => {
					const plugins = app?.plugins;
					const manifest = plugins?.manifests?.calendar;
					return manifest ? { version: manifest.version, enabled: plugins.enabledPlugins?.has("calendar") === true } : null;
				})()
			`);
			requireCheck(calendarBefore === null, "Calendar absent before installation smoke", JSON.stringify(calendarBefore));
			await triggerYaosCommand(client, calendarCommand.id);
			await clickModalButton(client, "Install Calendar");
			const calendar = await waitFor(async () => client.evalRaw(`
				(() => {
					const plugins = app?.plugins;
					const manifest = plugins?.manifests?.calendar;
					if (!manifest) return null;
					return { version: manifest.version, enabled: plugins.enabledPlugins?.has("calendar") === true };
				})()
			`), "Calendar debug command to install Calendar", Math.max(timeoutMs, 120_000));
			requireCheck(calendar.enabled === true && typeof calendar.version === "string" && calendar.version.length > 0, "Calendar debug installation", `version=${String(calendar.version)}`);
			evidence.calendarInstall = {
				status: "passed",
				commandId: calendarCommand.id,
				before: null,
				version: calendar.version,
				enabled: true,
			};
		}

		evidence.passed = true;
		evidence.completedAt = new Date().toISOString();
		await emitEvidence(evidence);
	} finally {
		await client.close();
	}
}

main().catch(async (error) => {
	const failure = {
		passed: false,
		completedAt: new Date().toISOString(),
		error: error instanceof Error ? error.message : String(error),
	};
	await emitEvidence(failure, true);
	process.exitCode = 1;
});
