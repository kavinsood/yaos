import { App, TFile, normalizePath } from "obsidian";
import { formatUnknown } from "../utils/format";
import { sha256BytesHex } from "../utils/sha256";

export type RecoveryDiskReview =
	| { exists: false }
	| { exists: true; sha256: string; size: number };

export interface RecoveryBackupFailure {
	path: string;
	error: string;
}

export interface RecoveryBackupReport {
	backupRoot: string;
	backedUp: string[];
	missing: string[];
	failures: RecoveryBackupFailure[];
	reviews: Map<string, RecoveryDiskReview>;
	complete: boolean;
}

export interface RecoveryBackupHookOptions {
	now?: () => Date;
	root?: string;
	log?(message: string): void;
}

/**
 * Disk safety hook for recovery restore. Call and require `complete` before any
 * body candidate or lifecycle replacement is submitted to the server.
 */
export class RecoveryBackupHook {
	private readonly now: () => Date;
	private readonly root: string;

	constructor(private readonly app: App, private readonly options: RecoveryBackupHookOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.root = normalizePath(options.root ?? `${app.vault.configDir}/plugins/yaos/restore-backups`);
	}
	async backupBeforeReplacement(paths: string[]): Promise<RecoveryBackupReport> {
		const session = `${this.now().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
		const backupRoot = normalizePath(`${this.root}/${session}`);
		const report: RecoveryBackupReport = {
			backupRoot,
			backedUp: [],
			missing: [],
			failures: [],
			reviews: new Map(),
			complete: false,
		};
		const uniquePaths = Array.from(new Set(paths));
		for (const rawPath of uniquePaths) {
			try {
				const path = this.safeVaultPath(rawPath);
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file === null) {
					report.missing.push(path);
					report.reviews.set(path, { exists: false });
					continue;
				}
				if (!(file instanceof TFile)) {
					throw new Error("restore target is not a file");
				}
				const target = normalizePath(`${backupRoot}/${path}`);
				await this.ensureParent(target);
				const markdown = file.extension.toLowerCase() === "md";
				let bytes: Uint8Array;
				if (markdown) {
					const content = await this.app.vault.read(file);
					bytes = new TextEncoder().encode(content);
					await this.app.vault.adapter.write(target, new TextDecoder().decode(bytes));
				} else {
					const buffer = await this.app.vault.readBinary(file);
					bytes = new Uint8Array(buffer);
					await this.app.vault.adapter.writeBinary(target, buffer);
				}
				report.reviews.set(path, {
					exists: true,
					sha256: await sha256BytesHex(bytes),
					size: bytes.byteLength,
				});
				report.backedUp.push(path);
			} catch (error) {
				report.failures.push({ path: rawPath, error: formatUnknown(error) });
			}
		}
		report.complete = report.failures.length === 0;
		this.options.log?.(
			`Pre-restore backup ${report.complete ? "complete" : "failed"}: ` +
			`${report.backedUp.length} saved, ${report.missing.length} absent, ${report.failures.length} failed at ${backupRoot}`,
		);
		return report;
	}

	async targetStillMatches(review: RecoveryDiskReview, rawPath: string): Promise<boolean> {
		const path = this.safeVaultPath(rawPath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!review.exists) return file === null;
		if (!(file instanceof TFile)) return false;
		const bytes = file.extension.toLowerCase() === "md"
			? new TextEncoder().encode(await this.app.vault.read(file))
			: new Uint8Array(await this.app.vault.readBinary(file));
		return bytes.byteLength === review.size && await sha256BytesHex(bytes) === review.sha256;
	}

	private safeVaultPath(path: string): string {
		const normalized = normalizePath(path);
		if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("invalid restore backup path");
		}
		return normalized;
	}

	private async ensureParent(path: string): Promise<void> {
		const segments = path.split("/");
		segments.pop();
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!await this.app.vault.adapter.exists(current)) await this.app.vault.adapter.mkdir(current);
		}
	}
}
