/**
 * Artifact collection utilities for QA runs.
 *
 * Collects: trace exports, vault manifests, screenshots (if available),
 * and writes them to qa-runs/<timestamp>-<scenario>/.
 */

import { mkdir, cp, writeFile, readFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, resolve } from "path";

export interface ArtifactMeta {
	scenario: string;
	runId: string;
	startedAt: string;
	completedAt: string | null;
	device: string;
	vaultPath: string;
	tracePath?: string;
	passed?: boolean;
	errors?: string[];
}

export class ArtifactCollector {
	private readonly runDir: string;
	private readonly meta: ArtifactMeta;

	constructor(
		private readonly qaRunsRoot: string,
		scenario: string,
		device: string,
		vaultPath: string,
	) {
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const runId = `${ts}-${scenario}-${device}`;
		this.runDir = join(qaRunsRoot, runId);
		this.meta = {
			scenario,
			runId,
			startedAt: new Date().toISOString(),
			completedAt: null,
			device,
			vaultPath,
		};
	}

	async init(): Promise<void> {
		await mkdir(this.runDir, { recursive: true });
		await this.saveMeta();
	}

	get runDirectory(): string {
		return this.runDir;
	}

	/** Collect a flight trace file from a remote vault path. */
	async collectTrace(vaultTracePath: string): Promise<void> {
		if (!existsSync(vaultTracePath)) {
			console.warn(`Trace file not found: ${vaultTracePath}`);
			return;
		}
		const dest = join(this.runDir, "flight-trace.ndjson");
		await copyFile(vaultTracePath, dest);
		this.meta.tracePath = dest;
		await this.saveMeta();
	}

	/** Save a vault manifest JSON. */
	async saveManifest(manifest: unknown, label = "manifest"): Promise<void> {
		const dest = join(this.runDir, `${label}.json`);
		await writeFile(dest, JSON.stringify(manifest, null, 2), "utf-8");
	}

	/** Save scenario result. */
	async saveResult(result: {
		passed: boolean;
		durationMs: number;
		errors: string[];
		warnings: string[];
	}): Promise<void> {
		this.meta.passed = result.passed;
		this.meta.errors = result.errors;
		this.meta.completedAt = new Date().toISOString();
		await writeFile(join(this.runDir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
		await this.saveMeta();
	}

	/** Save analyzer report. */
	async saveAnalyzerReport(report: unknown): Promise<void> {
		await writeFile(
			join(this.runDir, "analyzer-report.json"),
			JSON.stringify(report, null, 2),
			"utf-8",
		);
	}

	/** Copy any extra files into the artifact dir. */
	async copyFile(srcPath: string, destName?: string): Promise<void> {
		const dest = join(this.runDir, destName ?? basename(srcPath));
		await copyFile(srcPath, dest);
	}

	/** Write raw text (e.g. console log, summary). */
	async writeLog(content: string, filename = "run.log"): Promise<void> {
		await writeFile(join(this.runDir, filename), content, "utf-8");
	}

	private async saveMeta(): Promise<void> {
		await writeFile(join(this.runDir, "meta.json"), JSON.stringify(this.meta, null, 2), "utf-8");
	}
}
