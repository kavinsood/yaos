/**
 * Lone-edit latency for the full-client e2e (fullClients.ts). Each run onboards its own vault with three full
 * clients a, b, c (b has the typing note open in a bound editor, c does not) and measures one edit at a time:
 * before each edit the clients are converged and the relay has had no commit for longer than its
 * groupCommit.quietMs (read from VAULT_READY) plus MARGIN_MS, seen on the wire (wireTap.ts quiet()). The edit's
 * first frame then opens an empty buffer and takes the leading-edge commit, so a lone sample shows what one
 * edit costs, not where it fell in the relay's 1 s minimum interval (back-to-back edits: the sustained_* series
 * of fullScenarios1.ts).
 *
 * Every sample (one per peer) is split at its critical frame (wireTap.ts breakdown()):
 *   sender   local change -> the APPEND of the last frame the peer needed, on a's socket
 *   relay    that APPEND -> its COMMITTED / COMMIT_NOTICE on the peer (PROVISIONAL for b's open editor)
 *   receiver that arrival -> bytes on the peer's disk (its engine's vault write) or in its open view
 * Metrics: <prefix>_<what>_to_peer_ms and _sender_ms / _relay_ms / _receiver_ms. With e2ee the vault is suite 1
 * through the real plugin controller (a enables encryption, b and c install the key by QR, as e2ee.ts); without,
 * suite 0 (the fixture pin).
 *
 * Last, edits made while a uploads a 90 MB attachment (its PUT seen in flight on a's NetSwitch.puts):
 * disk_edit_during_upload (an external write of a note no editor has open) and typing_during_upload (typing into
 * a note open on a; b and c have it closed, so the sample ends on their disk). <prefix>_during_upload in the
 * results holds, per sample, the PUT's duration and whether it was still in flight when the edit arrived.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { makeRecoveryKey } from "../../src/core/codec/recoveryKey";
import { YaosController } from "../../src/host/pluginController";
import { VaultKeyStore } from "../../src/host/keys/secretStore";
import { DEFAULT_ENGINE_SETTINGS, defaultPluginData, type YaosPluginData } from "../../src/host/ui/api";
import type { UserCommand } from "../../src/protocol/messages";
import type { Report } from "./engineKit";
import { bytesOf, converge, enc, randomBytes, sameBytes, waitFor } from "./fullCheck";
import { FullClient } from "./fullKit";
import { installPlugin } from "./fullScenarios2";
import { onboardVault, type OnboardDevice, type OnboardedVault } from "./onboard";
import { recordSample, WireTap } from "./wireTap";

/** Slack on top of quietMs: the relay saw its last commit before any client did, so this only adds idle time. */
const MARGIN_MS = 100;
const NOTE_LINES = (tag: string) => `# ${tag}\n\n${Array.from({ length: 10 }, (_, k) => `line ${k} of ${tag}`).join("\n")}\n`;

export interface LoneOptions {
	readonly host: string;
	readonly label: string;
	readonly watcherMs: number;
	readonly e2ee: boolean;
	/** Metric prefix: lone (E2EE on), lone_plain (off). */
	readonly prefix: string;
}

interface Trio {
	readonly vault: OnboardedVault;
	readonly tap: WireTap;
	readonly clients: [FullClient, FullClient, FullClient];
	readonly stop: () => Promise<void>;
}

async function plainTrio(o: LoneOptions): Promise<Trio> {
	const vault = await onboardVault(o.host, { devices: 3, label: `lone-plain-${o.label}` });
	const tap = new WireTap();
	const clients = vault.devices.map((d, i) => {
		const c = new FullClient({ name: "abc"[i]!, host: o.host, vaultId: vault.vaultId, device: d, watcherDelayMs: o.watcherMs, tap });
		installPlugin(c);
		return c;
	}) as [FullClient, FullClient, FullClient];
	const stop = async () => {
		for (const c of clients) {
			try { await c.stop(); } catch { /* best effort */ }
		}
	};
	try {
		await Promise.all(clients.map((c) => c.start()));
	} catch (e) {
		await stop();
		throw e;
	}
	return { vault, tap, clients, stop };
}

/** Suite 1 through the plugin controller: a enables encryption (genesis, pin, restart); b and c install K_1 by QR. */
async function e2eeTrio(o: LoneOptions): Promise<Trio> {
	const vault = await onboardVault(o.host, { devices: 3, label: `lone-e2ee-${o.label}` });
	const tap = new WireTap();
	const devices: { client: FullClient; ctl: YaosController }[] = [];
	const device = (name: string, od: OnboardDevice, creating: boolean) => {
		const client = new FullClient({ name, host: o.host, vaultId: vault.vaultId, device: od, watcherDelayMs: o.watcherMs, tap });
		installPlugin(client);
		const identity = { host: o.host, vaultId: vault.vaultId, deviceId: od.deviceId, deviceToken: od.deviceToken, deviceName: name, vaultGeneration: vault.vaultGeneration };
		const data: YaosPluginData = { ...defaultPluginData(name), identity, engine: { ...DEFAULT_ENGINE_SETTINGS, syncSettings: true },
			...(creating ? { creating: { vaultId: vault.vaultId } } : {}) };
		const ctl = new YaosController(data, {
			makeRuntime: (id, settings, ui, keys) => client.runtimeFor(id, settings, ui, keys),
			saveData: async () => {},
			notice: () => {},
			log: (l) => client.log(`main: ${l}`),
			clock: client.clock,
			secrets: client.secrets,
		});
		const d = { client, ctl };
		devices.push(d);
		return d;
	};
	const stop = async () => {
		for (const d of devices) {
			try { await d.ctl.stop(); } catch { /* best effort */ }
			try { await d.client.stop(); } catch { /* best effort */ }
		}
	};
	const status = (d: { client: FullClient }) => d.client.ui.statuses.at(-1);
	const sealing = (d: { client: FullClient }) => status(d)?.phase === "live" && status(d)?.e2ee?.suite === 1 && status(d)?.e2ee?.sealEpoch === 1;
	const cmd = async (d: { client: FullClient; ctl: YaosController }, c: UserCommand) => {
		const r = await d.ctl.command(c);
		if (r.t !== "ok") throw new Error(`${c.t} on ${d.client.name}: ${r.t}`);
	};
	try {
		const a = device("a", vault.devices[0]!, true);
		await a.ctl.start();
		await waitFor(() => status(a)?.e2ee?.creatable === true, "a creatable", 30_000, performance.now(), 50);
		await cmd(a, { t: "enableE2ee", rk: makeRecoveryKey(new Uint8Array(nodeRandomBytes(32))) });
		await waitFor(() => sealing(a), "a live under K_1", 60_000, performance.now(), 50);
		for (const [i, name] of ["b", "c"].entries()) {
			const d = device(name, vault.devices[i + 1]!, false);
			await d.ctl.start();
			await waitFor(() => status(d)?.phase === "key-missing" && status(d)?.e2ee?.keyMissing === "encrypted-vault", `${name} sees an encrypted vault`, 30_000, performance.now(), 50);
			const k = new VaultKeyStore(a.client.secrets, vault.vaultId, a.client.clock).load()?.keys.find((x) => x.e === 1)?.k;
			if (!k) throw new Error("a stores no key for epoch 1");
			await cmd(d, { t: "installKey", source: "qr", e: 1, k });
			await waitFor(() => sealing(d), `${name} live under K_1`, 60_000, performance.now(), 50);
		}
	} catch (e) {
		await stop();
		throw e;
	}
	return { vault, tap, clients: devices.map((d) => d.client) as [FullClient, FullClient, FullClient], stop };
}

/** One lone run: setup files, then each measured edit after converge + quiet. */
export async function lone(R: Report, o: LoneOptions): Promise<void> {
	R.step(`lone edits, E2EE ${o.e2ee ? "on (suite 1)" : "off (suite 0)"}`);
	const t = o.e2ee ? await e2eeTrio(o) : await plainTrio(o);
	const { tap, clients } = t;
	const [a, b, c] = clients;
	const peers = [b, c];
	const waits: number[] = [];
	try {
		await converge(clients, 120_000);
		R.check(`lone vault ${o.e2ee ? "seals under suite 1 on every client" : "runs suite 0 on every client"}`,
			clients.every((x) => (x.ui.statuses.at(-1)?.e2ee?.suite ?? null) === (o.e2ee ? 1 : 0)), clients.map((x) => x.ui.statuses.at(-1)?.e2ee?.suite ?? null));
		const gc = tap.groupCommit;
		R.check("VAULT_READY carried groupCommit limits", gc !== null, gc);
		R.extra[`${o.prefix}_groupCommit`] = gc;

		// Fixtures, created once and converged before the first measurement.
		for (let i = 0; i < 6; i++) {
			a.vault.userWrite(`lone/rn-${i}.md`, NOTE_LINES(`rn ${i}`));
			a.vault.userWrite(`lone/del-${i}.md`, NOTE_LINES(`del ${i}`));
		}
		a.vault.userWrite("lone/edit.md", NOTE_LINES("edit"));
		a.vault.userWrite("lone/typing.md", NOTE_LINES("typing"));
		a.vault.userWrite("lone/edit-during-upload.md", NOTE_LINES("edit during upload"));

		const m = (what: string) => `${o.prefix}_${what}_to_peer`;
		/** Converge, wait for the relay to go quiet, act, and time each peer. */
		const sample = async (act: () => void | Promise<void>, arrive: (p: FullClient, t0: number) => Promise<unknown>) => {
			await converge(clients, 120_000, 50);
			waits.push(await tap.quiet(MARGIN_MS));
			const t0 = performance.now();
			await act();
			await Promise.all(peers.map((p) => arrive(p, t0)));
		};
		/** Bytes at `path` on the peer (null = absent), timed at the peer engine's last write of `path`; returns that time. */
		const file = (metric: string, path: string, want: Uint8Array | null, writes?: number[], timeoutMs = 120_000) => async (p: FullClient, t0: number) => {
			const seen = t0 + await waitFor(async () => sameBytes(await bytesOf(p, path), want), `${path} on ${p.name}`, timeoutMs, t0, 2);
			const w = tap.diskWrites(p.name, path, t0, seen);
			writes?.push(w.n);
			recordSample(R, tap, metric, a.name, p.name, t0, w.last ?? seen, "committed", w.n);
			return w.last ?? seen;
		};

		const createWrites: number[] = [];
		for (let i = 0; i < 10; i++) {
			const path = `lone/create-${i}.md`;
			const text = NOTE_LINES(`create ${i}`);
			await sample(() => a.vault.userWrite(path, text), file(m("create"), path, enc(text), createWrites));
		}
		R.check("each lone create reached each peer's disk in one write", createWrites.every((n) => n === 1), createWrites);

		for (let i = 0; i < 10; i++) {
			const text = `${a.vault.textOf("lone/edit.md")}api edit ${i}\n`;
			await sample(() => a.vault.userWrite("lone/edit.md", text), file(m("api_edit"), "lone/edit.md", enc(text)));
		}
		for (let i = 0; i < 10; i++) {
			const text = `${a.vault.textOf("lone/edit.md")}disk edit ${i}\n`;
			await sample(() => a.vault.externalWrite("lone/edit.md", text), file(m("disk_edit"), "lone/edit.md", enc(text)));
		}

		// Typing: a and b have the note open (bound); c does not, so its engine writes its disk.
		const va = a.workspace.openFile("lone/typing.md")!;
		const vb = b.workspace.openFile("lone/typing.md")!;
		await waitFor(() => va.isBound() && vb.isBound(), "typing views bound", 15_000);
		for (let i = 0; i < 10; i++) {
			const tok = ` [lone ${i}]`;
			await sample(() => va.edit(va.buffer.length, 0, tok), async (p, t0) => {
				if (p === b) {
					const seen = t0 + await waitFor(() => vb.buffer.includes(tok), `${tok} in b's view`, 30_000, t0, 1);
					recordSample(R, tap, m("typing_view"), a.name, b.name, t0, seen, "provisional");
					return;
				}
				const seen = t0 + await waitFor(() => (c.vault.textOf("lone/typing.md") ?? "").includes(tok), `${tok} on c`, 30_000, t0, 2);
				const w = tap.diskWrites(c.name, "lone/typing.md", t0, seen);
				recordSample(R, tap, m("typing_disk"), a.name, c.name, t0, w.last ?? seen, "committed", w.n);
			});
		}
		await a.workspace.closeView(va.viewId);
		await b.workspace.closeView(vb.viewId);

		for (let i = 0; i < 6; i++) {
			const to = `lone/moved/rn-${i}.md`;
			const text = enc(a.vault.textOf(`lone/rn-${i}.md`) ?? "?");
			await sample(() => void a.vault.userRename(`lone/rn-${i}.md`, to), async (p, t0) => {
				await file(m("rename"), to, text)(p, t0);
				await waitFor(() => !p.vault.hasFile(`lone/rn-${i}.md`), `old path gone on ${p.name}`, 30_000);
			});
		}
		for (let i = 0; i < 6; i++) {
			await sample(() => void a.vault.userDelete(`lone/del-${i}.md`), file(m("delete"), `lone/del-${i}.md`, null));
		}

		for (let i = 0; i < 6; i++) {
			// As cfgPlan.ts writes a synced json file (2-space indent, no trailing newline), so the peer's bytes match.
			const bytes = enc(JSON.stringify({ alwaysUpdateLinks: true, lone: i }, null, 2));
			const cfgPath = `${a.vault.configDir}/app.json`;
			await sample(async () => {
				await a.configDir.writeBytes("app.json", bytes);
				await a.runtime.command({ t: "reconcileNow" });
			}, async (p, t0) => {
				const seen = t0 + await waitFor(() => sameBytes(p.configDir.files.get("app.json") ?? null, bytes), `app.json on ${p.name}`, 60_000, t0, 2);
				const w = tap.diskWrites(p.name, cfgPath, t0, seen);
				recordSample(R, tap, m("settings"), a.name, p.name, t0, w.last ?? seen, "committed", w.n);
			});
		}

		// 25m: well above the old 10 MiB cap (the relay takes up to 100 MB, DECISIONS D9). Attachments last, so only
		// the converges after them fingerprint (and decode) the big files.
		const sizes = [["40k", 40 * 1024, 4, "jpg"], ["300k", 300 * 1024, 3, "png"], ["2m", 2 * 1024 * 1024, 2, "pdf"], ["25m", 25 * 1024 * 1024, 1, "mp4"]] as const;
		for (const [tag, size, n, ext] of sizes) {
			for (let i = 0; i < n; i++) {
				const path = `lone/att-${tag}-${i}.${ext}`;
				const bytes = randomBytes(size + i, 700 + size + i);
				await sample(() => a.vault.externalWrite(path, bytes), file(m(`attachment_${tag}`), path, bytes));
			}
		}

		// Edits while a uploads a 90 MB attachment (the relay takes 100 MB, MAX_BLOB_UPLOAD_BYTES; sealed under
		// suite 1 that still fits: maxSealedBlobPlaintext(100_000_000) = 98_566_143). Once a's PUT is in flight the
		// edit is made and timed on each peer; then the attachment must arrive before the next round.
		const BIG = 90_000_000;
		const r1 = (ms: number) => Math.round(ms * 10) / 10;
		const during: Record<string, unknown>[] = [];
		R.extra[`${o.prefix}_during_upload`] = during;
		const duringUpload = async (k: number, what: string, act: () => void, arrive: (p: FullClient, t0: number) => Promise<number>) => {
			const path = `lone/att-90m-${k}.bin`;
			const bytes = randomBytes(BIG + k, 900 + k);
			await converge(clients, 300_000, 50);
			waits.push(await tap.quiet(MARGIN_MS));
			const tw = performance.now();
			a.vault.externalWrite(path, bytes);
			const putOf = () => a.net.puts.find((x) => x.start >= tw && x.bytes >= BIG);
			await waitFor(() => putOf() !== undefined, `a's PUT of ${path}`, 120_000, tw, 1);
			const put = putOf()!;
			const t0 = performance.now();
			const inFlightAtEdit = put.end === null;
			act();
			const done = await Promise.all(peers.map((p) => arrive(p, t0)));
			const landed = await Promise.all(peers.map((p) => waitFor(async () => (await p.vault.stat(path))?.size === bytes.byteLength && sameBytes(await bytesOf(p, path), bytes),
				`${path} on ${p.name}`, 600_000, tw, 20)));
			for (const [j, p] of peers.entries()) {
				const at = done[j]!;
				const get = p.net.gets.find((x) => x.start >= tw && x.bytes >= BIG);
				const row = {
					what, k, peer: p.name, ms: r1(at - t0), putBytes: put.bytes, putMs: put.end === null ? null : r1(put.end - put.start), putOk: put.ok,
					putStartToEditMs: r1(t0 - put.start), inFlightAtEdit, inFlightAtArrival: put.end === null || put.end > at,
					arrivalMinusPutEndMs: put.end === null ? null : r1(at - put.end), attachmentOnPeerMs: r1(landed[j]!),
					putEndAfterEditMs: put.end === null ? null : r1(put.end - t0),
					// The peer's GET of the attachment (ms after the edit): did the peer write the edit only after its own download?
					peerGetAfterEditMs: get ? { start: r1(get.start - t0), end: get.end === null ? null : r1(get.end - t0) } : null,
					// a's frames from the edit to the arrival (ms after the edit): which one waited, on a, at the relay or on the peer.
					frames: tap.timeline(a.name, p.name, t0, at),
				};
				during.push(row);
				const f = row.frames.map((x) => `${x.stream} +${x.append}/${x.receipt ?? "-"}/${x.arrival ?? "-"}`).join(", ");
				console.log(`  ${o.prefix} ${what} during upload #${k} -> ${p.name}: ${row.ms} ms; a's PUT ${row.putMs} ms (${put.bytes} B), `
					+ `edit made ${row.putStartToEditMs} ms into it, in flight at arrival: ${row.inFlightAtArrival} (arrival - PUT end: ${row.arrivalMinusPutEndMs} ms); `
					+ `a's frames append/receipt/on-peer: ${f}; ${p.name}'s GET: ${row.peerGetAfterEditMs ? `+${row.peerGetAfterEditMs.start}..+${row.peerGetAfterEditMs.end}` : "-"}`);
			}
		};
		for (let i = 0; i < 2; i++) {
			const path = "lone/edit-during-upload.md";
			const text = `${a.vault.textOf(path)}disk edit during upload ${i}\n`;
			await duringUpload(i, "disk_edit", () => a.vault.externalWrite(path, text), file(m("disk_edit_during_upload"), path, enc(text), undefined, 600_000));
		}
		// Typing: only a has the note open; b and c write it to disk.
		const vt = a.workspace.openFile("lone/typing.md")!;
		await waitFor(() => vt.isBound(), "a's typing view bound", 15_000);
		for (let i = 0; i < 2; i++) {
			const tok = ` [during upload ${i}]`;
			await duringUpload(2 + i, "typing", () => vt.edit(vt.buffer.length, 0, tok), async (p, t0) => {
				const seen = t0 + await waitFor(() => (p.vault.textOf("lone/typing.md") ?? "").includes(tok), `${tok} on ${p.name}`, 600_000, t0, 2);
				const w = tap.diskWrites(p.name, "lone/typing.md", t0, seen);
				recordSample(R, tap, m("typing_during_upload"), a.name, p.name, t0, w.last ?? seen, "committed", w.n);
				return w.last ?? seen;
			});
		}
		await a.workspace.closeView(vt.viewId);
		R.check("each edit during an upload was made while a's 90 MB PUT was in flight",
			during.length === 8 && during.every((r) => r.inFlightAtEdit === true), during.map((r) => r.inFlightAtEdit));

		await converge(clients, 120_000);
		R.check("lone run converged; every sample split at a critical frame",
			Object.entries(tap.samples).every(([, rows]) => rows.every((r) => r.split !== null)),
			Object.fromEntries(Object.entries(tap.samples).map(([k, rows]) => [k, rows.filter((r) => r.split === null).length])));
	} finally {
		R.extra[`${o.prefix}_quietWaitMs`] = waits.length ? { n: waits.length, max: Math.round(Math.max(...waits)) } : null;
		R.extra[`${o.prefix}_samples`] = tap.samples;
		await t.stop();
	}
}
