import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { build } from "esbuild";
import type { App as ObsidianApp, TFile as ObsidianFile } from "obsidian";
import type { AttachmentCatalogPort, BlobSyncManager as Manager } from "../../src/sync/blobSync";
import type { BlobRef } from "../../src/types";
import { suite } from "../harness.ts";

const s = suite("blob-integrity-repair");
type Request = { url: string; method: string; headers: Record<string, string>; body?: string | ArrayBuffer; contentType?: string; throw?: boolean };
type Response = { status: number; json: unknown; text: string; arrayBuffer: ArrayBuffer };
let transport: (request: Request) => Promise<Response>;
let notices: string[] = [];
const bundled = await build({
	stdin: {
		contents: 'export { BlobSyncManager } from "./src/sync/blobSync"; export { App, TFile, Platform } from "obsidian";',
		resolveDir: resolve("."),
	},
	bundle: true,
	write: false,
	platform: "node",
	format: "cjs",
	plugins: [{
		name: "repair-http-fixture",
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "repair-fixture" }));
			builder.onLoad({ filter: /.*/, namespace: "repair-fixture" }, () => ({
				contents: readFileSync(resolve("tests/mocks/obsidian.ts"), "utf8")
					.replace('throw new Error("requestUrl is not stubbed for this test");', "return __blobRepairRequest(_request);")
					.replace("constructor(_message: string, _timeout?: number) {}", "constructor(_message: string, _timeout?: number) { __blobRepairNotice(_message); }"),
				loader: "ts",
			}));
		},
	}],
});
const runtimeModule = { exports: {} };
new Function("module", "exports", "require", "__blobRepairRequest", "__blobRepairNotice", bundled.outputFiles[0]!.text)(
	runtimeModule, runtimeModule.exports, createRequire(import.meta.url),
	(request: Request) => transport(request), (message: string) => notices.push(message),
);
const { BlobSyncManager, App, TFile, Platform } = runtimeModule.exports as {
	BlobSyncManager: typeof import("../../src/sync/blobSync").BlobSyncManager;
	App: typeof import("obsidian").App;
	TFile: typeof import("obsidian").TFile;
	Platform: typeof import("obsidian").Platform;
};

function bytes(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

async function hash(data: ArrayBuffer): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
}

function response(status: number, json: unknown = {}, data = bytes("")): Response {
	return { status, json, text: String(status), arrayBuffer: data };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await nextTurn();
}

class Clock {
	now = 1_000;
	private nextId = 1;
	readonly timers = new Map<number, { callback: () => void; at: number }>();
	private originalSetTimeout = window.setTimeout;
	private originalClearTimeout = window.clearTimeout;
	private originalNow = Date.now;

	constructor() {
		window.setTimeout = ((callback: () => void, delay = 0) => {
			const id = this.nextId++;
			this.timers.set(id, { callback, at: this.now + delay });
			return id;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((id: number) => this.timers.delete(id)) as typeof window.clearTimeout;
		Date.now = () => this.now;
	}

	async advance(delay: number): Promise<void> {
		this.now += delay;
		for (const [id, timer] of Array.from(this.timers)) {
			if (timer.at > this.now) continue;
			this.timers.delete(id);
			timer.callback();
		}
		await settle();
	}

	restore(): void {
		window.setTimeout = this.originalSetTimeout;
		window.clearTimeout = this.originalClearTimeout;
		Date.now = this.originalNow;
	}
}

function fixture(maxAttachmentSizeKB = 1024) {
	const clock = new Clock();
	const originalRandom = Math.random;
	let random = 0.5;
	Math.random = () => random;
	notices = [];
	const refs = new Map<string, BlobRef>();
	const files = new Map<string, { file: ObsidianFile; data: ArrayBuffer }>();
	const tombstones = new Set<string>();
	const projected = new Map<string, ReturnType<AttachmentCatalogPort["getProjectedAttachmentHead"]>>();
	const requests: Request[] = [];
	const writes: string[] = [];
	const events: Array<{ message: string; details?: Record<string, unknown> }> = [];
	let publications = 0;
	let server: (request: Request) => Promise<Response> = async (request) => {
		if (request.url.endsWith("/exists")) return response(200, { present: [] });
		if (request.method === "PUT") return response(204);
		if (request.url.endsWith("/repair")) return response(200, { status: "suspect" });
		return response(200, {}, bytes("corrupt"));
	};
	transport = async (request) => {
		requests.push(request);
		return server(request);
	};
	const head: AttachmentCatalogPort["getObservedAttachmentHead"] = (path) => {
		const ref = refs.get(path);
		return ref ? { kind: "active", revision: ref.revision, hash: ref.hash, size: ref.size } : { kind: "missing", revision: null };
	};
	const catalog: AttachmentCatalogPort = {
		listAttachmentRefs: () => refs,
		getAttachmentRef: (path) => refs.get(path),
		getObservedAttachmentHead: head,
		getProjectedAttachmentHead: (path) => projected.get(path) ?? head(path),
		isAttachmentTombstoned: (path) => tombstones.has(path),
		setAttachmentRef: async () => { publications++; throw new Error("repair must not publish a catalog intent"); },
		deleteAttachmentRef: async () => { publications++; throw new Error("repair must not delete a reference"); },
		renameAttachmentRef: async () => { publications++; throw new Error("repair must not rename a reference"); },
		observeAttachmentChanges: () => () => {},
	};
	function put(path: string, data: ArrayBuffer): ObsidianFile {
		const file = Object.assign(new TFile(), { path, stat: { ctime: clock.now, mtime: clock.now, size: data.byteLength } });
		files.set(path, { file, data });
		return file;
	}
	const vault = {
		configDir: ".obsidian",
		getFiles: () => Array.from(files.values(), (entry) => entry.file),
		getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
		readBinary: async (file: ObsidianFile) => files.get(file.path)!.data,
		createFolder: async (path: string) => { writes.push(path); },
		createBinary: async (path: string, data: ArrayBuffer) => { writes.push(path); put(path, data); },
		modifyBinary: async (file: ObsidianFile, data: ArrayBuffer) => { writes.push(file.path); put(file.path, data); },
		adapter: { stat: async (path: string) => files.get(path)?.file.stat ?? null },
	};
	const manager = new BlobSyncManager(Object.assign(new App(), { vault }) as ObsidianApp, catalog, {
		host: "https://worker.example", deviceToken: "device-token", vaultId: "vault name",
		queueScope: { host: "https://worker.example", vaultId: "vault name", vaultGeneration: "generation", deviceId: "device", folderKey: "folder" },
		maxAttachmentSizeKB, attachmentConcurrency: 2, debug: false, excludePatterns: ["private/"],
	}, {}, (_source, message, details) => events.push({ message, details }));
	return {
		clock, manager, refs, files, tombstones, projected, requests, writes, events, vault, put,
		setRandom: (value: number) => { random = value; },
		publications: () => publications,
		serve: (handler: typeof server) => { server = handler; },
		close: () => { manager.destroy(); assert.equal(clock.timers.size, 0); clock.restore(); Math.random = originalRandom; Platform.isMobile = false; },
	};
}

type Fixture = ReturnType<typeof fixture>;

async function seed(fixture: Fixture, path: string, data = bytes("verified good"), local = false): Promise<string> {
	const digest = await hash(data);
	fixture.refs.set(path, { hash: digest, size: data.byteLength, revision: `revision:${path}` });
	if (local) fixture.put(path, data);
	return digest;
}

async function attempt(manager: Manager, path: string): Promise<void> {
	const ref = manager["attachmentCatalog"].getAttachmentRef(path)!;
	if (!manager["downloadQueue"].has(path)) manager["enqueueDownload"](path, ref.hash, ref.size);
	const item = manager["downloadQueue"].get(path)!;
	item.status = "processing";
	await manager["processDownload"](item);
}

s.test("second verified mismatch reports once with authenticated empty POST; corrupt bytes never write", async () => {
	const fixture = fixtureFactory();
	try {
		const digest = await seed(fixture, "attachments/target.bin");
		await attempt(fixture.manager, "attachments/target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 0);
		await attempt(fixture.manager, "attachments/target.bin");
		await attempt(fixture.manager, "attachments/target.bin");
		const reports = fixture.requests.filter((request) => request.url.endsWith("/repair"));
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.url, `https://worker.example/vault/vault%20name/blobs/${digest}/repair`);
		assert.equal(reports[0]!.method, "POST");
		assert.equal(reports[0]!.headers.Authorization, "Bearer device-token");
		assert.equal(reports[0]!.body, undefined);
		assert.equal(reports[0]!.contentType, undefined);
		assert.deepEqual(fixture.writes, []);
		assert.equal(fixture.publications(), 0);
	} finally { fixture.close(); }
});

const fixtureFactory = fixture;

s.test("network errors never report and do not count toward mismatch threshold", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		fixture.serve(async () => { throw new Error("offline"); });
		await attempt(fixture.manager, "target.bin");
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.manager["repairReports"].size, 0);
		fixture.serve(async () => response(200, {}, bytes("corrupt")));
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 0);
	} finally { fixture.close(); }
});

s.test("concurrent paths coalesce one in-flight report for the same hash", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "first.bin");
		await seed(fixture, "second.bin");
		let finish!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => { finish = resolve; });
		fixture.serve(async (request) => request.url.endsWith("/repair") ? pending : request.url.endsWith("/exists")
			? response(200, { present: [fixture.refs.get("first.bin")!.hash] }) : response(200, {}, bytes("corrupt")));
		await attempt(fixture.manager, "first.bin");
		const first = attempt(fixture.manager, "first.bin");
		const second = attempt(fixture.manager, "second.bin");
		await settle();
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 1);
		finish(response(200, { status: "suspect" }));
		await Promise.all([first, second]);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("verified /exists present never uploads, publishes, or trusts corrupt downloads", async () => {
		const fixture = fixtureFactory();
		try {
			await seed(fixture, "target.bin");
			await seed(fixture, "source.bin", bytes("verified good"), true);
			fixture.serve(async (request) => request.url.endsWith("/repair") ? response(200, { status: "suspect" })
				: request.url.endsWith("/exists") ? response(200, { present: [fixture.refs.get("target.bin")!.hash] })
					: response(200, {}, bytes("corrupt")));
			for (let index = 0; index < 4; index++) await attempt(fixture.manager, "target.bin");
			assert.equal(fixture.requests.filter((request) => request.method === "PUT" || request.method === "DELETE").length, 0);
			assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 1);
			assert.equal(fixture.publications(), 0);
			assert.deepEqual(fixture.writes, []);
			assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAware, true);
		} finally { fixture.close(); }
	});

	s.test("verified /exists absence reuploads freshly verified local bytes then download succeeds", async () => {
		const fixture = fixtureFactory();
		try {
			const good = bytes("verified good");
			const digest = await seed(fixture, "target.bin", good);
			await seed(fixture, "source.bin", good, true);
			let recovered = false;
			fixture.serve(async (request) => {
				if (request.url.endsWith("/repair")) return response(200, { status: "missing" });
				if (request.url.endsWith("/exists")) return response(200, { present: [] });
				if (request.method === "PUT") {
					assert.equal(await hash(request.body as ArrayBuffer), digest);
					recovered = true;
					return response(204);
				}
				return response(200, {}, recovered ? good : bytes("corrupt"));
			});
			await attempt(fixture.manager, "target.bin");
			await attempt(fixture.manager, "target.bin");
			assert.equal(recovered, true);
			assert.deepEqual(fixture.writes, []);
			assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.status, "pending");
			await fixture.clock.advance(4_000);
			fixture.manager.openDownloadGate("test");
			await settle();
			assert.equal(await hash(fixture.files.get("target.bin")!.data), digest);
			assert.equal(fixture.manager["downloadQueue"].size, 0);
			assert.equal(fixture.publications(), 0);
		} finally { fixture.close(); }
	});

s.test("no good source retains repair-aware normal queue, caps retries, and resists reconcile churn", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		fixture.manager["enqueueDownload"]("target.bin", fixture.refs.get("target.bin")!.hash);
		fixture.manager.openDownloadGate("test");
		await settle();
		for (let retry = 0; retry < 8; retry++) await fixture.clock.advance(60_000);
		const item = fixture.manager["downloadQueue"].get("target.bin")!;
		assert.equal(item.repairAware, true);
		assert.equal(item.status, "pending");
		assert.equal(item.retries, 7);
		assert.ok(item.readyAt > fixture.clock.now);
		assert.equal(item.repairAwaitingSource, true);
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 8);
		assert.ok(fixture.requests.filter((request) => request.url.endsWith("/repair")).length >= 1);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		await fixture.clock.advance(100);
		assert.match(notices[0]!, /verified copy online.*retry periodically/);
		fixture.manager.reconcile("conservative", []);
		await settle();
		await fixture.clock.advance(1_000);
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 8);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin"), item);
		assert.deepEqual(fixture.writes, []);
		const snapshot = fixture.manager.exportQueue();
		assert.equal(snapshot.downloads[0]?.repairAware, true);
		assert.equal(snapshot.downloads[0]?.retries, 7);
		assert.equal(fixture.manager["_permanentDownloadFailures"], 0);
		fixture.serve(async () => response(200, {}, bytes("verified good")));
		await fixture.clock.advance(300_000);
		assert.equal(fixture.manager["downloadQueue"].size, 0);
		assert.equal(await hash(fixture.files.get("target.bin")!.data), fixture.refs.get("target.bin")!.hash);
	} finally { fixture.close(); }
});

s.test("missing report cannot authorize upload when /exists verifies the object", async () => {
	const fixture = fixtureFactory();
	try {
		const digest = await seed(fixture, "target.bin");
		await seed(fixture, "source.bin", bytes("verified good"), true);
		fixture.serve(async (request) => request.url.endsWith("/repair")
			? response(200, { status: "missing" }) : request.url.endsWith("/exists")
				? response(200, { present: [digest] }) : response(200, {}, bytes("corrupt")));
		await attempt(fixture.manager, "target.bin");
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAwaitingSource, false);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("advisory report statuses all defer to /exists validity", async () => {
	for (const status of ["healthy", "suspect", "missing", "changed", "busy"]) {
		const fixture = fixtureFactory();
		try {
			const digest = await seed(fixture, "target.bin");
			await seed(fixture, "source.bin", bytes("verified good"), true);
			fixture.serve(async (request) => request.url.endsWith("/repair")
				? response(200, { status }) : request.url.endsWith("/exists")
					? response(200, { present: [digest] }) : response(200, {}, bytes("corrupt")));
			await attempt(fixture.manager, "target.bin");
			await attempt(fixture.manager, "target.bin");
			assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0, status);
			assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAwaitingSource, false, status);
		} finally { fixture.close(); }
	}
});

s.test("GET 404 does not reupload while /exists verifies the object", async () => {
	const fixture = fixtureFactory();
	try {
		const digest = await seed(fixture, "target.bin");
		await seed(fixture, "source.bin", bytes("verified good"), true);
		fixture.serve(async (request) => request.url.endsWith("/exists")
			? response(200, { present: [digest] }) : response(404));
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAwaitingSource, false);
	} finally { fixture.close(); }
});

for (const unavailable of [404, 503, "offline", "invalid"]) {
	s.test(`repair ${unavailable} retains bounded periodic recovery without upload`, async () => {
		const fixture = fixtureFactory();
		try {
			await seed(fixture, "target.bin");
			fixture.serve(async (request) => {
				if (!request.url.endsWith("/repair")) return response(200, {}, bytes("corrupt"));
				if (unavailable === "offline") throw new Error("offline");
				if (unavailable === "invalid") return response(400);
				return response(unavailable as number);
			});
			for (let retry = 0; retry < 8; retry++) await attempt(fixture.manager, "target.bin");
			assert.ok(fixture.requests.filter((request) => request.url.endsWith("/repair")).length >= 1);
			assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
			const item = fixture.manager["downloadQueue"].get("target.bin")!;
			assert.equal(item.repairAware, true);
			assert.equal(item.repairAwaitingSource, undefined);
			assert.equal(item.readyAt, fixture.clock.now + 300_000);
			assert.equal(fixture.manager["_permanentDownloadFailures"], 0);
			await fixture.clock.advance(100);
			assert.match(notices[0]!, /Check the server and connection.*retry periodically/);
			assert.deepEqual(fixture.writes, []);
		} finally { fixture.close(); }
	});
}

s.test("own GET 404 recovers from a good local catalog replica without reporting corruption", async () => {
	const fixture = fixtureFactory();
	try {
		const good = bytes("verified good");
		await seed(fixture, "target.bin", good);
		await seed(fixture, "source.bin", good, true);
		let recovered = false;
		fixture.serve(async (request) => {
			if (request.url.endsWith("/exists")) return response(200, { present: [] });
			if (request.method === "PUT") { recovered = true; return response(204); }
			return recovered ? response(200, {}, good) : response(404);
		});
		await attempt(fixture.manager, "target.bin");
		assert.equal(recovered, true);
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 0);
		assert.equal(await hash(fixture.files.get("target.bin")!.data), await hash(good));
		assert.equal(fixture.publications(), 0);
	} finally { fixture.close(); }
});

s.test("good devices audit on initial reconcile and every five minutes even when downloads skip disk", async () => {
	const fixture = fixtureFactory();
	try {
		const digest = await seed(fixture, "source.bin", bytes("verified good"), true);
		fixture.serve(async (request) => request.url.endsWith("/exists") ? response(200, { present: [] }) : response(204));
		fixture.manager.reconcile("conservative", []);
		await settle();
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 1);
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 0);
		assert.equal(await hash(fixture.requests.find((request) => request.method === "PUT")!.body as ArrayBuffer), digest);
		await fixture.clock.advance(299_999);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 1);
		await fixture.clock.advance(1);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 2);
		assert.equal(fixture.clock.timers.size, 1);
		assert.equal(fixture.publications(), 0);
		fixture.manager.destroy();
		await fixture.clock.advance(600_000);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 2);
	} finally { fixture.close(); }
});

s.test("audit batches at most 50 hashes, rotates, and ignores present objects", async () => {
	const fixture = fixtureFactory();
	try {
		for (let index = 0; index < 65; index++) await seed(fixture, `source-${index}.bin`, bytes(`good-${index}`), true);
		fixture.serve(async (request) => {
			const hashes = JSON.parse(request.body as string).hashes as string[];
			return response(200, { present: hashes });
		});
		await fixture.manager["auditMissingBlobs"]();
		await fixture.clock.advance(300_000);
		const batches = fixture.requests.map((request) => JSON.parse(request.body as string).hashes as string[]);
		assert.deepEqual(batches.map((batch) => batch.length), [50, 50]);
		assert.equal(new Set(batches.flat()).size, 65);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.equal(fixture.clock.timers.size, 1);
	} finally { fixture.close(); }
});

s.test("audit starts at a random cursor and staggers the next pass", async () => {
	const fixture = fixtureFactory();
	try {
		for (let index = 0; index < 4; index++) await seed(fixture, `source-${index}.bin`, bytes(`good-${index}`), true);
		fixture.setRandom(0.75);
		fixture.serve(async (request) => response(200, { present: JSON.parse(request.body as string).hashes }));
		await fixture.manager["auditMissingBlobs"]();
		const first = JSON.parse(fixture.requests[0]!.body as string).hashes as string[];
		assert.equal(first[0], fixture.refs.get("source-3.bin")!.hash);
		assert.equal(Array.from(fixture.clock.timers.values())[0]!.at - fixture.clock.now, 330_000);
		await fixture.clock.advance(329_999);
		assert.equal(fixture.requests.length, 1);
		await fixture.clock.advance(1);
		assert.equal(fixture.requests.length, 2);
	} finally { fixture.close(); }
});

s.test("audit indexes once, enforces byte budget, and continues after one hash fails", async () => {
	const fixture = fixtureFactory(8192);
	try {
		fixture.setRandom(0);
		for (let index = 0; index < 3; index++) {
			const data = new Uint8Array(8 * 1024 * 1024);
			data.fill(index + 1);
			await seed(fixture, `source-${index}.bin`, data.buffer, true);
		}
		let scans = 0;
		const getFiles = fixture.vault.getFiles;
		fixture.vault.getFiles = () => { scans++; return getFiles(); };
		fixture.serve(async (request) => request.url.endsWith("/exists") ? response(200, { present: [] })
			: request.url.includes(`/${fixture.refs.get("source-0.bin")!.hash}`) ? response(503) : response(204));
		await fixture.manager["auditMissingBlobs"]();
		assert.equal(scans, 1);
		assert.deepEqual(fixture.requests.filter((request) => request.method === "PUT").map((request) =>
			request.url.split("/").pop()), [fixture.refs.get("source-0.bin")!.hash, fixture.refs.get("source-1.bin")!.hash]);
		assert.equal(fixture.clock.timers.size, 1);
	} finally { fixture.close(); }
});

s.test("mobile audit limits probes and upload bytes", async () => {
	const fixture = fixtureFactory(8192);
	try {
		Platform.isMobile = true;
		fixture.setRandom(0);
		for (let index = 0; index < 12; index++) {
			const data = new Uint8Array(2 * 1024 * 1024);
			data.fill(index + 1);
			await seed(fixture, `source-${index}.bin`, data.buffer, true);
		}
		await fixture.manager["auditMissingBlobs"]();
		assert.equal((JSON.parse(fixture.requests[0]!.body as string).hashes as string[]).length, 10);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 5);
	} finally { fixture.close(); }
});

s.test("concurrent exhausted transfers show one notice without losing single-path detail", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "first.bin", bytes("first"));
		await seed(fixture, "second.bin", bytes("second"));
		fixture.serve(async () => { throw new Error("offline"); });
		for (let retry = 0; retry < 4; retry++) {
			await attempt(fixture.manager, "first.bin");
			await attempt(fixture.manager, "second.bin");
		}
		assert.equal(notices.length, 0);
		await fixture.clock.advance(100);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /2 attachment transfers waiting/);
		assert.equal(fixture.manager["downloadQueue"].size, 2);
	} finally { fixture.close(); }
});

s.test("fresh hashing and authority/path safeguards exclude corrupt, unreferenced and protected sources", async () => {
	const fixture = fixtureFactory();
	try {
		const good = bytes("verified good");
		const digest = await seed(fixture, "corrupt.bin", good, true);
		fixture.files.get("corrupt.bin")!.data = bytes("wrong local!!");
		const corrupt = fixture.files.get("corrupt.bin")!.file;
		fixture.manager["hashCache"]["corrupt.bin"] = { hash: digest, mtime: corrupt.stat.mtime, size: corrupt.stat.size };
		fixture.put("unreferenced.bin", good);
		for (const path of ["private/secret.bin", ".obsidian/secret.bin", "../escape.bin", "deleted.bin", "unresolved.bin", "projected.bin", "local-artifact.bin"]) {
			await seed(fixture, path, good, true);
		}
		fixture.tombstones.add("deleted.bin");
		fixture.manager["preservedUnresolved"].record({ path: "unresolved.bin", kind: "blob", reason: "unknown", knownRemoteHash: digest });
		fixture.projected.set("projected.bin", { kind: "missing", revision: null });
		fixture.manager["localOnlyBlobConflictPaths"].add("local-artifact.bin");
		assert.equal(await fixture.manager["reuploadGoodLocalBlob"](digest), false);
		await fixture.manager["auditMissingBlobs"]();
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.equal(fixture.publications(), 0);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("source deleted or changed while hashing is not reuploaded", async () => {
	for (const mutation of ["delete", "revision", "disk", "stop"]) {
		const fixture = fixtureFactory();
		try {
			const digest = await seed(fixture, "source.bin", bytes("verified good"), true);
			const original = fixture.vault.readBinary;
			fixture.vault.readBinary = async (file) => {
				const data = await original(file);
				if (mutation === "delete") fixture.tombstones.add(file.path);
				if (mutation === "revision") fixture.refs.set(file.path, { ...fixture.refs.get(file.path)!, revision: "new" });
				if (mutation === "disk") fixture.put(file.path, bytes("changed disk"));
				if (mutation === "stop") fixture.manager.destroy();
				return data;
			};
			assert.equal(await fixture.manager["reuploadGoodLocalBlob"](digest), false);
			assert.equal(fixture.requests.length, 0);
		} finally { fixture.close(); }
	}
});

s.test("rejected stale upload snapshot re-reads, re-hashes, and publishes only the new bytes", async () => {
	const fixture = fixtureFactory();
	try {
		const path = "changed.bin";
		const original = bytes("old bytes");
		const replacement = bytes("new bytes");
		const originalHash = await hash(original);
		const replacementHash = await hash(replacement);
		const stored = fixture.put(path, original);
		const uploaded: string[] = [];
		const published: string[] = [];
		fixture.manager["attachmentCatalog"].setAttachmentRef = async (_path, digest) => {
			published.push(digest);
			return { kind: "committed", revision: "fresh" };
		};
		fixture.serve(async (request) => {
			if (request.url.endsWith("/exists")) return response(200, { present: [] });
			if (request.method !== "PUT") throw new Error("unexpected request");
			uploaded.push(await hash(request.body as ArrayBuffer));
			if (uploaded.length === 1) {
				new Uint8Array(original).set(new Uint8Array(replacement));
				fixture.files.get(path)!.data = original;
				return { ...response(400), text: "hash mismatch" };
			}
			return response(204);
		});
		fixture.manager["enqueueUpload"](path);
		const item = fixture.manager["uploadQueue"].get(path)!;
		item.status = "processing";
		await fixture.manager["processUpload"](item);
		await settle();
		assert.equal(stored.stat.mtime, fixture.files.get(path)!.file.stat.mtime);
		assert.deepEqual(uploaded, [originalHash, replacementHash]);
		assert.deepEqual(published, [replacementHash]);
		assert.equal(fixture.manager["uploadQueue"].size, 0);
	} finally { fixture.close(); }
});

s.test("repeated checksum rejection keeps a visible, durable upload intent", async () => {
	const fixture = fixtureFactory();
	try {
		fixture.put("unstable.bin", bytes("persistent bytes"));
		fixture.serve(async (request) => request.url.endsWith("/exists")
			? response(200, { present: [] })
			: { ...response(400), text: "hash mismatch" });
		fixture.manager["enqueueUpload"]("unstable.bin");
		const item = fixture.manager["uploadQueue"].get("unstable.bin")!;
		item.retries = 3;
		item.status = "processing";
		await fixture.manager["processUpload"](item);
		const pending = fixture.manager["uploadQueue"].get("unstable.bin")!;
		assert.ok(pending);
		assert.equal(pending.integrityPaused, true);
		assert.ok(pending.readyAt >= fixture.clock.now + 5 * 60_000);
		assert.equal(fixture.manager.exportQueue().uploads[0]?.integrityPaused, true);
		await fixture.clock.advance(100);
		assert.equal(notices.filter((message) => message.includes("checksum")).length, 1);
		assert.equal(fixture.publications(), 0);
		await fixture.clock.advance(5 * 60_000);
		assert.ok(fixture.manager["uploadQueue"].has("unstable.bin"));
		assert.equal(notices.filter((message) => message.includes("checksum")).length, 1);
	} finally { fixture.close(); }
});

s.test("audit offline failure backs off with one timer; destroy during audit prevents uploads and rescheduling", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "source.bin", bytes("verified good"), true);
		fixture.serve(async () => { throw new Error("offline"); });
		await fixture.manager["auditMissingBlobs"]();
		assert.equal(fixture.requests.length, 1);
		assert.equal(fixture.clock.timers.size, 1);
		let finish!: (value: Response) => void;
		fixture.serve(() => new Promise<Response>((resolve) => { finish = resolve; }));
		const running = fixture.manager["auditMissingBlobs"]();
		await settle();
		fixture.manager.destroy();
		finish(response(200, { present: [] }));
		await running;
		assert.equal(fixture.clock.timers.size, 0);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
	} finally { fixture.close(); }
});

s.test("destroy during repair prevents local reupload and all retry timers", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		await seed(fixture, "source.bin", bytes("verified good"), true);
		let finish!: (value: Response) => void;
		fixture.serve(async (request) => request.url.endsWith("/repair")
			? new Promise<Response>((resolve) => { finish = resolve; }) : response(200, {}, bytes("corrupt")));
		await attempt(fixture.manager, "target.bin");
		const pending = attempt(fixture.manager, "target.bin");
		await settle();
		fixture.manager.destroy();
		finish(response(200, { status: "missing" }));
		await pending;
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.equal(fixture.manager["downloadQueue"].size, 0);
		assert.equal(fixture.clock.timers.size, 0);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("missing without a local source probes at audit cadence until another device reuploads", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		fixture.serve(async () => response(404));
		fixture.manager["enqueueDownload"]("target.bin", fixture.refs.get("target.bin")!.hash);
		fixture.manager.openDownloadGate("test");
		await settle();
		for (let retry = 0; retry < 7; retry++) await fixture.clock.advance(60_000);
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 8);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAwaitingSource, true);
		await fixture.clock.advance(300_000);
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 9);
		fixture.manager.reconcile("conservative", []);
		await settle();
		assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 9);
		assert.equal(notices.length, 1);
		assert.equal(fixture.manager["_permanentDownloadFailures"], 0);
		fixture.serve(async () => response(200, {}, bytes("verified good")));
		await fixture.clock.advance(300_000);
		assert.equal(fixture.manager["downloadQueue"].size, 0);
		assert.equal(await hash(fixture.files.get("target.bin")!.data), fixture.refs.get("target.bin")!.hash);
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 0);
	} finally { fixture.close(); }
});

s.test("pure offline downloads wait and recover without alleging corruption", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		fixture.serve(async () => { throw new Error("offline"); });
		fixture.manager["enqueueDownload"]("target.bin", fixture.refs.get("target.bin")!.hash);
		fixture.manager.openDownloadGate("test");
		await settle();
		for (let retry = 0; retry < 4; retry++) await fixture.clock.advance(60_000);
		assert.equal(fixture.requests.length, 4);
		assert.equal(fixture.manager["downloadQueue"].size, 1);
		assert.equal(fixture.manager["repairReports"].size, 0);
		assert.equal(notices.length, 1);
		assert.equal(fixture.manager["_permanentDownloadFailures"], 0);
		fixture.serve(async () => response(200, {}, bytes("verified good")));
		await fixture.clock.advance(300_000);
		assert.equal(fixture.manager["downloadQueue"].size, 0);
	} finally { fixture.close(); }
});

s.test("queue snapshots preserve waiting-source ownership and lifecycle quiesce cancels the audit", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		fixture.serve(async () => response(404));
		await attempt(fixture.manager, "target.bin");
		const snapshot = fixture.manager.exportQueue();
		fixture.manager["downloadQueue"].clear();
		fixture.manager.importQueue(snapshot);
		const item = fixture.manager["downloadQueue"].get("target.bin")!;
		assert.equal(item.repairAwaitingSource, true);
		assert.equal(item.repairAware, true);
		assert.equal(item.retries, 1);
		fixture.manager.quiesce();
		assert.equal(fixture.clock.timers.size, 0);
		const count = fixture.requests.length;
		await fixture.clock.advance(600_000);
		assert.equal(fixture.requests.length, count);
	} finally { fixture.close(); }
});

s.test("hash change during a download does not report the replacement hash as corrupt", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		const replacement = bytes("replacement bytes");
		const replacementHash = await hash(replacement);
		fixture.serve(async () => {
			fixture.refs.set("target.bin", { hash: replacementHash, size: replacement.byteLength, revision: "replacement" });
			fixture.manager["enqueueDownload"]("target.bin", replacementHash, replacement.byteLength);
			return response(200, {}, bytes("corrupt"));
		});
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.manager["repairReports"].size, 0);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.hash, replacementHash);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.retries, 0);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("explicit recovery can retry a repair-paused item immediately without another report", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		await attempt(fixture.manager, "target.bin");
		await attempt(fixture.manager, "target.bin");
		const item = fixture.manager["downloadQueue"].get("target.bin")!;
		item.retries = 7;
		item.readyAt = Number.MAX_SAFE_INTEGER;
		item.repairPaused = true;
		fixture.serve(async () => response(200, {}, bytes("verified good")));
		assert.equal(await fixture.manager.forceDownloads(["target.bin"]), 1);
		assert.equal(fixture.manager["downloadQueue"].size, 0);
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 1);
		assert.equal(await hash(fixture.files.get("target.bin")!.data), fixture.refs.get("target.bin")!.hash);
	} finally { fixture.close(); }
});

for (const initial of ["suspect", 503, "offline"] as const) {
	s.test(`${initial} re-reports after cooldown and recovers when /exists turns absent`, async () => {
		const fixture = fixtureFactory();
		try {
			const good = bytes("verified good");
			const digest = await seed(fixture, "target.bin", good);
			await seed(fixture, "source.bin", good, true);
			const reportTimes: number[] = [];
			let recovered = false;
			fixture.serve(async (request) => {
				if (request.url.endsWith("/exists")) return response(200, { present: reportTimes.length > 1 ? [] : [digest] });
				if (request.url.endsWith("/repair")) {
					reportTimes.push(fixture.clock.now);
					if (reportTimes.length > 1) return response(200, { status: "missing" });
					if (initial === "offline") throw new Error("report connection failed");
					return typeof initial === "number" ? response(initial) : response(200, { status: initial });
				}
				if (request.method === "PUT") {
					assert.equal(await hash(request.body as ArrayBuffer), digest);
					recovered = true;
					return response(204);
				}
				return response(200, {}, recovered ? good : bytes("corrupt"));
			});
			await attempt(fixture.manager, "target.bin");
			await attempt(fixture.manager, "target.bin");
			await attempt(fixture.manager, "target.bin");
			assert.equal(reportTimes.length, 1);
			assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAware, true);
			assert.notEqual(fixture.manager["downloadQueue"].get("target.bin")?.repairAwaitingSource, true);
			await fixture.clock.advance(299_999);
			await attempt(fixture.manager, "target.bin");
			assert.equal(reportTimes.length, 1);
			assert.equal(recovered, false);
			await fixture.clock.advance(1);
			assert.equal(reportTimes.length, 1);
			fixture.manager.openDownloadGate("test");
			await fixture.clock.advance(60_000);
			assert.equal(reportTimes.length, 2);
			assert.ok(reportTimes[1]! - reportTimes[0]! >= 300_000);
			assert.equal(recovered, true);
			await fixture.clock.advance(60_000);
			assert.equal(fixture.manager["downloadQueue"].size, 0);
			assert.equal(await hash(fixture.files.get("target.bin")!.data), digest);
			assert.equal(fixture.publications(), 0);
		} finally { fixture.close(); }
	});
}

s.test("failed reports retry only on a fresh verified mismatch, not GET 404 or network errors", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		let downloadStatus: number | "offline" = 200;
		let reports = 0;
		fixture.serve(async (request) => {
			if (request.url.endsWith("/repair")) {
				reports++;
				if (reports === 1) throw new Error("report connection failed");
				return response(200, { status: "suspect" });
			}
			if (request.url.endsWith("/exists")) return response(200, { present: [fixture.refs.get("target.bin")!.hash] });
			if (downloadStatus === "offline") throw new Error("download connection failed");
			return response(downloadStatus, {}, bytes("corrupt"));
		});
		await attempt(fixture.manager, "target.bin");
		await attempt(fixture.manager, "target.bin");
		await fixture.clock.advance(300_000);
		downloadStatus = 404;
		await attempt(fixture.manager, "target.bin");
		downloadStatus = "offline";
		await attempt(fixture.manager, "target.bin");
		assert.equal(reports, 1);
		downloadStatus = 200;
		await attempt(fixture.manager, "target.bin");
		assert.equal(reports, 2);
		assert.equal(fixture.manager["downloadQueue"].get("target.bin")?.repairAware, true);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("suspect report is coalesced within cooldown and repeats after cooldown", async () => {
	const fixture = fixtureFactory();
	try {
		await seed(fixture, "target.bin");
		let corrupt = bytes("corrupt");
		fixture.serve(async (request) => request.url.endsWith("/repair")
			? response(200, { status: "suspect" }) : request.url.endsWith("/exists")
				? response(200, { present: [fixture.refs.get("target.bin")!.hash] }) : response(200, {}, corrupt));
		await attempt(fixture.manager, "target.bin");
		await attempt(fixture.manager, "target.bin");
		await fixture.clock.advance(300_000);
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 2);
		corrupt = bytes("different corrupt body");
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 2);
		await attempt(fixture.manager, "target.bin");
		assert.equal(fixture.requests.filter((request) => request.url.endsWith("/repair")).length, 2);
		assert.equal(fixture.requests.filter((request) => request.method === "PUT").length, 0);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

s.test("repair LRU admits new hashes at capacity without evicting or duplicating an in-flight report", async () => {
	const fixture = fixtureFactory();
	try {
		const pendingHash = await seed(fixture, "pending.bin");
		const newHash = await seed(fixture, "new.bin", bytes("another verified body"));
		for (let index = 0; index < 511; index++) {
			fixture.manager["repairReports"].set(`completed:${index}`, {
				mismatches: 2, reporting: false, retryAt: 0, report: Promise.resolve(true),
			});
		}
		let finish!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => { finish = resolve; });
		fixture.serve(async (request) => request.url.endsWith(`/${pendingHash}/repair`)
			? pending : request.url.endsWith("/repair") ? response(200, { status: "suspect" })
				: request.url.endsWith("/exists") ? response(200, { present: [newHash, pendingHash] }) : response(200, {}, bytes("corrupt")));
		await attempt(fixture.manager, "pending.bin");
		const first = attempt(fixture.manager, "pending.bin");
		await settle();
		const state = fixture.manager["repairReports"].get(pendingHash)!;
		assert.equal(state.reporting, true);
		await attempt(fixture.manager, "new.bin");
		await attempt(fixture.manager, "new.bin");
		assert.equal(fixture.manager["repairReports"].size, 512);
		assert.equal(fixture.manager["repairReports"].has("completed:0"), false);
		assert.equal(fixture.manager["repairReports"].get(pendingHash), state);
		assert.equal(fixture.requests.filter((request) => request.url.endsWith(`/${newHash}/repair`)).length, 1);
		const second = attempt(fixture.manager, "pending.bin");
		await settle();
		assert.equal(fixture.requests.filter((request) => request.url.endsWith(`/${pendingHash}/repair`)).length, 1);
		finish(response(200, { status: "suspect" }));
		await Promise.all([first, second]);
		assert.equal(fixture.manager["repairReports"].size, 512);
		assert.deepEqual(fixture.writes, []);
	} finally { fixture.close(); }
});

for (const initial of ["suspect", 503] as const) {
	s.test(`${initial} exhausted retries wake through the audit even without any local source`, async () => {
		const fixture = fixtureFactory();
		try {
			const digest = await seed(fixture, "target.bin");
			let reports = 0;
			let recovered = false;
			fixture.serve(async (request) => {
				if (request.url.endsWith("/repair")) {
					reports++;
					if (reports > 1) return response(200, { status: "missing" });
					return typeof initial === "number" ? response(initial) : response(200, { status: initial });
				}
				if (request.url.endsWith("/exists")) return response(200, { present: reports > 1 ? [] : [digest] });
				return response(200, {}, recovered ? bytes("verified good") : bytes("corrupt"));
			});
			for (let retry = 0; retry < 8; retry++) await attempt(fixture.manager, "target.bin");
			const item = fixture.manager["downloadQueue"].get("target.bin")!;
			assert.equal(item.retries, 7);
			assert.equal(item.repairPaused, true);
			assert.notEqual(item.repairAwaitingSource, true);
			assert.equal(reports, 1);
			fixture.manager.openDownloadGate("test");
			await fixture.clock.advance(300_000);
			assert.equal(reports, 2);
			assert.equal(item.repairAwaitingSource, true);
			assert.equal(item.readyAt, fixture.clock.now + 300_000);
			recovered = true;
			await fixture.clock.advance(300_000);
			assert.equal(fixture.manager["downloadQueue"].size, 0);
			assert.equal(await hash(fixture.files.get("target.bin")!.data), digest);
			assert.equal(fixture.manager["_permanentDownloadFailures"], 0);
			assert.equal(reports, 2);
		} finally { fixture.close(); }
	});
}

await s.done();
