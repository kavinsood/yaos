import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { suite } from "../harness.ts";
import {
	enroll,
	orphanPids,
	startDaemon,
	type CliProcess,
	type Daemon,
} from "./daemon.ts";
import {
	bootstrapCatalog,
	claimServer,
	enrollPublic,
	mintPairingCode,
	operatorState,
	PublicPeer,
	revokeDevice,
	type ClaimedServer,
	type Identity,
} from "./schema4.ts";
import { launchLossyProxy, launchWrangler, type LossyProxy, type WranglerTarget } from "./wrangler.ts";

const WATCH_MS = 25_000;
const RECONCILE_MS = 45_000;
const BURST_MS = 90_000;
const DROPPED_RECOVERY_INTERVAL_MS = 6_000;
const RECONCILE_INTERVAL_MS = 1_500;
const DROP_MARKER = "headless-dropped-hint-";
const NEGATIVE_HOLD_MS = 7_000;
const SLOW_INTERVAL_MS = 12_000;
const SLOW_HOLD_MS = 8_000;
const SLOW_WAIT_MS = 60_000;
const s = suite("schema-4 headless daemon");

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function headline(error: unknown): string {
	return describe(error).split("\n")[0] ?? "unknown failure";
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	label: string | (() => string),
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
			lastError = null;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	const detail = typeof label === "function" ? label() : label;
	throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${detail}${lastError === null ? "" : `; last error: ${headline(lastError)}`}`);
}

async function holdFor(predicate: () => boolean | Promise<boolean>, label: string, durationMs: number): Promise<void> {
	const deadline = Date.now() + durationMs;
	while (Date.now() < deadline) {
		if (!await predicate()) throw new Error(`${label} stopped holding before ${String(durationMs)}ms`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
	}
}

async function checked(label: string, body: () => void | Promise<void>): Promise<boolean> {
	try {
		await body();
		s.check(true, label);
		return true;
	} catch (error) {
		s.check(false, `${label} — ${headline(error)}`);
		return false;
	}
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function findNamed(root: string, name: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name === name) found.push(path);
		}
	};
	await visit(root);
	return found;
}

async function listVaultFiles(root: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) result.push(...await listVaultFiles(root, relative));
		else result.push(relative);
	}
	return result.sort();
}

function deepString(value: unknown, keys: readonly string[]): string | null {
	if (typeof value !== "object" || value === null) return null;
	const object = value as Record<string, unknown>;
	for (const key of keys) {
		const candidate = object[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const candidate of Object.values(object)) {
		const nested = deepString(candidate, keys);
		if (nested !== null) return nested;
	}
	return null;
}

function deepBoolean(value: unknown, key: string): boolean | null {
	if (typeof value !== "object" || value === null) return null;
	const object = value as Record<string, unknown>;
	if (typeof object[key] === "boolean") return object[key];
	for (const candidate of Object.values(object)) {
		const nested = deepBoolean(candidate, key);
		if (nested !== null) return nested;
	}
	return null;
}

function replaceDeepString(value: unknown, keys: readonly string[], replacement: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	const object = value as Record<string, unknown>;
	for (const key of keys) {
		if (typeof object[key] === "string") {
			object[key] = replacement;
			return true;
		}
	}
	return Object.values(object).some((candidate) => replaceDeepString(candidate, keys, replacement));
}

async function enrollmentIdentity(path: string): Promise<Identity> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	const host = deepString(value, ["host"]);
	const vaultId = deepString(value, ["vaultId"]);
	const vaultGeneration = deepString(value, ["vaultGeneration"]);
	const deviceId = deepString(value, ["deviceId"]);
	const deviceToken = deepString(value, ["deviceToken", "deviceBearer", "token"]);
	const deviceName = deepString(value, ["deviceName"]);
	const originImport = deepBoolean(value, "originImport");
	if (!host || !vaultId || !vaultGeneration || !deviceId || !deviceToken || !deviceName || originImport === null) {
		throw new Error(`enrollment.json has incomplete identity shape: ${JSON.stringify(value)}`);
	}
	return { host, vaultId, vaultGeneration, deviceId, deviceToken, deviceName, originImport };
}

async function remoteEquals(peer: PublicPeer, path: string, expected: string | null): Promise<boolean> {
	return await peer.read(path) === expected;
}

function diagnosticFor(lines: readonly string[], path: string): boolean {
	return lines.some((line) => line.includes(path));
}

async function expectExit(child: CliProcess, code: number, label: string): Promise<void> {
	const exit = await child.waitForExit();
	if (exit.code !== code || exit.signal !== null) throw new Error(`${label} exited code=${String(exit.code)} signal=${String(exit.signal)}\n${child.dump()}`);
}

async function denied(body: () => Promise<unknown>): Promise<string | null> {
	try {
		await body();
		return null;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code ?? "unknown-error";
	}
}

let worker: WranglerTarget | null = null;
let proxy: LossyProxy | null = null;
let server: ClaimedServer | null = null;
let peer: PublicPeer | null = null;
let originDaemon: Daemon | null = null;
let joinDaemon: Daemon | null = null;
let originVault = "";
let joiningVault = "";
let externalStore = "";
let xdgState = "";
let enrollmentPath = "";
let originIdentity: Identity | null = null;

function requirePeer(): PublicPeer {
	if (peer === null) throw new Error("public peer is unavailable");
	return peer;
}

function requireServer(): ClaimedServer {
	if (server === null) throw new Error("claimed Worker is unavailable");
	return server;
}
function requireOriginDaemon(): Daemon {
	const daemon = originDaemon as Daemon | null;
	if (daemon === null) throw new Error("origin daemon is unavailable");
	return daemon;
}


async function bootOrigin(
	label: string,
	dropHintsMarker?: string,
	reconcileIntervalMs = RECONCILE_INTERVAL_MS,
	periodicBarrierFile?: string,
): Promise<Daemon> {
	const claimed = requireServer();
	const daemon = startDaemon({
		vaultPath: originVault,
		vaultId: claimed.vaultId,
		xdgStateHome: xdgState,
		reconcileIntervalMs,
		...(dropHintsMarker === undefined ? {} : { dropHintsMarker }),
		...(periodicBarrierFile === undefined ? {} : { periodicBarrierFile }),
	});
	try {
		await daemon.waitForReady();
	} catch (error) {
		await daemon.stop("SIGKILL");
		throw new Error(`${label}: ${headline(error)}\n${daemon.dump()}`);
	}
	if (daemon.readyLines().length !== 1) throw new Error(`${label} printed readiness ${String(daemon.readyLines().length)} times`);
	originDaemon = daemon;
	return daemon;
}

async function stopOrigin(): Promise<void> {
	if (originDaemon === null) return;
	const exit = await originDaemon.stop("SIGTERM");
	if (exit.code !== 0) throw new Error(`daemon shutdown failed code=${String(exit.code)} signal=${String(exit.signal)}\n${originDaemon.dump()}`);
	if (originDaemon.readyLines().length !== 1) {
		throw new Error(`daemon printed readiness ${String(originDaemon.readyLines().length)} times over its lifetime`);
	}
	originDaemon = null;
}

try {
	s.section("real Worker and loss-safe first-party enrollment");
	worker = await launchWrangler();
	proxy = await launchLossyProxy(worker.host);
	server = await claimServer(worker.host);
	xdgState = await mkdtemp(join(tmpdir(), "yaos-headless-xdg-"));
	originVault = await mkdtemp(join(tmpdir(), "yaos-headless-origin-"));
	joiningVault = await mkdtemp(join(tmpdir(), "yaos-headless-join-"));
	externalStore = await mkdtemp(join(tmpdir(), "yaos-headless-external-"));
	const originText = "# imported before enrollment\n\norigin authority must publish this exact text\n";
	await writeFile(join(originVault, "origin.md"), originText, "utf8");
	await mkdir(join(originVault, ".obsidian"));
	await writeFile(join(originVault, ".obsidian", "ignored.md"), "must not sync\n", "utf8");
	await writeFile(join(originVault, "ignored.txt"), "headless is markdown-only\n", "utf8");

	const firstAttempt = await enroll(originVault, {
		xdgStateHome: xdgState,
		host: proxy.host,
		pairingCode: server.pairingCode,
	});
	await checked("the enrollment whose accepted response was lost exits 1 without a crash", () => expectExit(
		firstAttempt,
		1,
		"lost-response enrollment",
	));
	s.check(proxy.droppedEnrollmentResponses() === 1, "the proxy dropped exactly one accepted /enroll response");
	const secretOutput = firstAttempt.stdout() + firstAttempt.stderr();
	s.check(!secretOutput.includes(server.pairingCode), "the pairing code never appears in enrollment output");
	const pendingFiles = await findNamed(xdgState, "enrollment.json");
	const pendingPath = pendingFiles[0];
	if (pendingFiles.length !== 1 || pendingPath === undefined) {
		throw new Error("lost enrollment response did not leave one durable pending enrollment");
	}
	const pendingState: unknown = JSON.parse(await readFile(pendingPath, "utf8"));
	const pendingDeviceId = deepString(pendingState, ["deviceId"]);
	const pendingDeviceToken = deepString(pendingState, ["deviceToken"]);
	s.check(Boolean(pendingDeviceId && pendingDeviceToken), "pending request identity is durable before the retry begins");
	const pendingMode = (await stat(pendingPath)).mode & 0o777;
	s.check(pendingMode === 0o600, `pending enrollment secrets are mode 0600 before retry (actual ${pendingMode.toString(8)})`);

	const retry = await enroll(originVault, {
		xdgStateHome: xdgState,
		host: proxy.host,
		pairingCode: server.pairingCode,
	});
	await checked("retrying enrollment with the consumed pairing code succeeds from durable pending identity", () => expectExit(retry, 0, "enrollment retry"));
	const enrollmentFiles = await findNamed(xdgState, "enrollment.json");
	s.check(enrollmentFiles.length === 1, `one durable enrollment exists (found ${String(enrollmentFiles.length)})`);
	const finalizedPath = enrollmentFiles[0];
	if (enrollmentFiles.length !== 1 || finalizedPath === undefined) throw new Error("cannot continue without exactly one origin enrollment");
	enrollmentPath = finalizedPath;
	s.check(
		!firstAttempt.argv.includes(server.pairingCode) && !retry.argv.includes(server.pairingCode),
		"the pairing secret is supplied only through environment, never argv",
	);
	originIdentity = await enrollmentIdentity(enrollmentPath);
	s.check(originIdentity.vaultId === server.vaultId && originIdentity.vaultGeneration === server.vaultGeneration, "durable enrollment is fenced to the claimed schema-4 vault generation");
	s.check(originIdentity.originImport, "the first enrolled CLI persistently owns originImport authority");
	s.check(
		originIdentity.deviceId === pendingDeviceId && originIdentity.deviceToken === pendingDeviceToken,
		"retry promoted the exact pending device identity instead of generating another credential",
	);
	const stateAfterRetry = await operatorState(server);
	const devices = Array.isArray(stateAfterRetry.devices) ? stateAfterRetry.devices as Array<Record<string, unknown>> : [];
	const matchingDevices = devices.filter((device) => device.deviceId === originIdentity?.deviceId);
	s.check(matchingDevices.length === 1, "lost-response retry enrolled one device, not a second identity");

	const peerPairingCode = await mintPairingCode(server);
	const peerIdentity = await enrollPublic(worker.host, peerPairingCode, "headless-public-peer");
	s.check(
		!`${firstAttempt.stdout()}${firstAttempt.stderr()}${retry.stdout()}${retry.stderr()}`.includes(originIdentity.deviceToken),
		"the durable device bearer never appears in CLI output",
	);
	s.check(!peerIdentity.originImport, "the public peer is a joining device, not a second origin authority");
	s.check(peerIdentity.vaultId === server.vaultId && peerIdentity.vaultGeneration === server.vaultGeneration, "the second device has the same vault identity and a distinct device bearer");
	s.check(peerIdentity.deviceId !== originIdentity.deviceId && peerIdentity.deviceToken !== originIdentity.deviceToken, "the second device does not reuse the CLI credential");
	peer = await PublicPeer.connect(peerIdentity);

	s.section("origin import and joining bootstrap");
	await bootOrigin("origin daemon");
	const initialDaemon = originDaemon as Daemon | null;
	s.check(initialDaemon?.readyLines().length === 1, "origin daemon announces readiness exactly once");
	const catalog = await bootstrapCatalog(peerIdentity);
	s.check(
		catalog.get("origin.md")?.content === originText,
		"origin import was durably published before the daemon announced readiness",
	);
	s.check(!catalog.has("ignored.txt") && !catalog.has(".obsidian/ignored.md"), "origin import is Markdown-only and excludes .obsidian");
	await checked("originImport reaches the second device over its public WebSocket", () => waitFor(
		() => remoteEquals(requirePeer(), "origin.md", originText),
		"the public peer to read origin.md",
		RECONCILE_MS,
	));

	const joinPairingCode = await mintPairingCode(server);
	const joinEnrollment = await enroll(joiningVault, { xdgStateHome: xdgState, host: worker.host, pairingCode: joinPairingCode });
	await expectExit(joinEnrollment, 0, "joining enrollment");
	const allEnrollmentFiles = await findNamed(xdgState, "enrollment.json");
	const joiningEnrollmentPath = allEnrollmentFiles.find((path) => path !== enrollmentPath);
	if (!joiningEnrollmentPath) throw new Error("joining enrollment did not create independent state");
	const joiningIdentity = await enrollmentIdentity(joiningEnrollmentPath);
	s.check(!joiningIdentity.originImport, "the joining CLI persists originImport=false");
	s.check(
		joiningIdentity.deviceId !== originIdentity.deviceId && joiningIdentity.deviceToken !== originIdentity.deviceToken,
		"the joining CLI enrolls as its own device instead of copying origin credentials",
	);
	joinDaemon = startDaemon({ vaultPath: joiningVault, vaultId: server.vaultId, xdgStateHome: xdgState, reconcileIntervalMs: RECONCILE_INTERVAL_MS });
	await joinDaemon.waitForReady();
	const joinedAtReady = await readIfExists(join(joiningVault, "origin.md"));
	s.check(
		joinedAtReady === originText,
		"a real joining CLI completed SQL bootstrap and materialized exact content before announcing readiness",
	);
	const joinExit = await joinDaemon.stop("SIGTERM");
	s.check(joinExit.code === 0, "joining daemon shuts down cleanly after bootstrap");
	s.check(joinDaemon.readyLines().length === 1, "joining daemon printed readiness exactly once over its lifetime");
	joinDaemon = null;

	s.section("exact bidirectional sync and lock fencing");
	const localPath = "local-exact.md";
	const localV1 = "# local\n\ncreated on disk\n";
	await writeFile(join(originVault, localPath), localV1, "utf8");
	await checked("local create reaches the second device byte-for-byte", () => waitFor(
		() => remoteEquals(requirePeer(), localPath, localV1),
		`remote exact ${localPath}`,
		WATCH_MS,
	));
	const localV2 = `${localV1}modified once\n`;
	await writeFile(join(originVault, localPath), localV2, "utf8");
	await checked("local modify reaches the second device byte-for-byte", () => waitFor(
		() => remoteEquals(requirePeer(), localPath, localV2),
		`remote edit ${localPath}`,
		WATCH_MS,
	));

	const remotePath = "remote-exact.md";
	const remoteV1 = "# remote\n\ncreated through schema-4 lifecycle and candidate receipts\n";
	await requirePeer().create(remotePath, remoteV1);
	await checked("remote create materializes exact content on disk", () => waitFor(
		async () => await readIfExists(join(originVault, remotePath)) === remoteV1,
		`disk exact ${remotePath}`,
		WATCH_MS,
	));
	const remoteV2 = `${remoteV1}modified through a durable candidate\n`;
	await requirePeer().edit(remotePath, remoteV2);
	await checked("remote durable edit updates exact disk content", () => waitFor(
		async () => await readIfExists(join(originVault, remotePath)) === remoteV2,
		`disk edit ${remotePath}`,
		WATCH_MS,
	));

	const contender = startDaemon({ vaultPath: originVault, vaultId: server.vaultId, xdgStateHome: xdgState });
	const contenderExited = await checked(
		"a second daemon for the same real vault exits 17",
		() => expectExit(contender, 17, "lock contender"),
	);
	if (!contenderExited && contender.exitStatus() === null) await contender.stop("SIGKILL");
	const lockOwner = originDaemon as Daemon | null;
	s.check(lockOwner?.exitStatus() === null, "the lock owner remains alive after rejecting its contender");

	s.section("filesystem rename is deliberately delete plus create");
	const renameBefore = "rename-before.md";
	const renameAfter = "rename-after.md";
	const renameText = "# rename\n\ncontent survives, identity does not\n";
	await writeFile(join(originVault, renameBefore), renameText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), renameBefore, renameText), `remote baseline ${renameBefore}`, WATCH_MS);
	const oldBodyId = requirePeer().activePaths().get(renameBefore);
	await rename(join(originVault, renameBefore), join(originVault, renameAfter));
	await checked("rename publishes exact content at the new path", () => waitFor(
		() => remoteEquals(requirePeer(), renameAfter, renameText),
		`remote ${renameAfter}`,
		WATCH_MS,
	));
	await checked("rename retires the old active path", () => waitFor(
		() => !requirePeer().activePaths().has(renameBefore),
		`remote removal ${renameBefore}`,
		WATCH_MS,
	));
	const newBodyId = requirePeer().activePaths().get(renameAfter);
	s.check(typeof oldBodyId === "string" && typeof newBodyId === "string" && oldBodyId !== newBodyId, "rename's documented limitation is observable: delete+create assigns a new body identity");

	s.section("burst, non-cold restart, and offline changes");
	const burst = new Map<string, string>();
	for (let index = 0; index < 40; index++) {
		const folder = `burst/${String(index % 4)}`;
		await mkdir(join(originVault, folder), { recursive: true });
		const path = `${folder}/note-${String(index).padStart(2, "0")}.md`;
		const content = `# burst ${String(index)}\n\n${path}\n`;
		burst.set(path, content);
		await writeFile(join(originVault, path), content, "utf8");
	}
	const burstDaemon = requireOriginDaemon();
	let burstMismatch = "no successful bootstrap sample";
	await checked("all 40 burst files converge exactly", () => waitFor(
		async () => {
			const snapshot = await bootstrapCatalog(requirePeer().identity);
			const missing: string[] = [];
			const wrong: string[] = [];
			for (const [path, content] of burst) {
				const actual = snapshot.get(path);
				if (!actual) missing.push(path);
				else if (actual.content !== content) wrong.push(path);
			}
			burstMismatch = `missing=${String(missing.length)} [${missing.slice(0, 8).join(", ")}] `
				+ `wrong=${String(wrong.length)} [${wrong.slice(0, 8).join(", ")}] catalog=${String(snapshot.size)}`;
			return missing.length === 0 && wrong.length === 0;
		},
		() => `all burst files on the public peer; ${burstMismatch}\n${burstDaemon.dump()}`,
		BURST_MS,
	));
	await stopOrigin();
	const sqliteFiles = await findNamed(xdgState, "client.sqlite");
	s.check(sqliteFiles.length >= 2, `origin and joining devices persist independent SQLite databases (found ${String(sqliteFiles.length)})`);
	const originStateDir = dirname(enrollmentPath);
	const originSqlite = join(originStateDir, "client.sqlite");
	const sqliteBefore = await stat(originSqlite);
	s.check(sqliteBefore.size > 0, "the stopped origin daemon left a non-empty schema-4 SQLite cache");
	const offlineLocalPath = "offline-local.md";
	const offlineLocalText = "written while daemon was stopped\n";
	await writeFile(join(originVault, offlineLocalPath), offlineLocalText, "utf8");
	const offlineRemotePath = "offline-remote.md";
	const offlineRemoteText = "remote candidate committed while daemon was stopped\n";
	await requirePeer().create(offlineRemotePath, offlineRemoteText);
	const remoteOfflineEdit = `${remoteV2}edited remotely while daemon was stopped\n`;
	await requirePeer().edit(remotePath, remoteOfflineEdit);
	const resumedDaemon = await bootOrigin("non-cold restart");
	const sqliteAfter = await stat(originSqlite);
	s.check(sqliteAfter.ino === sqliteBefore.ino && sqliteAfter.size > 0, "restart reopened the existing non-empty SQLite cache instead of replacing it");
	let offlineLocalObserved: string | null = null;
	await checked("offline local create reaches the remote device after restart", () => waitFor(
		async () => {
			offlineLocalObserved = await requirePeer().read(offlineLocalPath);
			return offlineLocalObserved === offlineLocalText;
		},
		() => `remote ${offlineLocalPath}; observed=${JSON.stringify(offlineLocalObserved)}\n${resumedDaemon.dump()}`,
		RECONCILE_MS,
	));
	let offlineRemoteObserved: string | null = null;
	await checked("offline remote create materializes after restart", () => waitFor(
		async () => {
			offlineRemoteObserved = await readIfExists(join(originVault, offlineRemotePath));
			return offlineRemoteObserved === offlineRemoteText;
		},
		() => `disk ${offlineRemotePath}; observed=${JSON.stringify(offlineRemoteObserved)}\n${resumedDaemon.dump()}`,
		RECONCILE_MS,
	));
	let offlineEditObserved: string | null = null;
	await checked("offline remote edit is not shadowed by the local cache", () => waitFor(
		async () => {
			offlineEditObserved = await readIfExists(join(originVault, remotePath));
			return offlineEditObserved === remoteOfflineEdit;
		},
		() => `disk offline edit ${remotePath}; observed=${JSON.stringify(offlineEditObserved)} `
			+ `expected=${JSON.stringify(remoteOfflineEdit)}\n${resumedDaemon.dump()}`,
		RECONCILE_MS,
	));

	s.section("dirty-local remote delete and unresolved external rename retirement");
	const dirtyPath = "dirty-delete.md";
	const dirtyBaseline = "shared baseline\n";
	await writeFile(join(originVault, dirtyPath), dirtyBaseline, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), dirtyPath, dirtyBaseline), `remote baseline ${dirtyPath}`, WATCH_MS);
	await stopOrigin();
	const dirtyLocal = "LOCAL WORK MUST SURVIVE REMOTE DELETE\n";
	await writeFile(join(originVault, dirtyPath), dirtyLocal, "utf8");
	await requirePeer().delete(dirtyPath);
	await bootOrigin("dirty delete restart");
	await checked("remote delete preserves dirty local content exactly", () => holdFor(
		async () => await readIfExists(join(originVault, dirtyPath)) === dirtyLocal,
		`${dirtyPath} dirty local content`,
		NEGATIVE_HOLD_MS,
	));
	await checked("preserved dirty work is eventually revived remotely", () => waitFor(
		() => remoteEquals(requirePeer(), dirtyPath, dirtyLocal),
		`remote revival ${dirtyPath}`,
		RECONCILE_MS,
	));

	await stopOrigin();
	const unresolvedSource = "unresolved-source.md";
	const unresolvedTarget = "unresolved-renamed.md";
	const canonicalRemote = "remote canonical with no local baseline\n";
	const preservedLocal = "local independent content with no baseline\n";
	await requirePeer().create(unresolvedSource, canonicalRemote);
	await waitFor(
		() => remoteEquals(requirePeer(), unresolvedSource, canonicalRemote),
		`temporary remote source ${unresolvedSource}`,
		WATCH_MS,
	);
	await requirePeer().delete(unresolvedSource);
	await waitFor(
		() => remoteEquals(requirePeer(), unresolvedSource, null),
		`remote tombstone ${unresolvedSource}`,
		WATCH_MS,
	);
	await writeFile(join(originVault, unresolvedSource), preservedLocal, "utf8");
	const unresolvedDaemon = await bootOrigin("preserved-unresolved restart");
	await checked("the collision is observably registered as preserved-unresolved", () => waitFor(
		() => diagnosticFor(unresolvedDaemon.preservedUnresolved(), unresolvedSource),
		() => `preserved-unresolved diagnostic for ${unresolvedSource}\n${unresolvedDaemon.dump()}`,
		RECONCILE_MS,
	));
	await checked("a no-baseline collision preserves the local file instead of overwriting it", () => holdFor(
		async () => await readIfExists(join(originVault, unresolvedSource)) === preservedLocal,
		`${unresolvedSource} preserved`,
		3_000,
	));
	await rename(join(originVault, unresolvedSource), join(originVault, unresolvedTarget));
	await checked("the external rename observably retires the preserved-unresolved source", () => waitFor(
		() => diagnosticFor(unresolvedDaemon.preservedRetired(), unresolvedSource),
		() => `preserved-retired diagnostic for ${unresolvedSource}\n${unresolvedDaemon.dump()}`,
		RECONCILE_MS,
	));
	await checked("external rename retires the unresolved source and imports its preserved content at the new path", () => waitFor(
		() => remoteEquals(requirePeer(), unresolvedTarget, preservedLocal),
		`remote renamed preserved content ${unresolvedTarget}`,
		RECONCILE_MS,
	));
	await checked("retirement lets the external rename tombstone the old remote path instead of reviving it", () => waitFor(
		() => remoteEquals(requirePeer(), unresolvedSource, null),
		`retired source tombstone ${unresolvedSource}`,
		RECONCILE_MS,
	));
	await checked("the retired source stays absent on disk across reconciliation", () => holdFor(
		async () => await readIfExists(join(originVault, unresolvedSource)) === null,
		`${unresolvedSource} absent after external rename`,
		3_000,
	));

	s.section("dropped hints, two-phase delete, and false-delete guards");
	await stopOrigin();
	const recoveryDaemon = await bootOrigin(
		"dropped-hint recovery daemon",
		DROP_MARKER,
		DROPPED_RECOVERY_INTERVAL_MS,
	);
	s.check(
		recoveryDaemon.declaredEnv.YAOS_TEST_ONLY_DROP_HINT === DROP_MARKER
			&& recoveryDaemon.declaredEnv.YAOS_TEST_ONLY_RECONCILE_INTERVAL_MS === String(DROPPED_RECOVERY_INTERVAL_MS),
		"the dropped-hint recovery daemon has an explicit scan interval longer than the negative hold",
	);

	const droppedCreate = `${DROP_MARKER}create.md`;
	const droppedModify = `${DROP_MARKER}modify.md`;
	const droppedV1 = "created without watcher hint\n";
	await waitFor(
		() => recoveryDaemon.authoritativeReconciles().length > 0,
		() => `first completed authoritative admission\n${recoveryDaemon.dump()}`,
		RECONCILE_MS,
	);
	const createScanMark = recoveryDaemon.authoritativeReconciles().length;
	await writeFile(join(originVault, droppedCreate), droppedV1, "utf8");
	await writeFile(join(originVault, droppedModify), droppedV1, "utf8");
	await checked("a marked create remains absent past normal watcher latency while the scan clock is unchanged", () => holdFor(
		async () => recoveryDaemon.authoritativeReconciles().length === createScanMark
			&& await remoteEquals(requirePeer(), droppedCreate, null),
		`${droppedCreate} absent with reconcile count ${String(createScanMark)}`,
		2_000,
	));
	let droppedCreateObserved: string | null = null;
	await checked("dropped create hints recover only after an authoritative scan advances", () => waitFor(
		async () => {
			droppedCreateObserved = await requirePeer().read(droppedCreate);
			return recoveryDaemon.authoritativeReconciles().length > createScanMark
				&& droppedCreateObserved === droppedV1;
		},
		() => `scan recovery ${droppedCreate}; observed=${JSON.stringify(droppedCreateObserved)} `
			+ `reconciles=${String(recoveryDaemon.authoritativeReconciles().length)} mark=${String(createScanMark)}\n`
			+ recoveryDaemon.dump(),
		RECONCILE_MS,
	));
	await waitFor(
		() => remoteEquals(requirePeer(), droppedModify, droppedV1),
		() => `baseline ${droppedModify}; rootActive=${String(requirePeer().activePaths().has(droppedModify))} `
			+ `reconciles=${String(recoveryDaemon.authoritativeReconciles().length)}\n${recoveryDaemon.dump()}`,
		RECONCILE_MS,
	);
	const droppedV2 = `${droppedV1}modified without watcher hint\n`;
	const preModifyScan = recoveryDaemon.authoritativeReconciles().length;
	await waitFor(
		() => recoveryDaemon.authoritativeReconciles().length > preModifyScan,
		() => `completed authoritative admission immediately before dropped modify\n${recoveryDaemon.dump()}`,
		RECONCILE_MS,
	);
	const modifyScanMark = recoveryDaemon.authoritativeReconciles().length;
	await writeFile(join(originVault, droppedModify), droppedV2, "utf8");
	await checked("a marked modify remains stale past normal watcher latency while the scan clock is unchanged", () => holdFor(
		async () => recoveryDaemon.authoritativeReconciles().length === modifyScanMark
			&& await remoteEquals(requirePeer(), droppedModify, droppedV1),
		`${droppedModify} stale with reconcile count ${String(modifyScanMark)}`,
		2_000,
	));
	let droppedModifyObserved: string | null = null;
	await checked("dropped modify hints recover only after an authoritative scan advances", () => waitFor(
		async () => {
			droppedModifyObserved = await requirePeer().read(droppedModify);
			return recoveryDaemon.authoritativeReconciles().length > modifyScanMark
				&& droppedModifyObserved === droppedV2;
		},
		() => `scan edit recovery ${droppedModify}; observed=${JSON.stringify(droppedModifyObserved)} `
			+ `expected=${JSON.stringify(droppedV2)} reconciles=${String(recoveryDaemon.authoritativeReconciles().length)} `
			+ `mark=${String(modifyScanMark)}\n${recoveryDaemon.dump()}`,
		RECONCILE_MS,
	));

	await stopOrigin();
	const blind = await bootOrigin("dropped-delete safety daemon", DROP_MARKER);
	s.check(blind.declaredEnv.YAOS_TEST_ONLY_DROP_HINT === DROP_MARKER, "the dropped-delete safety daemon keeps hints blinded");
	await rm(join(originVault, droppedCreate));
	await checked("phase one records a dropped-delete candidate without mutating remote state", () => waitFor(
		() => diagnosticFor(blind.deleteCandidates(), droppedCreate) && requirePeer().activePaths().has(droppedCreate),
		() => `candidate for ${droppedCreate}\n${blind.dump()}`,
		RECONCILE_MS,
	));
	await checked("phase two confirms a stable positive absence before deleting remotely", () => waitFor(
		() => diagnosticFor(blind.confirmedDeletes(), droppedCreate) && !requirePeer().activePaths().has(droppedCreate),
		() => `confirmed delete ${droppedCreate}\n${blind.dump()}`,
		RECONCILE_MS,
	));

	const transientPath = `${DROP_MARKER}transient.md`;
	const transientText = "transient absence must not delete\n";
	await writeFile(join(originVault, transientPath), transientText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), transientPath, transientText), `remote ${transientPath}`, RECONCILE_MS);
	await rm(join(originVault, transientPath));
	await waitFor(() => diagnosticFor(blind.deleteCandidates(), transientPath), () => `transient candidate\n${blind.dump()}`, RECONCILE_MS);
	await writeFile(join(originVault, transientPath), transientText, "utf8");
	await checked("transient absence withdraws its candidate and never becomes a delete", () => waitFor(
		() => diagnosticFor(blind.withdrawnDeleteCandidates(), transientPath),
		() => `withdrawn candidate ${transientPath}\n${blind.dump()}`,
		RECONCILE_MS,
	));
	await checked("transiently absent content remains active and exact", () => holdFor(
		() => remoteEquals(requirePeer(), transientPath, transientText),
		`${transientPath} remote content`,
		NEGATIVE_HOLD_MS,
	));

	const atomicPath = `${DROP_MARKER}atomic.md`;
	let atomicText = "atomic version 0\n";
	await writeFile(join(originVault, atomicPath), atomicText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), atomicPath, atomicText), `remote ${atomicPath}`, RECONCILE_MS);
	for (let version = 1; version <= 5; version++) {
		atomicText = `atomic version ${String(version)}\n`;
		const temporary = join(originVault, `.atomic-${String(version)}.tmp`);
		await writeFile(temporary, atomicText, "utf8");
		await rename(temporary, join(originVault, atomicPath));
	}
	await checked("atomic rename-over saves converge and never become a false delete", () => waitFor(
		() => remoteEquals(requirePeer(), atomicPath, atomicText),
		`latest atomic content ${atomicPath}`,
		RECONCILE_MS,
	));
	await checked("atomic replacement stays active across later scans", () => holdFor(
		() => !diagnosticFor(blind.confirmedDeletes(), atomicPath) && remoteEquals(requirePeer(), atomicPath, atomicText),
		`${atomicPath} active after atomic saves`,
		NEGATIVE_HOLD_MS,
	));
	s.check(!diagnosticFor(blind.confirmedDeletes(), atomicPath), "atomic save path was never confirmed as deleted");
	const unlinkReplacement = "atomic unlink-then-rename replacement\n";
	const unlinkTemporary = join(originVault, ".atomic-unlink-replacement.tmp");
	await writeFile(unlinkTemporary, unlinkReplacement, "utf8");
	await rm(join(originVault, atomicPath));
	await waitFor(
		() => diagnosticFor(blind.deleteCandidates(), atomicPath),
		() => `atomic unlink candidate for ${atomicPath}\n${blind.dump()}`,
		RECONCILE_MS,
	);
	await rename(unlinkTemporary, join(originVault, atomicPath));
	await checked("unlink-then-rename atomic replacement withdraws the open delete review", () => waitFor(
		() => diagnosticFor(blind.withdrawnDeleteCandidates(), atomicPath),
		() => `atomic replacement withdrawal for ${atomicPath}\n${blind.dump()}`,
		RECONCILE_MS,
	));
	let atomicReplacementObserved: string | null = null;
	await checked("unlink-then-rename replacement converges without a false delete", () => waitFor(
		async () => {
			atomicReplacementObserved = await requirePeer().read(atomicPath);
			return atomicReplacementObserved === unlinkReplacement;
		},
		() => `remote replacement ${atomicPath}; observed=${JSON.stringify(atomicReplacementObserved)} `
			+ `expected=${JSON.stringify(unlinkReplacement)} `
			+ `reconciles=${String(blind.authoritativeReconciles().length)} `
			+ `withdrawals=${JSON.stringify(blind.withdrawnDeleteCandidates().filter((line) => line.includes(atomicPath)))} `
			+ `confirmations=${JSON.stringify(blind.confirmedDeletes().filter((line) => line.includes(atomicPath)))}\n`
			+ blind.dump(),
		RECONCILE_MS,
	));

	const unreadableDir = `${DROP_MARKER}unreadable`;
	const unreadablePath = `${unreadableDir}/note.md`;
	const unreadableText = "inside unreadable subtree\n";
	await mkdir(join(originVault, unreadableDir));
	await writeFile(join(originVault, unreadablePath), unreadableText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), unreadablePath, unreadableText), `remote ${unreadablePath}`, RECONCILE_MS);
	await chmod(join(originVault, unreadableDir), 0o000);
	const blocked = await denied(() => readdir(join(originVault, unreadableDir)));
	s.check(blocked !== null, `chmod made the subtree genuinely unreadable (${String(blocked)})`);
	await checked("an unreadable directory produces neither candidate nor remote mass-delete", () => holdFor(
		() => !diagnosticFor(blind.deleteCandidates(), unreadablePath) && remoteEquals(requirePeer(), unreadablePath, unreadableText),
		`${unreadablePath} while unreadable`,
		NEGATIVE_HOLD_MS,
	));
	await chmod(join(originVault, unreadableDir), 0o755);

	const symlinkDir = `${DROP_MARKER}symlink`;
	const symlinkPath = `${symlinkDir}/note.md`;
	const symlinkText = "inside a subtree later reached through symlink\n";
	await mkdir(join(originVault, symlinkDir));
	await writeFile(join(originVault, symlinkPath), symlinkText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), symlinkPath, symlinkText), `remote ${symlinkPath}`, RECONCILE_MS);
	const storedDir = join(externalStore, symlinkDir);
	await rename(join(originVault, symlinkDir), storedDir);
	await symlink(storedDir, join(originVault, symlinkDir));
	await checked("a symlinked subtree omitted by scans never becomes a remote delete", () => holdFor(
		() => !diagnosticFor(blind.deleteCandidates(), symlinkPath) && remoteEquals(requirePeer(), symlinkPath, symlinkText),
		`${symlinkPath} through symlink`,
		NEGATIVE_HOLD_MS,
	));
	await unlink(join(originVault, symlinkDir));
	await rename(storedDir, join(originVault, symlinkDir));

	const materializedPaths: string[] = [];
	for (let index = 0; index < 16; index++) {
		const path = `${DROP_MARKER}materialized-${String(index)}.md`;
		materializedPaths.push(path);
		await requirePeer().create(path, `remote materialization ${String(index)}\n`);
	}
	await checked("daemon materialization races never infer deletes for remote-created files", () => waitFor(
		async () => {
			for (let index = 0; index < materializedPaths.length; index++) {
				const path = materializedPaths[index];
				if (!path || await readIfExists(join(originVault, path)) !== `remote materialization ${String(index)}\n`) return false;
			}
			return materializedPaths.every((path) => !diagnosticFor(blind.deleteCandidates(), path));
		},
		() => `all remote materializations without candidates\n${blind.dump()}`,
		RECONCILE_MS,
	));
	await checked("materialized notes remain uncandidated across later scans", () => holdFor(
		() => materializedPaths.every((path) => !diagnosticFor(blind.deleteCandidates(), path)
			&& requirePeer().activePaths().has(path)),
		"remote materializations active and uncandidated",
		NEGATIVE_HOLD_MS,
	));

	s.section("slow-clock reconciliation deferral");
	await stopOrigin();
	const slow = await bootOrigin("slow-clock daemon", DROP_MARKER, SLOW_INTERVAL_MS);
	const slowPath = `${DROP_MARKER}slow-delete.md`;
	const slowText = "slow clock deletion\n";
	await writeFile(join(originVault, slowPath), slowText, "utf8");
	await waitFor(() => remoteEquals(requirePeer(), slowPath, slowText), `remote ${slowPath}`, SLOW_WAIT_MS);
	const deferralsBefore = slow.reconcileDeferrals().length;
	await rm(join(originVault, slowPath));
	await waitFor(() => diagnosticFor(slow.deleteCandidates(), slowPath), () => `slow candidate\n${slow.dump()}`, SLOW_WAIT_MS);
	await checked("slow clock defers reconciliation throughout the configured delete-review interval", () => holdFor(
		() => !diagnosticFor(slow.confirmedDeletes(), slowPath) && remoteEquals(requirePeer(), slowPath, slowText),
		`${slowPath} inside review window`,
		SLOW_HOLD_MS,
	));
	await checked("slow-clock delete eventually confirms instead of being resurrected", () => waitFor(
		() => !requirePeer().activePaths().has(slowPath),
		() => `remote delete ${slowPath}\n${slow.dump()}`,
		SLOW_WAIT_MS,
	));
	s.check(
		diagnosticFor(slow.reconcileDeferrals().slice(deferralsBefore), slowPath),
		"a reconcile due during slow delete review was observably deferred for that path",
	);
	await checked("slow-clock confirmed delete remains absent on disk", () => holdFor(
		async () => await readIfExists(join(originVault, slowPath)) === null,
		`${slowPath} absent on disk`,
		3_000,
	));

	s.section("serialized last-instant SIGTERM durability");
	const finalCreatePath = "last-instant-create.md";
	const finalCreateText = "created immediately before SIGTERM\n";
	const finalModifyPath = "last-instant-modify.md";
	const finalModifyV1 = "modify baseline\n";
	const finalModifyV2 = "modified immediately before SIGTERM\n";
	const finalDeletePath = "last-instant-delete.md";
	const finalDeleteText = "delete baseline\n";
	const finalAtomicPath = "last-instant-atomic.md";
	const finalAtomicV1 = "atomic shutdown baseline\n";
	const finalAtomicV2 = "atomic shutdown replacement\n";
	await writeFile(join(originVault, finalModifyPath), finalModifyV1, "utf8");
	await writeFile(join(originVault, finalDeletePath), finalDeleteText, "utf8");
	await writeFile(join(originVault, finalAtomicPath), finalAtomicV1, "utf8");
	await waitFor(
		async () => await remoteEquals(requirePeer(), finalModifyPath, finalModifyV1)
			&& await remoteEquals(requirePeer(), finalDeletePath, finalDeleteText)
			&& await remoteEquals(requirePeer(), finalAtomicPath, finalAtomicV1),
		"shutdown modify/delete/atomic baselines",
		SLOW_WAIT_MS,
	);
	const finalAtomicBodyId = requirePeer().activePaths().get(finalAtomicPath);
	if (finalAtomicBodyId === undefined) throw new Error("shutdown atomic baseline has no active body");
	await stopOrigin();

	const periodicBarrierFile = join(externalStore, "release-shutdown-periodic");
	await rm(periodicBarrierFile, { force: true });
	const shutdownDaemon = await bootOrigin(
		"shutdown barrier daemon",
		undefined,
		RECONCILE_INTERVAL_MS,
		periodicBarrierFile,
	);
	s.check(
		shutdownDaemon.declaredEnv.YAOS_TEST_ONLY_PERIODIC_RECONCILE_BARRIER === periodicBarrierFile,
		"the blocked-periodic shutdown fixture is explicitly armed",
	);
	await waitFor(
		() => shutdownDaemon.shutdownDiagnostics().some((line) => line.includes("periodic-reconcile-barrier-wait")),
		() => `periodic reconcile to enter its deterministic barrier\n${shutdownDaemon.dump()}`,
		RECONCILE_MS,
	);

	await writeFile(join(originVault, finalCreatePath), finalCreateText, "utf8");
	await writeFile(join(originVault, finalModifyPath), finalModifyV2, "utf8");
	const finalAtomicTemporary = join(originVault, ".last-instant-atomic.tmp");
	await writeFile(finalAtomicTemporary, finalAtomicV2, "utf8");
	await rm(join(originVault, finalDeletePath));
	await rm(join(originVault, finalAtomicPath));
	const shutdownExitPromise = shutdownDaemon.stop("SIGTERM");
	await waitFor(
		() => shutdownDaemon.shutdownDiagnostics().some((line) => line.includes("shutdown-awaiting-periodic-reconcile")),
		() => `shutdown to join the blocked periodic reconcile\n${shutdownDaemon.dump()}`,
		WATCH_MS,
	);
	s.check(
		shutdownDaemon.exitStatus() === null,
		"shutdown remains alive at the periodic barrier instead of racing teardown",
	);

	await writeFile(periodicBarrierFile, "release\n", "utf8");
	await waitFor(
		() => {
			const diagnostics = shutdownDaemon.shutdownDiagnostics();
			return diagnosticFor(diagnostics, `shutdown-delete-review path="${finalDeletePath}"`)
				&& diagnosticFor(diagnostics, `shutdown-delete-review path="${finalAtomicPath}"`);
		},
		() => `shutdown absence review for eventless delete and atomic replacement\n${shutdownDaemon.dump()}`,
		WATCH_MS,
	);
	s.check(
		shutdownDaemon.exitStatus() === null,
		"shutdown remains alive between its two positive absence snapshots",
	);
	await rename(finalAtomicTemporary, join(originVault, finalAtomicPath));

	const shutdownExit = await shutdownExitPromise;
	if (shutdownExit.code !== 0 || shutdownExit.signal !== null) {
		throw new Error(
			`barrier daemon shutdown failed code=${String(shutdownExit.code)} `
			+ `signal=${String(shutdownExit.signal)}\n${shutdownDaemon.dump()}`,
		);
	}
	originDaemon = null;

	const shutdownDiagnostics = shutdownDaemon.shutdownDiagnostics();
	const barrierReleased = shutdownDiagnostics.findIndex((line) => line.includes("periodic-reconcile-barrier-released"));
	const periodicJoined = shutdownDiagnostics.findIndex((line) => line.includes("shutdown-periodic-reconcile-joined"));
	const finalDrainStarted = shutdownDiagnostics.findIndex((line) => line.includes("shutdown-final-drain-start"));
	const finalDrainCompleted = shutdownDiagnostics.findIndex((line) => line.includes("shutdown-final-drain-complete"));
	const finalDeleteApplied = shutdownDiagnostics.findIndex(
		(line) => line.includes(`shutdown-delete path="${finalDeletePath}"`),
	);
	s.check(
		barrierReleased >= 0
			&& periodicJoined > barrierReleased
			&& finalDrainStarted > periodicJoined
			&& finalDrainCompleted > finalDrainStarted,
		"diagnostics prove periodic reconcile completed before the serialized final drain",
	);
	s.check(
		finalDeleteApplied > finalDrainStarted && finalDeleteApplied < finalDrainCompleted,
		"the eventless delete is applied inside the final drain",
	);
	s.check(
		!shutdownDiagnostics.some((line) => line.includes(`shutdown-delete path="${finalAtomicPath}"`)),
		"the atomic replacement is not falsely deleted during shutdown review",
	);
	await checked("last-instant create is durable after the daemon exits", () => waitFor(
		() => remoteEquals(requirePeer(), finalCreatePath, finalCreateText),
		`remote ${finalCreatePath} after process exit`,
		WATCH_MS,
	));
	await checked("last-instant existing-file modify is durable after the daemon exits", () => waitFor(
		() => remoteEquals(requirePeer(), finalModifyPath, finalModifyV2),
		`remote ${finalModifyPath} after process exit`,
		WATCH_MS,
	));
	await checked("last-instant eventless delete is durable after the daemon exits", () => waitFor(
		() => remoteEquals(requirePeer(), finalDeletePath, null),
		`remote deletion of ${finalDeletePath} after process exit`,
		WATCH_MS,
	));
	await checked("atomic replacement survives the shutdown absence review", () => waitFor(
		() => remoteEquals(requirePeer(), finalAtomicPath, finalAtomicV2),
		`remote atomic replacement ${finalAtomicPath} after process exit`,
		WATCH_MS,
	));
	s.check(
		requirePeer().activePaths().get(finalAtomicPath) === finalAtomicBodyId,
		"atomic replacement keeps its original body identity through shutdown",
	);
	const vaultFiles = await listVaultFiles(originVault);
	const localState = vaultFiles.filter((path) => {
		const name = basename(path);
		return name.startsWith("enrollment.json") || name.startsWith("client.sqlite")
			|| name === "daemon.lock" || name.startsWith(".yaos");
	});
	s.check(await readIfExists(join(originStateDir, "daemon.lock")) === null, "state-directory lock is released after clean SIGTERM");
	s.check(localState.length === 0, `no vault-local state or lock exists (${localState.join(", ") || "clean"})`);
	const stateMode = (await stat(originStateDir)).mode & 0o777;
	const enrollmentMode = (await stat(enrollmentPath)).mode & 0o777;
	const sqliteMode = (await stat(originSqlite)).mode & 0o777;
	s.check(stateMode === 0o700, `state directory mode is 0700 (actual ${stateMode.toString(8)})`);
	s.check(enrollmentMode === 0o600 && sqliteMode === 0o600, `credential and SQLite files are 0600 (${enrollmentMode.toString(8)}, ${sqliteMode.toString(8)})`);

	s.section("generation and revocation are terminal identity failures");
	const originalEnrollment = await readFile(enrollmentPath, "utf8");
	const tampered: unknown = JSON.parse(originalEnrollment);
	if (!replaceDeepString(tampered, ["vaultGeneration"], "invalid-generation-fence")) throw new Error("could not locate vaultGeneration in enrollment.json");
	await writeFile(enrollmentPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
	const generationMismatch = startDaemon({ vaultPath: originVault, vaultId: server.vaultId, xdgStateHome: xdgState });
	const generationExited = await checked(
		"a provisioning generation mismatch exits 2",
		() => expectExit(generationMismatch, 2, "generation mismatch"),
	);
	if (!generationExited && generationMismatch.exitStatus() === null) await generationMismatch.stop("SIGKILL");
	await writeFile(enrollmentPath, originalEnrollment, { mode: 0o600 });
	const revoked = await bootOrigin("revocation daemon");
	if (originIdentity === null) throw new Error("origin identity missing before revocation");
	await revokeDevice(server, originIdentity.deviceId);
	const revokedExited = await checked(
		"server-side device revocation terminates the daemon with exit 2",
		() => expectExit(revoked, 2, "revoked daemon"),
	);
	if (revokedExited) {
		s.check(revoked.readyLines().length === 1, "revoked daemon had announced readiness exactly once before terminal shutdown");
		originDaemon = null;
	}
} catch (error) {
	s.check(false, `headless harness aborted — ${headline(error)}`);
	console.error(describe(error));
	if (worker !== null) console.error(`\n[wrangler]\n${worker.output()}`);
} finally {
	s.section("teardown");
	peer?.close();
	const cleanupJoinDaemon = joinDaemon as Daemon | null;
	const cleanupOriginDaemon = originDaemon as Daemon | null;
	if (cleanupJoinDaemon !== null) await cleanupJoinDaemon.stop("SIGKILL");
	if (cleanupOriginDaemon !== null) await cleanupOriginDaemon.stop("SIGKILL");
	if (originVault) {
		const orphans = orphanPids(originVault);
		s.check(orphans.available && orphans.pids.length === 0, orphans.available
			? `no orphan daemon holds the vault (${orphans.pids.join(", ") || "none"})`
			: "orphan process check is available");
	}
	if (proxy !== null) await proxy.stop().catch(() => undefined);
	if (worker !== null) await worker.stop().catch(() => undefined);
	for (const path of [originVault, joiningVault, externalStore, xdgState]) {
		if (path) await rm(path, { recursive: true, force: true });
	}
}

await s.done();
