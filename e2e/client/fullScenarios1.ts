/**
 * Full-client e2e scenarios 1-4 (fullClients.ts): fresh vault, edits (disk, API, editor typing,
 * concurrent), renames and deletes, binary attachments. Each ends converged (fullCheck.converge).
 *
 * Latency: sustained_* samples are back-to-back edits, each started as soon as the previous one reached every
 * peer, so each pays the relay's minimum commit interval (groupCommit.minIntervalMs, in the results'
 * extra.sustainedFloorMsPerCommit). The first edit of a series follows something else and is not recorded; edits
 * after a settle or a view open are neither lone nor back to back and are not timed (lone edits: fullLatency.ts).
 */
import { conflictCopies, converge, enc, randomBytes, reachPeers, sameBytes, bytesOf, textReachesPeers, waitFor, sleep } from "./fullCheck";
import type { FullClient, FullCtx } from "./fullKit";
import { recordSample } from "./wireTap";

const noConflicts = (x: FullCtx) => x.R.check("no conflict copies", x.clients.every((c) => conflictCopies(c).length === 0),
	Object.fromEntries(x.clients.map((c) => [c.name, conflictCopies(c)])));

async function settle(x: FullCtx, metric: string | null, timeoutMs = 60_000): Promise<void> {
	const ms = await converge(x.clients, timeoutMs);
	if (metric) x.R.record(metric, ms);
	x.R.check("converged: files, synced config and ns fold byte-identical; all clients clean", true, { ms: Math.round(ms) });
}

/** Back-to-back samples of `path` from `from`: timed at each peer engine's write, split at the critical frame. */
function sustained(x: FullCtx, base: string, from: FullClient, peers: readonly FullClient[], path: string, t0: number, ms: readonly number[]): void {
	for (const [i, p] of peers.entries()) {
		const seen = t0 + ms[i]!;
		const w = x.tap.diskWrites(p.name, path, t0, seen);
		recordSample(x.R, x.tap, base, from.name, p.name, t0, w.last ?? seen, "committed", w.n);
	}
}

/** 1. Fresh vault: creates (nested folders) on A reach B and C byte-identically. */
export async function sCreate(x: FullCtx): Promise<void> {
	const [a, b, c] = x.clients as [FullClient, FullClient, FullClient];
	const files = ["Welcome.md", "notes/one.md", "notes/two.md", "notes/deep/a/b/three.md", "projects/2026/plan.md", "journal/2026-10-06.md", "rn/file1.md", "rn/sub/file2.md"];
	for (const [i, p] of files.entries()) {
		const text = `# ${p}\n\n${Array.from({ length: 10 }, (_, k) => `line ${k} of ${i}`).join("\n")}\n`;
		const t0 = performance.now();
		a.vault.userWrite(p, text);
		const ms = await reachPeers([b, c], p, enc(text), t0);
		if (i > 0) sustained(x, "sustained_create_to_peer", a, [b, c], p, t0, ms);
	}
	const t0 = performance.now();
	b.vault.userWrite("from-b.md", "written on b\n");
	sustained(x, "sustained_create_to_peer", b, [a, c], "from-b.md", t0, await reachPeers([a, c], "from-b.md", enc("written on b\n"), t0));
	const tb = performance.now();
	for (let i = 0; i < 20; i++) a.vault.userWrite(`burst/n${String(i).padStart(2, "0")}.md`, `burst ${i}\n`);
	await settle(x, null);
	x.R.record("burst20_create_converge_ms", performance.now() - tb);
	x.R.check("nested folders exist on peers", [b, c].every((p) => p.vault.folderPaths().includes("notes/deep/a/b")));
	x.R.check("29 files on every client", x.clients.every((p) => p.vault.snapshot().size === 29), x.clients.map((p) => p.vault.snapshot().size));
	noConflicts(x);
}

/** 2. Disk (external) edits, API edits, editor typing in bound views, concurrent edits that merge. */
export async function sEdits(x: FullCtx): Promise<void> {
	const [a, b, c] = x.clients as [FullClient, FullClient, FullClient];
	const one = "notes/one.md";
	for (let i = 0; i < 5; i++) {
		const text = `${a.vault.textOf(one)}external edit ${i}\n`;
		const t0 = performance.now();
		a.vault.externalWrite(one, text);
		const ms = await reachPeers([b, c], one, enc(text), t0);
		if (i > 0) sustained(x, "sustained_disk_edit_to_peer", a, [b, c], one, t0, ms);
	}
	for (let i = 0; i < 5; i++) {
		const text = `${a.vault.textOf(one)}api edit ${i}\n`;
		const t0 = performance.now();
		a.vault.userWrite(one, text);
		sustained(x, "sustained_api_edit_to_peer", a, [b, c], one, t0, await reachPeers([b, c], one, enc(text), t0));
	}

	// Editor typing: A and B have notes/two.md open (bound); C does not (its disk is written by the engine).
	const two = "notes/two.md";
	const va = a.workspace.openFile(two)!;
	const vb = b.workspace.openFile(two)!;
	await waitFor(() => va.isBound() && vb.isBound(), "views bound", 15_000);
	for (let i = 0; i < 10; i++) {
		const tok = ` [a${i}]`;
		const t0 = performance.now();
		va.edit(va.buffer.length, 0, tok);
		const [toView, toDisk] = await Promise.all([
			waitFor(() => vb.buffer.includes(tok), `${tok} in b's view`, 15_000, t0),
			textReachesPeers([c], two, tok, t0, 15_000).then((v) => v[0]!),
		]);
		if (i === 0) continue;
		x.R.record("sustained_typing_to_peer_view_ms", toView);
		x.R.record("sustained_typing_to_peer_disk_ms", toDisk);
	}
	// Concurrent typing on A (start of line 3) and B (end of doc), interleaved, no waiting.
	let at = va.buffer.indexOf("\n", va.buffer.indexOf("\n") + 1) + 1;
	for (let i = 0; i < 10; i++) {
		va.edit(at, 0, `<A${i}>`);
		at += `<A${i}>`.length;
		vb.edit(vb.buffer.length, 0, `<B${i}>`);
		await sleep(15);
	}
	await settle(x, null);
	const merged = a.vault.textOf(two) ?? "";
	const aToks = Array.from({ length: 10 }, (_, i) => `<A${i}>`);
	const bToks = Array.from({ length: 10 }, (_, i) => `<B${i}>`);
	x.R.check("concurrent typing merged (all tokens of A and B, A's in order)", [...aToks, ...bToks].every((t) => merged.includes(t))
		&& merged.includes(aToks.join("")), { merged: merged.slice(-400) });
	await a.workspace.closeView(va.viewId);
	await b.workspace.closeView(vb.viewId);

	// Concurrent disk edits on A (line 1) and B (last line) from the same converged base.
	const base = (a.vault.textOf(one) ?? "").split("\n");
	const ea = [...base];
	ea[1] = `${ea[1]} (edited on a)`;
	const eb = [...base];
	eb[base.length - 2] = `${eb[base.length - 2]} (edited on b)`;
	a.vault.externalWrite(one, ea.join("\n"));
	b.vault.externalWrite(one, eb.join("\n"));
	await settle(x, null);
	const m = a.vault.textOf(one) ?? "";
	x.R.check("concurrent disk edits merged", m.includes("(edited on a)") && m.includes("(edited on b)") && m.split("\n").length === base.length, { text: m });
	noConflicts(x);
}

/** 3. File and folder renames and deletes propagate; deletes go to trash; remote moves are plain renames. */
export async function sRenames(x: FullCtx): Promise<void> {
	const [a, b, c] = x.clients as [FullClient, FullClient, FullClient];
	for (const [p, t] of [["solo.md", "solo\n"], ["rn/sub/file3.md", "three\n"], ["del/x.md", "x\n"], ["del/inner/y.md", "y\n"]] as const) a.vault.userWrite(p, t);
	await settle(x, null);
	const before = x.clients.map((p) => ({ ...p.vault.calls }));
	const delta = (i: number, k: "write" | "rename" | "trash") => x.clients[i]!.vault.calls[k] - before[i]![k];

	let t0 = performance.now();
	a.vault.userRename("solo.md", "moved/solo-renamed.md");
	await reachPeers([b, c], "moved/solo-renamed.md", enc("solo\n"), t0);
	await reachPeers([b, c], "solo.md", null, t0);

	t0 = performance.now();
	a.vault.userRenameFolder("rn", "rn2");
	const moved = ["rn2/file1.md", "rn2/sub/file2.md", "rn2/sub/file3.md"];
	await Promise.all(moved.map((p) => reachPeers([b, c], p, enc(a.vault.textOf(p) ?? "?"), t0)));
	x.R.record("sustained_folder_rename_to_peer_ms", performance.now() - t0);
	await settle(x, null);
	x.R.check("remote renames used vault.rename, no rewrite, no trash", [1, 2].every((i) => delta(i, "rename") >= 4 && delta(i, "write") === 0 && delta(i, "trash") === 0),
		[1, 2].map((i) => ({ rename: delta(i, "rename"), write: delta(i, "write"), trash: delta(i, "trash") })));
	x.R.check("old folder gone on peers", [b, c].every((p) => !p.vault.folderPaths().some((f) => f === "rn" || f.startsWith("rn/"))),
		[b, c].map((p) => p.vault.folderPaths().filter((f) => f === "rn" || f.startsWith("rn/"))));

	// A renames a file B has open in a bound editor: B's view follows and B's typing lands at the new path.
	const vb = b.workspace.openFile("notes/deep/a/b/three.md")!;
	await waitFor(() => vb.isBound(), "b view bound", 15_000);
	t0 = performance.now();
	a.vault.userRename("notes/deep/a/b/three.md", "notes/three-moved.md");
	await reachPeers([b, c], "notes/three-moved.md", enc(a.vault.textOf("notes/three-moved.md") ?? "?"), t0);
	await waitFor(() => vb.path === "notes/three-moved.md", "b's open view follows the remote rename", 10_000);
	vb.edit(vb.buffer.length, 0, "typed after remote rename\n");
	await textReachesPeers([a, c], "notes/three-moved.md", "typed after remote rename", performance.now());
	x.R.check("open view followed the remote rename and stayed bound", vb.isBound() && vb.path === "notes/three-moved.md");
	await b.workspace.closeView(vb.viewId);

	t0 = performance.now();
	b.vault.userDelete("del/x.md");
	await reachPeers([a, c], "del/x.md", null, t0);
	t0 = performance.now();
	c.vault.userDelete("del/inner/y.md"); // the last file of the folder: Obsidian deletes the folder's files
	sustained(x, "sustained_delete_to_peer", c, [a, b], "del/inner/y.md", t0, await reachPeers([a, b], "del/inner/y.md", null, t0));
	t0 = performance.now();
	c.vault.userDelete("rn2/sub/file3.md"); // c got this path from a's folder rename: delete after a remote rename
	sustained(x, "sustained_delete_to_peer", c, [a, b], "rn2/sub/file3.md", t0, await reachPeers([a, b], "rn2/sub/file3.md", null, t0));
	await settle(x, null);
	const trashOk = (p: FullClient, path: string) => p.vault.trashed.some((r) => r.path === path && r.mode === "follow-obsidian");
	x.R.check("deleted files went to the trash Obsidian is set to (default mode) on peers", trashOk(a, "del/x.md") && trashOk(c, "del/x.md") && trashOk(a, "del/inner/y.md") && trashOk(b, "del/inner/y.md")
		&& trashOk(a, "rn2/sub/file3.md") && trashOk(b, "rn2/sub/file3.md"), x.clients.map((p) => p.vault.trashed.map((r) => `${r.path}:${r.mode}`)));
	x.R.check("trash calls only for the deletes", delta(0, "trash") === 3 && delta(1, "trash") === 2 && delta(2, "trash") === 1, [0, 1, 2].map((i) => delta(i, "trash")));
	x.R.check("deleted files gone everywhere", x.clients.every((p) => !p.vault.hasFile("del/x.md") && !p.vault.hasFile("del/inner/y.md") && !p.vault.hasFile("rn2/sub/file3.md")));

	// A deletes a file B has open in a bound editor: it goes to B's trash and is not resurrected.
	const vd = b.workspace.openFile("moved/solo-renamed.md")!;
	await waitFor(() => vd.isBound(), "b view bound", 15_000);
	t0 = performance.now();
	a.vault.userDelete("moved/solo-renamed.md");
	await reachPeers([b, c], "moved/solo-renamed.md", null, t0);
	await settle(x, null);
	x.R.check("file open on a peer deleted (trash, view closed, not resurrected)", x.clients.every((p) => !p.vault.hasFile("moved/solo-renamed.md"))
		&& trashOk(b, "moved/solo-renamed.md") && !b.workspace.views_().includes(vd));
	noConflicts(x);
}

/** 4. Binary attachments (300 KB png, 2 MB pdf, small jpgs): create, modify, delete, byte-identical on peers. */
export async function sAttachments(x: FullCtx): Promise<void> {
	const [a, b, c] = x.clients as [FullClient, FullClient, FullClient];
	const put = async (from: FullClient, path: string, bytes: Uint8Array, metric: string | null) => {
		const t0 = performance.now();
		from.vault.externalWrite(path, bytes);
		const peers = x.clients.filter((p) => p !== from);
		const ms = await reachPeers(peers, path, bytes, t0, 120_000);
		if (metric) sustained(x, metric, from, peers, path, t0, ms);
	};
	await put(a, "attachments/photo.png", randomBytes(300 * 1024, 11), null); // follows scenario 3's settle
	await put(a, "attachments/manual.pdf", randomBytes(2 * 1024 * 1024, 12), "sustained_attachment_2m_to_peer");
	for (let i = 0; i < 4; i++) await put(i % 2 ? b : a, `attachments/small-${i}.jpg`, randomBytes(40 * 1024 + i, 20 + i), "sustained_attachment_40k_to_peer");
	await put(b, "attachments/photo.png", randomBytes(300 * 1024, 13), "sustained_attachment_300k_modify_to_peer");
	const t0 = performance.now();
	c.vault.userDelete("attachments/manual.pdf");
	sustained(x, "sustained_delete_to_peer", c, [a, b], "attachments/manual.pdf", t0, await reachPeers([a, b], "attachments/manual.pdf", null, t0, 60_000));
	await settle(x, null, 120_000);
	x.R.check("attachment delete went to trash on peers", [a, b].every((p) => p.vault.trashed.some((r) => r.path === "attachments/manual.pdf" && r.mode === "follow-obsidian")));
	x.R.check("modified png identical everywhere", (await Promise.all(x.clients.map((p) => bytesOf(p, "attachments/photo.png")))).every((v, _i, all) => sameBytes(v, all[0]!)));
	x.R.extra.blobPath = Object.fromEntries(x.clients.map((p) => [p.name, p.blobKind]));
	noConflicts(x);
}
