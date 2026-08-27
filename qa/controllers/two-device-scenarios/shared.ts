import type { ObsidianClient } from "../obsidian-client.mjs";

export interface TwoDeviceScenarioResult {
	passedA: boolean;
	passedB: boolean;
	errors: string[];
	evidence?: Record<string, unknown>;
}

export type TwoDeviceScenario = (
	a: ObsidianClient,
	b: ObsidianClient,
	log: (message: string) => void,
) => Promise<TwoDeviceScenarioResult>;

export type TwoDeviceScenarios = Record<string, TwoDeviceScenario>;
export async function disableYaos(client: ObsidianClient): Promise<boolean> {
	await client.evalRaw(`app.plugins.disablePlugin("yaos")`);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	return client.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
}

export async function enableYaosAndWait(
	client: ObsidianClient,
	timeoutMs = 30_000,
): Promise<boolean> {
	await client.evalRaw(`app.plugins.enablePlugin("yaos")`);
	return client.evalRaw<boolean>(`
		(async () => {
			const deadline = Date.now() + ${timeoutMs};
			while (Date.now() < deadline) {
				const yaos = app.plugins?.plugins?.yaos;
				const debug = window.__YAOS_DEBUG__;
				if (yaos && debug && debug.isLocalReady()) return true;
				await new Promise(resolve => setTimeout(resolve, 500));
			}
			return false;
		})()
	`);
}


/** Sentinel used across all s10f variants. */
export const S10F_SENTINEL = "DELETE_ME_SENTINEL_X9K7";

/** Delete sentinel line from the active editor. Returns JS expression string. */
export function deleteSentinelExpr(sentinel: string): string {
	return `
		(function() {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) return false;
			const doc = editor.getValue();
			const sentinel = ${JSON.stringify(sentinel)};
			const idx = doc.indexOf(sentinel);
			if (idx === -1) return false;
			const lineStart = doc.lastIndexOf("\\n", idx - 1) + 1;
			let lineEnd = doc.indexOf("\\n", idx);
			if (lineEnd === -1) lineEnd = doc.length;
			else lineEnd += 1;
			const from = editor.offsetToPos(lineStart);
			const to = editor.offsetToPos(lineEnd);
			editor.replaceRange("", from, to);
			return true;
		})()
	`;
}

/** Read active editor content. Returns JS expression string. */
export const READ_EDITOR_EXPR = `app.workspace.activeEditor?.editor?.getValue() ?? ""`;

/** Type text at cursor in active editor. Returns JS expression string. */
export function typeAtCursorExpr(text: string): string {
	return `
		(function() {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) return;
			editor.replaceRange(${JSON.stringify(text)}, editor.getCursor());
		})()
	`;
}

/**
 * Poll the active editor on `client` for sentinel reversion.
 * Returns { reversionDetected, pollCount }.
 */
export async function pollForReversion(
	client: ObsidianClient,
	sentinel: string,
	durationMs: number,
	intervalMs: number,
	log: (msg: string) => void,
	opts?: { burstEvery?: number; burstText?: string },
): Promise<{ reversionDetected: boolean; pollCount: number; errors: string[] }> {
	const errors: string[] = [];
	const burstEvery = opts?.burstEvery ?? 20;
	const burstText = opts?.burstText ?? " x";
	const pollStart = Date.now();
	let pollCount = 0;
	let reversionDetected = false;

	while (Date.now() - pollStart < durationMs) {
		await new Promise((r) => setTimeout(r, intervalMs));
		pollCount++;

		const editorContent = await client.evalRaw<string>(READ_EDITOR_EXPR);

		if (editorContent.includes(sentinel)) {
			const elapsed = Math.round((Date.now() - pollStart) / 1000);
			errors.push(
				`REVERSION at poll ${pollCount} (t+${elapsed}s): ` +
				`sentinel "${sentinel}" reappeared in editor! ` +
				`Content length: ${editorContent.length}`,
			);
			reversionDetected = true;
			break;
		}

		if (burstEvery > 0 && pollCount % burstEvery === 0) {
			await client.evalRaw(typeAtCursorExpr(burstText));
		}
	}

	if (!reversionDetected) {
		log(`Monitoring: ${pollCount} polls over ${Math.round(durationMs / 1000)}s, sentinel NEVER reappeared ✓`);
	}

	return { reversionDetected, pollCount, errors };
}

/**
 * Setup: create file, sync to both, open on both, wait for binding.
 * Returns success boolean. Pushes errors to `errors` array.
 */
export async function s10fSetup(
	creator: ObsidianClient,
	receiver: ObsidianClient,
	scratch: string,
	initial: string,
	errors: string[],
	log: (msg: string) => void,
	opts?: { openOnBoth?: boolean },
): Promise<boolean> {
	const openOnBoth = opts?.openOnBoth ?? true;

	log("Setup: creating test file...");
	await creator.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(initial)})`);
	await creator.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);

	log("Setup: waiting for file on receiver...");
	await receiver.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);
	await receiver.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);

	const hashC = await creator.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	const hashR = await receiver.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	if (hashC !== hashR) {
		errors.push(`Setup: hashes differ -- creator=${hashC?.slice(0, 12)}, receiver=${hashR?.slice(0, 12)}`);
		return false;
	}
	log("Setup: both devices have identical file ✓");

	if (openOnBoth) {
		log("Setup: opening file on both...");
		await creator.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await receiver.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await creator.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await receiver.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		log("Setup: healthy binding on both ✓");
	}

	return true;
}

/** Cleanup: close + delete file on both devices. */
export async function s10fCleanup(
	a: ObsidianClient,
	b: ObsidianClient,
	scratch: string,
): Promise<void> {
	await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
}

/** Convergence check: verify sentinel absent + hashes match. */
export async function s10fConvergence(
	active: ObsidianClient,
	passive: ObsidianClient,
	scratch: string,
	sentinel: string,
	errors: string[],
	log: (msg: string) => void,
): Promise<void> {
	log("Convergence: waiting for passive device...");
	await passive.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(20000)`).catch(() => {});
	await new Promise((r) => setTimeout(r, 5000));

	const contentP = await passive.evalRaw<string>(`
		(async () => {
			const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
			return f ? await app.vault.read(f) : "";
		})()
	`);
	if (contentP.includes(sentinel)) {
		errors.push("Passive device: sentinel still present after convergence");
	} else {
		log("Passive device: sentinel absent ✓");
	}

	const hashA = await active.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	const hashP = await passive.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	if (hashA !== hashP) {
		errors.push(`Final hash mismatch: active=${hashA?.slice(0, 12)}, passive=${hashP?.slice(0, 12)}`);
	} else {
		log("Final: active == passive hash ✓");
	}
}
