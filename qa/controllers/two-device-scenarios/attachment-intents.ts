import type { ObsidianClient } from "../obsidian-client.mjs";
import type { TwoDeviceScenarios } from "./shared";
import { disableYaos, enableYaosAndWait } from "./shared";

const WAIT_MS = 30_000;

async function waitForAttachmentHead(
	client: ObsidianClient,
	path: string,
	kind: "active" | "deleted" | "missing",
	timeoutMs = WAIT_MS,
): Promise<Record<string, unknown>> {
	return client.evalRaw<Record<string, unknown>>(`
		(async () => {
			const deadline = Date.now() + ${timeoutMs};
			while (Date.now() < deadline) {
				const runtime = app.plugins?.plugins?.yaos?.vaultSync;
				const head = runtime?.getObservedAttachmentHead?.(${JSON.stringify(path)});
				if (head?.kind === ${JSON.stringify(kind)}) return head;
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			throw new Error("timed out waiting for attachment head ${kind}: ${path}");
		})()
	`);
}

async function waitForAttachmentRevision(
	client: ObsidianClient,
	path: string,
	previousRevision: unknown,
	timeoutMs = WAIT_MS,
): Promise<Record<string, unknown>> {
	return client.evalRaw<Record<string, unknown>>(`
		(async () => {
			const deadline = Date.now() + ${timeoutMs};
			while (Date.now() < deadline) {
				const runtime = app.plugins?.plugins?.yaos?.vaultSync;
				const head = runtime?.getObservedAttachmentHead?.(${JSON.stringify(path)});
				if (head?.kind === "active" && head.revision !== ${JSON.stringify(previousRevision)}) return head;
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			throw new Error("timed out waiting for attachment revision to advance: ${path}");
		})()
	`);
}

async function waitForDiskText(
	client: ObsidianClient,
	path: string,
	expected: string | null,
	timeoutMs = WAIT_MS,
): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const deadline = Date.now() + ${timeoutMs};
			while (Date.now() < deadline) {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
				if (${expected === null ? "file === null" : `file && await app.vault.read(file) === ${JSON.stringify(expected)}`}) return;
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			throw new Error("timed out waiting for attachment disk state: ${path}");
		})()
	`);
}

async function createTextAttachment(client: ObsidianClient, path: string, content: string): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const parent = ${JSON.stringify(path)}.split("/").slice(0, -1).join("/");
			if (parent && !app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
			const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (existing) await app.vault.modify(existing, ${JSON.stringify(content)});
			else await app.vault.create(${JSON.stringify(path)}, ${JSON.stringify(content)});
		})()
	`);
}

async function deleteIfPresent(client: ObsidianClient, path: string): Promise<void> {
	await client.evalRaw(`
		(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (file) await app.vault.delete(file, true);
		})()
	`).catch(() => undefined);
}

export const attachmentIntentScenarios: TwoDeviceScenarios = {
	"attachment-intent-field-shapes": async (a, b, log) => {
		const errors: string[] = [];
		const run = Date.now().toString(36);
		const folder = `QA-scratch/attachments-${run}`;
		const canvas = `${folder}/rapid.canvas`;
		const baseSource = `${folder}/pre-publication.base`;
		const baseTarget = `${folder}/renamed-before-publication.base`;
		const deletedBeforePublication = `${folder}/deleted-before-publication.canvas`;
		const stopResume = `${folder}/stop-resume.canvas`;
		const telemetryProbe = `${folder}/device-b-telemetry.canvas`;
		const canvasV1 = JSON.stringify({ nodes: [{ id: "one", type: "text", text: "version1", x: 0, y: 0, width: 200, height: 80 }], edges: [] });
		const canvasV2 = JSON.stringify({ nodes: [{ id: "one", type: "text", text: "version2", x: 0, y: 0, width: 200, height: 80 }], edges: [] });
		const canvasV3 = JSON.stringify({ nodes: [{ id: "one", type: "text", text: "version3", x: 0, y: 0, width: 200, height: 80 }], edges: [] });
		const baseV1 = "filters:\n  and: []\nviews:\n  - type: table\n    name: QA1\n";
		const baseV2 = "filters:\n  and: []\nviews:\n  - type: table\n    name: QA2\n";
		const baseV3 = "filters:\n  and: []\nviews:\n  - type: table\n    name: QA3\n";
		if (new Set([canvasV1.length, canvasV2.length, canvasV3.length]).size !== 1
			|| new Set([baseV1.length, baseV2.length, baseV3.length]).size !== 1) {
			throw new Error("attachment field fixtures must remain same-size rewrites");
		}

		try {
			log("Attachment field QA: Canvas create and rapid rewrites...");
			await createTextAttachment(a, canvas, canvasV1);
			const first = await waitForAttachmentHead(a, canvas, "active");
			await waitForDiskText(b, canvas, canvasV1);
			await createTextAttachment(a, canvas, canvasV2);
			await createTextAttachment(a, canvas, canvasV3);
			const finalHead = await waitForAttachmentRevision(a, canvas, first.revision);
			await waitForDiskText(b, canvas, canvasV3);
			if (first.revision === finalHead.revision) errors.push("rapid Canvas rewrite did not advance attachment revision");

			log("Attachment field QA: same-size Base rewrites and rename before first publication...");
			await createTextAttachment(a, baseSource, baseV1);
			await createTextAttachment(a, baseSource, baseV2);
			await createTextAttachment(a, baseSource, baseV3);
			await a.evalRaw(`
				(async () => {
					const file = app.vault.getAbstractFileByPath(${JSON.stringify(baseSource)});
					if (!file) throw new Error("Base source missing before rename");
					await app.fileManager.renameFile(file, ${JSON.stringify(baseTarget)});
				})()
			`);
			await waitForAttachmentHead(a, baseTarget, "active");
			await waitForDiskText(b, baseTarget, baseV3);
			const oldHead = await a.evalRaw<Record<string, unknown>>(`app.plugins.plugins.yaos.vaultSync.getObservedAttachmentHead(${JSON.stringify(baseSource)})`);
			if (oldHead.kind === "active") errors.push("pre-publication Base rename left the source active");

			log("Attachment field QA: delete before first publication...");
			await createTextAttachment(a, deletedBeforePublication, canvasV1);
			await deleteIfPresent(a, deletedBeforePublication);
			await waitForAttachmentHead(a, deletedBeforePublication, "deleted");
			await waitForDiskText(b, deletedBeforePublication, null);

			log("Attachment field QA: stop during debounce persists intent without publishing stale work...");
			await createTextAttachment(a, stopResume, canvasV1);
			if (!await disableYaos(a)) errors.push("YAOS did not disable for stop/resume attachment check");
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const whileStopped = await b.evalRaw<Record<string, unknown>>(`app.plugins.plugins.yaos.vaultSync.getObservedAttachmentHead(${JSON.stringify(stopResume)})`);
			if (whileStopped.kind === "active") errors.push("attachment published after YAOS stop during debounce");
			if (!await enableYaosAndWait(a)) errors.push("YAOS did not re-enable after stop/resume attachment check");
			await waitForAttachmentHead(a, stopResume, "active");
			await waitForDiskText(b, stopResume, canvasV1);

			log("Attachment field QA: device B telemetry publication probe...");
			await createTextAttachment(b, telemetryProbe, canvasV2);
			await waitForAttachmentHead(b, telemetryProbe, "active");
			await waitForDiskText(a, telemetryProbe, canvasV2);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		} finally {
			for (const path of [canvas, baseSource, baseTarget, deletedBeforePublication, stopResume, telemetryProbe]) {
				await deleteIfPresent(a, path);
				await deleteIfPresent(b, path);
			}
		}

		return {
			passedA: errors.length === 0,
			passedB: errors.length === 0,
			errors,
			evidence: { shapes: ["canvas", "base"], excalidraw: "intentionally-omitted" },
		};
	},
};
