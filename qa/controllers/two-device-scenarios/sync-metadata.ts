import type { ObsidianClient } from "../obsidian-client.mjs";

import type { TwoDeviceScenarios } from "./shared";

export const syncMetadataScenarios: TwoDeviceScenarios = {
	/**
	 * s13-editor-open-remote-edit
	 *
	 * Device B has the target file open in the editor (CRDT binding active).
	 * Device A edits the file through the normal YAOS path.
	 * Verifies B converges without duplication, stale echo, or editor/CRDT/disk mismatch.
	 *
	 * Uses marker content: BASELINE + REMOTE_EDIT_FROM_A must both appear exactly once.
	 */
	"s13-editor-open-remote-edit": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s13-editor-open-remote-edit.md";
		const INITIAL = "# S13 Editor Open Remote Edit\n\nBASELINE\n";
		const RUN_ID = `s13-${Date.now()}`;

		// Recording is already on for both devices: the prepared vaults set
		// debug:true, which is the whole recorder lifecycle.

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		const traceInfoA = await a.evalRaw<{ localTraceId: string; pathSaltFingerprint: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		const traceInfoB = await b.evalRaw<{ localTraceId: string; pathSaltFingerprint: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		log(`s13: deviceA=${deviceIdA}, deviceB=${deviceIdB}`);

		// Both vaults share settings.vaultId, so the derived path salt — and
		// therefore every pathId — must be identical. If it is not, the two
		// traces cannot be correlated and the whole scenario is unreadable.
		if (traceInfoA?.pathSaltFingerprint !== traceInfoB?.pathSaltFingerprint) {
			errors.push(`s13: pathSaltFingerprint mismatch (A=${traceInfoA?.pathSaltFingerprint} B=${traceInfoB?.pathSaltFingerprint})`);
		}

		// Create file on A, wait for B to receive it
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		// Extra wait for disk writes to complete on both devices
		await new Promise((r) => setTimeout(r, 4000));
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(5000)`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(5000)`).catch(() => {});
		log("s13: file synced to B");

		// Open file on B and wait for editor binding
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await new Promise((r) => setTimeout(r, 2000));
		log("s13: B editor open and bound");

		// Record B editor binding health before edit
		const healthBefore = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s13: B binding health before: ${JSON.stringify(healthBefore)}`);

		if (!healthBefore?.healthy) {
			errors.push(`s13: B editor binding not healthy before edit: ${JSON.stringify(healthBefore)}`);
		}

		// Step 2 -- Device A edits via normal YAOS path (editor insert)
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await new Promise((r) => setTimeout(r, 1000));

		// Insert REMOTE_EDIT_FROM_A at end of file via editor
		await a.evalRaw(`
			(function() {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return;
				const lastLine = editor.lastLine();
				const lastCh = editor.getLine(lastLine).length;
				editor.replaceRange("REMOTE_EDIT_FROM_A\\n", { line: lastLine, ch: lastCh });
			})()
		`);
		log("s13: A inserted REMOTE_EDIT_FROM_A via editor");
		await new Promise((r) => setTimeout(r, 6000));

		// Wait for A's editor to settle, then give B time to converge.
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 6000));

		// Check B editor binding health after edit
		const healthAfter = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s13: B binding health after: ${JSON.stringify(healthAfter)}`);

		// Read final content on B
		const finalContentB = await b.evalRaw<string | null>(`
			(function() {
				const f = app.vault.getFileByPath(${JSON.stringify(scratch)});
				if (!f) return null;
				const editor = app.workspace.activeEditor?.editor;
				return editor ? editor.getValue() : null;
			})()
		`);
		log(`s13: B final editor content: ${JSON.stringify(finalContentB)}`);

		// Semantic content checks
		if (!finalContentB) {
			errors.push("s13: B final content is null -- editor not open or file missing");
		} else {
			const baselineCount = (finalContentB.match(/BASELINE/g) ?? []).length;
			const editCount = (finalContentB.match(/REMOTE_EDIT_FROM_A/g) ?? []).length;
			if (baselineCount !== 1) errors.push(`s13: BASELINE appears ${baselineCount} times (expected 1) -- possible duplication`);
			if (editCount !== 1) errors.push(`s13: REMOTE_EDIT_FROM_A appears ${editCount} times (expected 1)`);
			log(`s13: content check -- BASELINEx${baselineCount}, REMOTE_EDIT_FROM_Ax${editCount}`);
		}

		// B's disk, CRDT, and editor content must all agree after convergence.
		const diskHashB = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
		const crdtHashB = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getCrdtHash(${JSON.stringify(scratch)})`);
		const editorHashB = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getEditorHash(${JSON.stringify(scratch)})`);
		log(`s13: B hashes -- disk=${diskHashB?.slice(0, 16)} crdt=${crdtHashB?.slice(0, 16)} editor=${editorHashB?.slice(0, 16)}`);
		if (!crdtHashB) errors.push("s13: B crdtHash is null");
		if (diskHashB !== crdtHashB) errors.push(`s13: B diskHash≠crdtHash`);
		if (editorHashB !== crdtHashB) errors.push(`s13: B editorHash≠crdtHash`);


		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return {
			passedA: errors.length === 0,
			passedB: errors.length === 0,
			errors,
			evidence: {
				runId: RUN_ID,
				deviceIdA,
				deviceIdB,
				healthBefore,
				healthAfter,
				finalContentB: finalContentB?.slice(0, 200) ?? null,
			},
		};
	},

	/**
	 * s12a-with-edit -- two-device CDP scenario with actual edit
	 *
	 * A makes a real edit. B passively converges.
	 * Proves convergence after actual content change, not just pre-existing hash agreement.
	 */
	"s12a-with-edit": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s12a-edit.md";
		const INITIAL = "# S12a Edit\n\nBASELINE\n";
		const RUN_ID = `s12a-edit-${Date.now()}`;
		// Recording is already on for both devices (prepared vaults set debug:true).

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		const traceInfoA = await a.evalRaw<{ localTraceId: string; pathSaltFingerprint: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		log(`s12a-edit: A=${deviceIdA} B=${deviceIdB} salt=${traceInfoA?.pathSaltFingerprint?.slice(0, 20)}...`);

		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));
		log("s12a-edit: file synced to B");

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 2000));

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await a.evalRaw(`(function(){const e=app.workspace.activeEditor?.editor;if(!e)return;const l=e.lastLine();e.replaceRange("EDIT_FROM_A\\n",{line:l,ch:e.getLine(l).length});})()`);
		log("s12a-edit: A inserted EDIT_FROM_A, waiting for propagation...");
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`).catch(() => {});
		// Allow B to converge on A's edit.
		await new Promise((r) => setTimeout(r, 12_000));

		const finalContentB = await b.evalRaw<string | null>(`(function(){const f=app.vault.getFileByPath(${JSON.stringify(scratch)});if(!f)return null;const e=app.workspace.activeEditor?.editor;return e?e.getValue():null;})()`);
		log(`s12a-edit: B final content: ${JSON.stringify(finalContentB?.slice(0, 100))}`);

		if (!finalContentB) {
			errors.push("s12a-edit: B final content is null");
		} else {
			const baselineCount = (finalContentB.match(/BASELINE/g) ?? []).length;
			const editCount = (finalContentB.match(/EDIT_FROM_A/g) ?? []).length;
			if (baselineCount !== 1) errors.push(`s12a-edit: BASELINE appears ${baselineCount} times (expected 1)`);
			if (editCount !== 1) errors.push(`s12a-edit: EDIT_FROM_A appears ${editCount} times (expected 1)`);
			log(`s12a-edit: content check -- BASELINE x${baselineCount}, EDIT_FROM_A x${editCount}`);
		}

		const healthB = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s12a-edit: B binding health: ${JSON.stringify(healthB)}`);
		if (!healthB?.healthy) errors.push(`s12a-edit: B editor binding not healthy`);


		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return {
			passedA: errors.length === 0,
			passedB: errors.length === 0,
			errors,
			evidence: {
				runId: RUN_ID,
				deviceIdA,
				deviceIdB,
				finalContentB: finalContentB?.slice(0, 200) ?? null,
				healthB,
			},
		};
	},

	/**
	 * s12c-conflict -- two-device CDP conflict artifact scenario
	 *
	 * Reproduces disk/CRDT divergence that creates a Markdown conflict artifact.
	 * B disabled, A edits via YAOS, B edits disk directly, B re-enables.
	 * Verifies: disk wins main file, CRDT goes to artifact, artifact syncs to A.
	 */
	"s12c-conflict": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s12c-conflict.md";
		const INITIAL = "# S12c Conflict\n\nBASELINE\n";
		const REMOTE_FROM_A = "# S12c Conflict\n\nBASELINE\nREMOTE_FROM_A\n";
		const LOCAL_ON_B = "# S12c Conflict\n\nBASELINE\nLOCAL_ON_B\n";
		const RUN_ID = `s12c-conflict-${Date.now()}`;
		// Recording is already on for both devices (prepared vaults set debug:true).

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		log(`s12c: A=${deviceIdA} B=${deviceIdB}`);

		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));
		log("s12c: baseline synced to both devices");

		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 2000));
		const bDisabled = await b.evalRaw<boolean>(`!app.plugins.plugins.yaos`);
		if (!bDisabled) errors.push("s12c: B YAOS not disabled");
		log(`s12c: B YAOS disabled: ${bDisabled}`);

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await a.evalRaw(`(function(){const e=app.workspace.activeEditor?.editor;if(!e)return;const l=e.lastLine();e.replaceRange("REMOTE_FROM_A\\n",{line:l,ch:e.getLine(l).length});})()`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 3000));
		log("s12c: A inserted REMOTE_FROM_A via YAOS");

		await b.evalRaw(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(scratch)});if(f)await app.vault.adapter.write(${JSON.stringify(scratch)},${JSON.stringify(LOCAL_ON_B)});})()`);
		await new Promise((r) => setTimeout(r, 1000));
		log("s12c: B wrote LOCAL_ON_B directly to disk");

		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 5000));
		const bReady = await b.evalRaw<boolean>(`!!app.plugins.plugins.yaos`);
		if (!bReady) errors.push("s12c: B YAOS did not re-enable");
		log(`s12c: B YAOS re-enabled: ${bReady}`);

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));
		log("s12c: waiting for conflict resolution...");

		const survivorContent = await b.evalRaw<string | null>(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(scratch)});return f?await app.vault.read(f):null;})()`);
		log(`s12c: B survivor content: ${JSON.stringify(survivorContent?.slice(0, 100))}`);

		const artifactPath = await b.evalRaw<string | null>(`(function(){const files=app.vault.getMarkdownFiles();const a=files.find(f=>f.path.includes("s12c-conflict")&&f.path.includes("YAOS conflict"));return a?.path??null;})()`);
		log(`s12c: B artifact path: ${artifactPath}`);

		const artifactContent = artifactPath ? await b.evalRaw<string | null>(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(artifactPath)});return f?await app.vault.read(f):null;})()`) : null;
		log(`s12c: B artifact content: ${JSON.stringify(artifactContent?.slice(0, 100))}`);

		if (!survivorContent) {
			errors.push("s12c: B survivor content is null");
		} else {
			if (!survivorContent.includes("LOCAL_ON_B")) errors.push("s12c: SEMANTIC FAIL -- B survivor does not contain LOCAL_ON_B (disk wins policy)");
			if (survivorContent.includes("REMOTE_FROM_A")) errors.push("s12c: SEMANTIC FAIL -- B survivor contains REMOTE_FROM_A (should be in artifact only)");
		}
		if (!artifactPath) {
			errors.push("s12c: No conflict artifact created on B");
		} else if (!artifactContent?.includes("REMOTE_FROM_A")) {
			errors.push(`s12c: SEMANTIC FAIL -- artifact does not contain REMOTE_FROM_A`);
		}

		// Markdown conflict artifacts are ordinary syncable notes. The artifact
		// created on B must therefore reach A with the preserved remote content.
		let artifactOnA = false;
		let artifactContentOnA: string | null = null;
		if (artifactPath) {
			artifactOnA = await a.evalRaw<boolean>(`
				(async () => {
					const path = ${JSON.stringify(artifactPath)};
					const deadline = Date.now() + 30000;
					while (Date.now() < deadline) {
						if (app.vault.getFileByPath(path)) return true;
						await new Promise(r => setTimeout(r, 500));
					}
					return false;
				})()
			`);
			if (artifactOnA) {
				artifactContentOnA = await a.evalRaw<string | null>(`
					(async () => {
						const f = app.vault.getFileByPath(${JSON.stringify(artifactPath)});
						return f ? await app.vault.read(f) : null;
					})()
				`);
			}
		}
		if (!artifactOnA) {
			errors.push("s12c: Markdown conflict artifact did not sync to A");
		} else if (!artifactContentOnA?.includes("REMOTE_FROM_A")) {
			errors.push("s12c: Synced conflict artifact on A does not contain REMOTE_FROM_A");
		}
		log(`s12c: artifact on A: ${artifactOnA} (expected: true)`);

		// B's recorder restarted with the plugin: settings.debug is still true, so
		// the reload brought a fresh trace up on its own. Give it a moment to arm.
		await new Promise((r) => setTimeout(r, 1000));


		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		if (artifactPath) {
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});
		}

		return {
			passedA: errors.length === 0,
			passedB: errors.length === 0,
			errors,
			evidence: {
				runId: RUN_ID,
				deviceIdA,
				deviceIdB,
				survivorContent: survivorContent?.slice(0, 200) ?? null,
				artifactPath,
				artifactContent: artifactContent?.slice(0, 200) ?? null,
				artifactOnA,
				artifactContentOnA: artifactContentOnA?.slice(0, 200) ?? null,
			},
		};
	},

	// ─────────────────────────────────────────────────────────────────────
	/**
	 * s15-schema-v3-metadata-sync
	 *
	 * End-to-end proof that schema v3 nested metadata changes drive correct
	 * disk mirror behavior on a remote device. Tests:
	 *
	 *   Phase 1: Create — file created on A appears on B's disk
	 *   Phase 2: Rename — active entry renamed on A → disk rename on B
	 *   Phase 3: Delete — file deleted on A → disk delete on B
	 *   Phase 4: Revive — file revived (un-deleted) on A → disk write on B
	 *   Phase 5: mtime  — mtime-only save on A → B's disk file unchanged
	 *   Phase 6: Schema — both devices have sys.schemaVersion === 3
	 *
	 * This scenario deliberately avoids using YAOS private APIs to trigger
	 * metadata changes — it uses only the public vault operations (create,
	 * rename, delete, re-create) so the test proves the full production path.
	 */
	"s15-schema-v3-metadata-sync": async (a, b, log) => {
		const errors: string[] = [];
		const P = {
			create:     "QA-scratch/s15-create-test.md",
			rename_src: "QA-scratch/s15-rename-src.md",
			rename_dst: "QA-scratch/s15-rename-dst.md",
			del:        "QA-scratch/s15-delete-test.md",
			revive:     "QA-scratch/s15-revive-test.md",
			mtime:      "QA-scratch/s15-mtime-test.md",
		};
		const CONTENT = {
			create:     "# S15 Create\n\nCreated on device A.\n",
			rename_src: "# S15 Rename\n\nWill be renamed.\n",
			del:        "# S15 Delete\n\nWill be deleted.\n",
			revive:     "# S15 Revive\n\nWill be deleted then revived.\n",
			mtime:      "# S15 Mtime\n\nContent stays the same. mtime changes only.\n",
		};

		/** Wait for a file to disappear from a device's disk. */
		async function waitForDeletion(client: ObsidianClient, path: string, timeoutMs = 20_000): Promise<boolean> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const exists = await client.evalRaw<boolean>(
					`!!app.vault.getAbstractFileByPath(${JSON.stringify(path)})`,
				);
				if (!exists) return true;
				await new Promise((r) => setTimeout(r, 500));
			}
			return false;
		}

		/** Get content hash via the YAOS debug API. */
		async function diskHash(client: ObsidianClient, path: string): Promise<string | null> {
			return client.evalRaw<string | null>(
				`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(path)}) ?? null`,
			);
		}

		/** Assert hash equality; push to errors if not. */
		function assertHashMatch(hA: string | null, hB: string | null, label: string): void {
			if (!hA || !hB) {
				errors.push(`${label}: null hash — A=${hA?.slice(0, 12) ?? "null"} B=${hB?.slice(0, 12) ?? "null"}`);
			} else if (hA !== hB) {
				errors.push(`${label}: hash mismatch — A=${hA.slice(0, 12)} B=${hB.slice(0, 12)}`);
			} else {
				log(`${label}: hash match ✓ (${hA.slice(0, 12)})`);
			}
		}

		// ── Cleanup any leftovers from a previous run ──────────────────────
		for (const path of Object.values(P)) {
			await a.evalRaw(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(path)});if(f)await app.vault.delete(f);})()`).catch(() => {});
		}
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(5000)`).catch(() => {});
		log("s15: cleanup done");

		// ── Phase 1: Create ────────────────────────────────────────────────
		log("\n─── Phase 1: Create ───");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.create)}, ${JSON.stringify(CONTENT.create)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.create)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));

		const createHashA = await diskHash(a, P.create);
		const createHashB = await diskHash(b, P.create);
		assertHashMatch(createHashA, createHashB, "Phase 1 create");

		// ── Phase 2: Rename ────────────────────────────────────────────────
		log("\n─── Phase 2: Rename ───");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.rename_src)}, ${JSON.stringify(CONTENT.rename_src)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.rename_src)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);

		// Rename on A using Obsidian vault API
		await a.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(P.rename_src)});
				if (f) await app.fileManager.renameFile(f, ${JSON.stringify(P.rename_dst)});
			})()
		`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.rename_dst)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);
		await new Promise((r) => setTimeout(r, 3000));

		const renameHashA = await diskHash(a, P.rename_dst);
		const renameHashB = await diskHash(b, P.rename_dst);
		assertHashMatch(renameHashA, renameHashB, "Phase 2 rename dst");

		const oldPathGoneOnB = await b.evalRaw<boolean>(`!app.vault.getAbstractFileByPath(${JSON.stringify(P.rename_src)})`);
		if (!oldPathGoneOnB) {
			errors.push(`Phase 2 rename: old path still exists on B: ${P.rename_src}`);
		} else {
			log(`Phase 2 rename: old path gone on B ✓`);
		}

		// ── Phase 3: Delete ────────────────────────────────────────────────
		log("\n─── Phase 3: Delete ───");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.del)}, ${JSON.stringify(CONTENT.del)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.del)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);

		// Delete on A
		await a.evalRaw(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(P.del)});if(f)await app.vault.delete(f);})()`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);

		const delGoneOnB = await waitForDeletion(b, P.del, 25_000);
		if (!delGoneOnB) {
			errors.push(`Phase 3 delete: file still exists on B after 25s: ${P.del}`);
		} else {
			log(`Phase 3 delete: file gone on B ✓`);
		}

		// ── Phase 4: Revive (delete then re-create) ────────────────────────
		log("\n─── Phase 4: Revive ───");
		// Create the revive file
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.revive)}, ${JSON.stringify(CONTENT.revive)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.revive)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);

		// Delete it on A
		await a.evalRaw(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(P.revive)});if(f)await app.vault.delete(f);})()`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await waitForDeletion(b, P.revive, 20_000);
		log("Phase 4: file deleted on both, now reviving...");

		// Revive: re-create with same content on A (YAOS will lift the tombstone)
		const REVIVE_CONTENT = "# S15 Revive\n\nRevived content after deletion.\n";
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.revive)}, ${JSON.stringify(REVIVE_CONTENT)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.revive)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);
		await new Promise((r) => setTimeout(r, 3000));

		const reviveHashA = await diskHash(a, P.revive);
		const reviveHashB = await diskHash(b, P.revive);
		assertHashMatch(reviveHashA, reviveHashB, "Phase 4 revive");

		// ── Phase 5: mtime-only save ───────────────────────────────────────
		log("\n─── Phase 5: mtime-only ───");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(P.mtime)}, ${JSON.stringify(CONTENT.mtime)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(12000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(P.mtime)}, 25000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`);
		await new Promise((r) => setTimeout(r, 3000));

		// Capture B's hash before the mtime bump
		const mtimeHashBefore = await diskHash(b, P.mtime);
		log(`Phase 5: B disk hash before mtime bump: ${mtimeHashBefore?.slice(0, 12)}`);

		// Trigger a save on A without changing content — use the Obsidian API
		// to touch the file's modification time only (write same content back)
		await a.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(P.mtime)});
				if (f) {
					const content = await app.vault.read(f);
					await app.vault.modify(f, content);  // same content, bumps mtime
				}
			})()
		`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 8000)); // extra time for any spurious writes

		const mtimeHashAfter = await diskHash(b, P.mtime);
		log(`Phase 5: B disk hash after mtime bump: ${mtimeHashAfter?.slice(0, 12)}`);

		if (mtimeHashBefore && mtimeHashAfter && mtimeHashBefore === mtimeHashAfter) {
			log(`Phase 5: B disk hash unchanged after mtime-only save ✓`);
		} else {
			errors.push(`Phase 5 mtime: B disk hash changed after mtime-only save — before=${mtimeHashBefore?.slice(0, 12)}, after=${mtimeHashAfter?.slice(0, 12)} (spurious rewrite)`);
		}

		// ── Phase 6: Schema version ────────────────────────────────────────
		log("\n─── Phase 6: Schema version ───");
		const schemaA = await a.evalRaw<unknown>(`app.plugins?.plugins?.yaos?.vaultSync?.sys?.get?.("schemaVersion") ?? null`);
		const schemaB = await b.evalRaw<unknown>(`app.plugins?.plugins?.yaos?.vaultSync?.sys?.get?.("schemaVersion") ?? null`);
		log(`Phase 6: schemaVersion A=${schemaA} B=${schemaB}`);

		if (schemaA !== 3) errors.push(`Phase 6: Device A schemaVersion is ${schemaA}, expected 3`);
		if (schemaB !== 3) errors.push(`Phase 6: Device B schemaVersion is ${schemaB}, expected 3`);
		if (schemaA === 3 && schemaB === 3) log("Phase 6: both devices at schema v3 ✓");

		// ── Cleanup ────────────────────────────────────────────────────────
		for (const path of Object.values(P)) {
			await a.evalRaw(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(path)});if(f)await app.vault.delete(f);})()`).catch(() => {});
		}
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`).catch(() => {});

		const passedA = errors.length === 0;
		const passedB = errors.length === 0;

		if (errors.length === 0) {
			log("\n✓ s15 PASS — all schema v3 metadata sync phases verified");
		} else {
			log(`\n✗ s15 FAIL — ${errors.length} error(s)`);
		}

		return { passedA, passedB, errors };
	},
};
