import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PREPARE_VAULT_PATHS,
	type PrepareVaultPaths,
	PrepareVaultError,
	parsePrepareVaultArgs,
	prepareVault,
} from "../../qa/scripts/prepare-vault-lib";
import { suite } from "../harness.ts";

const s = suite("prepare-vault");

async function expectPrepareError(action: () => Promise<unknown>, includes: string): Promise<void> {
	await assert.rejects(action, (error: unknown) =>
		error instanceof PrepareVaultError && error.message.includes(includes),
	);
}

async function makeLayout(): Promise<{ root: string; paths: PrepareVaultPaths; vaultParent: string; workspaceBytes: string }> {
	const root = await mkdtemp(join(tmpdir(), "yaos-prepare-vault-"));
	const fixturesDir = join(root, "fixtures");
	const fixtureDir = join(fixturesDir, "001-known");
	const vaultParent = join(root, "vaults");
	const workspaceBytes = await readFile(DEFAULT_PREPARE_VAULT_PATHS.blankWorkspace, "utf8");

	await mkdir(fixtureDir, { recursive: true });
	await mkdir(vaultParent);
	await writeFile(join(fixtureDir, "fixture-note.md"), "# fixture\n", "utf8");
	await writeFile(join(root, "product-main.js"), "// QA product\n", "utf8");
	await writeFile(join(root, "harness-main.js"), "// QA harness\n", "utf8");
	await writeFile(join(root, "yaos-manifest.json"), "{\"id\":\"yaos\"}\n", "utf8");
	await writeFile(join(root, "harness-manifest.json"), "{\"id\":\"yaos-qa-harness\"}\n", "utf8");
	await writeFile(join(root, "plugin-lock.json"), "{\"presets\":{\"minimal\":[]}}\n", "utf8");
	await writeFile(join(root, "blank-workspace.json"), workspaceBytes, "utf8");

	return {
		root,
		vaultParent,
		workspaceBytes,
		paths: {
			fixturesDir,
			yaosBuild: join(root, "product-main.js"),
			yaosManifest: join(root, "yaos-manifest.json"),
			harnessBuild: join(root, "harness-main.js"),
			harnessManifest: join(root, "harness-manifest.json"),
			pluginLock: join(root, "plugin-lock.json"),
			blankWorkspace: join(root, "blank-workspace.json"),
		},
	};
}

function containsMarkdownLeafOrFilePath(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsMarkdownLeafOrFilePath);
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.type === "markdown") return true;
	return Object.entries(record).some(([key, nested]) => {
		const hasFilePath = (key === "file" || key === "path") && typeof nested === "string" && nested.length > 0;
		return hasFilePath || containsMarkdownLeafOrFilePath(nested);
	});
}

s.section("QA vault preparation regressions");

s.test("rejects --clean before any filesystem mutation", async () => {
	assert.throws(
		() => parsePrepareVaultArgs(["--fixture", "001-known", "--dest", "/tmp/new-vault", "--clean"]),
		(error: unknown) => error instanceof PrepareVaultError && error.message.includes("never deletes"),
	);
});

s.test("never merges into or overwrites existing destinations", async () => {
	const { paths, vaultParent } = await makeLayout();
	const destination = join(vaultParent, "already-there");
	const sibling = join(vaultParent, "unrelated-sibling.txt");
	await mkdir(destination);
	await writeFile(join(destination, "sentinel.txt"), "preserve me", "utf8");
	await writeFile(sibling, "sibling survives", "utf8");

	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: destination }, paths),
		"Destination already exists",
	);
	assert.equal(await readFile(join(destination, "sentinel.txt"), "utf8"), "preserve me");
	assert.equal(await readFile(sibling, "utf8"), "sibling survives");

	const emptyDestination = join(vaultParent, "empty-directory");
	await mkdir(emptyDestination);
	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: emptyDestination }, paths),
		"Destination already exists",
	);

	const symlinkDestination = join(vaultParent, "dangling-link");
	await symlink(join(vaultParent, "missing-target"), symlinkDestination);
	await expectPrepareError(
		() => prepareVault({ fixture: "001-known", dest: symlinkDestination }, paths),
		"Destination already exists",
	);
});

s.test("rejects traversal and path-like fixture IDs without creating a destination", async () => {
	const { paths, vaultParent } = await makeLayout();
	const traversalDestination = join(vaultParent, "traversal-target");
	await expectPrepareError(
		() => prepareVault({ fixture: "../001-known", dest: traversalDestination }, paths),
		"Invalid fixture ID",
	);
	await assert.rejects(async () => readFile(traversalDestination), { code: "ENOENT" });

	const pathLikeDestination = join(vaultParent, "path-like-target");
	await expectPrepareError(
		() => prepareVault({ fixture: "nested/fixture", dest: pathLikeDestination }, paths),
		"Invalid fixture ID",
	);
	await assert.rejects(async () => readFile(pathLikeDestination), { code: "ENOENT" });
});

s.test("writes the checked-in blank workspace bytes without file state or vault paths", async () => {
	const { paths, vaultParent, workspaceBytes } = await makeLayout();
	const destination = join(vaultParent, "workspace-vault");
	await prepareVault({ fixture: "001-known", dest: destination }, paths);

	const bytes = await readFile(join(destination, ".obsidian", "workspace.json"), "utf8");
	assert.equal(bytes, workspaceBytes);
	assert.equal(bytes.includes(destination), false);
	assert.equal(bytes.includes(vaultParent), false);
	const workspace = JSON.parse(bytes) as Record<string, unknown>;
	assert.deepEqual(workspace.lastOpenFiles, []);
	assert.equal(containsMarkdownLeafOrFilePath(workspace), false);
});

s.test("writes an explicitly unenrolled identity by default without inventing membership", async () => {
	const { paths, vaultParent } = await makeLayout();
	const first = await prepareVault({ fixture: "001-known", dest: join(vaultParent, "first") }, paths);
	const second = await prepareVault({ fixture: "001-known", dest: join(vaultParent, "second") }, paths);

	assert.deepEqual(first.enrollment, { status: "unenrolled" });
	assert.deepEqual(second.enrollment, { status: "unenrolled" });
	const firstSettings = JSON.parse(await readFile(join(first.dest, ".obsidian", "plugins", "yaos", "data.json"), "utf8")) as Record<string, unknown>;
	const enabledPlugins = JSON.parse(await readFile(join(first.dest, ".obsidian", "community-plugins.json"), "utf8")) as string[];
	assert.equal(firstSettings.host, "");
	assert.equal(firstSettings.deviceToken, "");
	assert.equal(firstSettings.vaultId, "");
	assert.equal(firstSettings.deviceId, "");
	assert.equal("token" in firstSettings, false);
	assert.deepEqual(enabledPlugins, ["yaos", "yaos-qa-harness"]);
});

s.test("enrolls through the real server contract and persists the returned identity", async () => {
	const { paths, vaultParent } = await makeLayout();
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(JSON.stringify({
			deviceToken: "issued-device-secret",
			vaultId: "server-vault",
			deviceId: "server-device",
			name: "QA Device",
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	const prepared = await prepareVault({
		fixture: "001-known",
		dest: join(vaultParent, "paired"),
		enrollment: {
			mode: "pairing",
			host: "https://sync.example/",
			pairingCode: "one-use-code",
			deviceName: "QA Device",
		},
	}, paths, fetchImpl);

	assert.equal(requestUrl, "https://sync.example/enroll");
	assert.equal(requestInit?.method, "POST");
	assert.deepEqual(JSON.parse(String(requestInit?.body)), {
		pairingCode: "one-use-code",
		deviceName: "QA Device",
	});
	assert.deepEqual(prepared.enrollment, {
		status: "enrolled",
		host: "https://sync.example",
		vaultId: "server-vault",
		deviceId: "server-device",
		name: "QA Device",
	});
	const settings = JSON.parse(await readFile(join(prepared.dest, ".obsidian", "plugins", "yaos", "data.json"), "utf8")) as Record<string, unknown>;
	assert.equal(settings.host, "https://sync.example");
	assert.equal(settings.deviceToken, "issued-device-secret");
	assert.equal(settings.vaultId, "server-vault");
	assert.equal(settings.deviceId, "server-device");
	assert.equal(settings.deviceName, "QA Device");
	assert.equal("token" in settings, false);
});

s.test("rejects enrollment responses that do not exactly match the credential schema", async () => {
	const { paths, vaultParent } = await makeLayout();
	const destination = join(vaultParent, "bad-enrollment");
	const fetchImpl = (async () => new Response(JSON.stringify({
		deviceToken: "issued-device-secret",
		vaultId: "server-vault",
		deviceId: "server-device",
		name: "QA Device",
		extra: true,
	}), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})) as typeof fetch;

	await expectPrepareError(
		() => prepareVault({
			fixture: "001-known",
			dest: destination,
			enrollment: {
				mode: "pairing",
				host: "https://sync.example",
				pairingCode: "one-use-code",
				deviceName: "QA Device",
			},
		}, paths, fetchImpl),
		"exactly deviceToken, vaultId, deviceId, and name",
	);
	await assert.rejects(async () => readFile(destination), { code: "ENOENT" });
});

s.test("rejects partial or mixed enrollment arguments", () => {
	const base = ["--fixture", "001-known", "--dest", "/tmp/new-vault"];
	assert.throws(
		() => parsePrepareVaultArgs([...base, "--host", "https://sync.example", "--pairing-code", "code"]),
		(error: unknown) => error instanceof PrepareVaultError && error.message.includes("--device-name"),
	);
	assert.throws(
		() => parsePrepareVaultArgs([...base, "--host", "https://sync.example", "--device-token", "secret", "--vault-id", "vault"]),
		(error: unknown) => error instanceof PrepareVaultError && error.message.includes("--device-id"),
	);
	assert.throws(
		() => parsePrepareVaultArgs([
			...base,
			"--host", "https://sync.example",
			"--pairing-code", "code",
			"--device-token", "secret",
			"--device-name", "QA Device",
		]),
		(error: unknown) => error instanceof PrepareVaultError && error.message.includes("cannot be combined"),
	);
});

s.test("accepts only a complete controlled pre-enrolled identity", async () => {
	const { paths, vaultParent } = await makeLayout();
	const parsed = parsePrepareVaultArgs([
		"--fixture", "001-known",
		"--dest", join(vaultParent, "controlled"),
		"--host", "https://sync.example",
		"--device-token", "fixture-device-secret",
		"--vault-id", "fixture-vault",
		"--device-id", "fixture-device",
		"--device-name", "Fixture Device",
	]);
	assert.equal(parsed.help, false);
	if (parsed.help) throw new Error("unexpected help result");
	const prepared = await prepareVault(parsed, paths);
	const settings = JSON.parse(await readFile(join(prepared.dest, ".obsidian", "plugins", "yaos", "data.json"), "utf8")) as Record<string, unknown>;
	assert.deepEqual(
		{
			host: settings.host,
			deviceToken: settings.deviceToken,
			vaultId: settings.vaultId,
			deviceId: settings.deviceId,
			deviceName: settings.deviceName,
		},
		{
			host: "https://sync.example",
			deviceToken: "fixture-device-secret",
			vaultId: "fixture-vault",
			deviceId: "fixture-device",
			deviceName: "Fixture Device",
		},
	);
});
await s.done();
