import { type App, TFile } from "obsidian";
import type {
	LocalFileRevision,
	LocalInventoryEntry,
	LocalVaultImportSink,
	LocalVaultImportSinkInput,
	LocalVaultImportSource,
} from "./localVaultImport";

export class ObsidianLocalVaultImportSource implements LocalVaultImportSource {
	constructor(private readonly app: App) {}

	async captureInventory(): Promise<readonly LocalInventoryEntry[]> {
		return this.app.vault.getMarkdownFiles().map((file) => ({
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
		}));
	}

	async read(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`local import file is unavailable: ${path}`);
		return this.app.vault.read(file);
	}

	async stat(path: string): Promise<LocalFileRevision | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile
			? { mtime: file.stat.mtime, size: file.stat.size }
			: null;
	}
}

export interface FreshBodyAdmissionPort {
	getFileId(path: string): string | undefined;
	commitDiskBody(input: {
		bodyId: string;
		path: string;
		content: string;
		reason: "initial-local-vault-import";
		lifecycle?: "create";
		candidateId: string;
	}): Promise<unknown>;
	commitFreshBodies(inputs: readonly {
		bodyId: string;
		path: string;
		content: string;
		reason: "initial-local-vault-import";
		candidateId: string;
	}[]): Promise<{ results: Array<{ bodyId: string }> }>;
}

/** Routes imported notes through an injected durable fresh-body admission port. */
export class FreshBodyAdmissionLocalVaultImportSink implements LocalVaultImportSink {
	constructor(
		private readonly getRuntime: () => FreshBodyAdmissionPort | null,
		private readonly schedulePathWork: (
			paths: readonly string[],
			work: () => Promise<void>,
		) => Promise<void>,
	) {}

	async importFile(input: LocalVaultImportSinkInput): Promise<{ bodyId: string }> {
		const result = { bodyId: input.bodyId };
		await this.schedulePathWork([input.path], async () => {
			const runtime = this.getRuntime();
			if (!runtime) throw new Error("sync runtime is not ready for initial import");
			const activeBodyId = runtime.getFileId(input.path);
			const bodyId = activeBodyId ?? input.bodyId;
			await runtime.commitDiskBody({
				bodyId,
				path: input.path,
				content: input.content,
				reason: "initial-local-vault-import",
				...(activeBodyId ? {} : { lifecycle: "create" as const }),
				candidateId: input.candidateId,
			});
			result.bodyId = bodyId;
		});
		return result;
	}

	async importFiles(
		inputs: readonly LocalVaultImportSinkInput[],
	): Promise<Array<{ bodyId: string }>> {
		const results = inputs.map((input) => ({ bodyId: input.bodyId }));
		await this.schedulePathWork(inputs.map((input) => input.path), async () => {
			const runtime = this.getRuntime();
			if (!runtime) throw new Error("sync runtime is not ready for initial import");
			const fresh: Array<{ index: number; input: LocalVaultImportSinkInput }> = [];
			for (let index = 0; index < inputs.length; index++) {
				const input = inputs[index]!;
				const activeBodyId = runtime.getFileId(input.path);
				if (activeBodyId) {
					await runtime.commitDiskBody({
						bodyId: activeBodyId,
						path: input.path,
						content: input.content,
						reason: "initial-local-vault-import",
						candidateId: input.candidateId,
					});
					results[index] = { bodyId: activeBodyId };
				} else {
					fresh.push({ index, input });
				}
			}
			if (fresh.length === 0) return;
			const committed = await runtime.commitFreshBodies(
				fresh.map(({ input }) => ({
					bodyId: input.bodyId,
					path: input.path,
					content: input.content,
					reason: "initial-local-vault-import",
					candidateId: input.candidateId,
				})),
			);
			if (committed.results.length !== fresh.length) {
				throw new Error("fresh import batch result count mismatch");
			}
			for (let index = 0; index < fresh.length; index++) {
				results[fresh[index]!.index] = {
					bodyId: committed.results[index]!.bodyId,
				};
			}
		});
		return results;
	}
}
