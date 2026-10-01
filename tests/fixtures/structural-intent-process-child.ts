import { strict as assert } from "node:assert";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exactMarkdownDiskFingerprint } from "../../server/src/shared/markdownCodec";
import {
	cloneStructuralIntent,
	sameStructuralPlan,
	sameStructuralScope,
	StructuralIntentRecovery,
	validateStructuralIntent,
	type StoredStructuralIntent,
	type StructuralIntentDiskHost,
	type StructuralIntentScope,
	type StructuralIntentStore,
	type StructuralLocation,
	type StructuralMoveInput,
	type StructuralRenamePlan,
} from "../../src/sync/structuralIntent";

const scope: StructuralIntentScope = {
	vaultId: "process-vault", vaultGeneration: "process-generation", accountId: "process-account", folderKey: "process-folder",
};
const directory = process.argv[2]!;
const mode = process.argv[3]!;
const haltAt = process.argv[4] ?? "";
let writes = 0;
let moves = 0;

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${++writes}.tmp`;
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally { await handle.close(); }
	await rename(temporary, path);
	await syncDirectory(dirname(path));
}

async function checkpoint(name: string): Promise<void> {
	if (name !== haltAt) return;
	process.send?.({ kind: "checkpoint", name });
	setInterval(() => {}, 1000);
	await new Promise<void>(() => {});
}

class DurableFileIntentStore implements StructuralIntentStore {
	private file(operationId: string): string {
		return join(directory, "intents", `${encodeURIComponent(operationId)}.json`);
	}
	async get(operationId: string): Promise<StoredStructuralIntent | null> {
		try {
			const value = JSON.parse(await readFile(this.file(operationId), "utf8")) as StoredStructuralIntent;
			validateStructuralIntent(value);
			assert.ok(sameStructuralScope(value.scope, scope));
			return value;
		} catch (error) { if (isMissing(error)) return null; throw error; }
	}
	async list(): Promise<StoredStructuralIntent[]> {
		const values: StoredStructuralIntent[] = [];
		let names: string[];
		try { names = await readdir(join(directory, "intents")); }
		catch (error) { if (isMissing(error)) return []; throw error; }
		for (const name of names.filter((entry) => entry.endsWith(".json"))) {
			const value = await this.get(decodeURIComponent(name.slice(0, -5)));
			if (value) values.push(value);
		}
		return values;
	}
	async put(intent: StoredStructuralIntent): Promise<void> {
		validateStructuralIntent(intent);
		assert.ok(sameStructuralScope(intent.scope, scope));
		const current = await this.get(intent.operationId);
		if (current) {
			assert.ok(sameStructuralPlan(current, intent));
			assert.ok(current.phase !== "placing" || intent.phase === "placing");
		}
		await durableWrite(this.file(intent.operationId), cloneStructuralIntent(intent));
		if (intent.phase === "placing") await checkpoint("placing-persisted");
	}
	async delete(operationId: string): Promise<void> {
		await checkpoint("before-delete");
		await unlink(this.file(operationId));
		await syncDirectory(join(directory, "intents"));
	}
}

class RealDiskHost implements StructuralIntentDiskHost {
	private file(path: string): string { return join(directory, "vault", path); }
	async inspect(path: string): Promise<StructuralLocation> {
		try {
			const metadata = await lstat(this.file(path));
			if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: "other" };
			return { kind: "file", content: await readFile(this.file(path), "utf8") };
		} catch (error) { if (isMissing(error)) return { kind: "missing" }; throw error; }
	}
	async moveIfMatches(input: StructuralMoveInput): Promise<boolean> {
		const source = await this.inspect(input.from);
		if (source.kind !== "file" || source.content !== input.expectedContent) return false;
		assert.deepEqual(await exactMarkdownDiskFingerprint(source.content), input.fingerprint);
		await mkdir(dirname(this.file(input.to)), { recursive: true });
		try { await link(this.file(input.from), this.file(input.to)); }
		catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
			throw error;
		}
		await syncDirectory(dirname(this.file(input.to)));
		await unlink(this.file(input.from));
		await syncDirectory(dirname(this.file(input.from)));
		await checkpoint(`move-${++moves}`);
		return true;
	}
	async completeBookkeeping(intent: StoredStructuralIntent): Promise<void> {
		await checkpoint("before-bookkeeping");
		await durableWrite(join(directory, "bookkeeping.json"), {
			operationId: intent.operationId, paths: intent.moves.map((move) => ({ bodyId: move.bodyId, path: move.to })),
		});
		await checkpoint("bookkeeping-completed");
	}
}

async function makePlan(): Promise<StructuralRenamePlan> {
	const contents = JSON.parse(await readFile(join(directory, "contents.json"), "utf8")) as string[];
	return { operationId: "process-rename", scope, createdAt: 1, moves: await Promise.all(contents.map(async (expectedContent, index) => ({
		bodyId: `body-${index}`, from: ["alpha.md", "beta.md"][index]!, staging: `.rename-${index}.md`,
		to: ["beta.md", "alpha.md"][index]!, expectedContent, fingerprint: await exactMarkdownDiskFingerprint(expectedContent),
	}))) };
}

const recovery = new StructuralIntentRecovery(scope, new DurableFileIntentStore(), new RealDiskHost());
if (mode === "start") {
	await recovery.prepare(await makePlan());
	await checkpoint("prepared");
}
const results = await recovery.recoverAll();
process.send?.({ kind: "result", results });
