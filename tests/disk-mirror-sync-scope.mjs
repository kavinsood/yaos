import assert from "node:assert/strict";

class DiskMirrorSyncScopeHarness {
	constructor(isPathSyncable) {
		this.isPathSyncable = isPathSyncable;
		this.calls = [];
		this.writeQueue = new Set();
		this.forcedWritePaths = new Set();
		this.debounceTimers = new Map();
		this.openWriteTimers = new Map();
		this.pendingOpenWrites = new Set();
	}

	clearPendingWrites(path) {
		this.pendingOpenWrites.delete(path);
		this.writeQueue.delete(path);
		this.forcedWritePaths.delete(path);
		this.debounceTimers.delete(path);
		this.openWriteTimers.delete(path);
	}

	scheduleWrite(path) {
		if (!this.isPathSyncable(path)) {
			this.clearPendingWrites(path);
			return;
		}
		this.debounceTimers.set(path, true);
	}

	async flushWrite(path) {
		if (!this.isPathSyncable(path)) {
			this.clearPendingWrites(path);
			return;
		}
		this.calls.push(`write:${path}`);
	}

	async handleRemoteDelete(path) {
		if (!this.isPathSyncable(path)) {
			this.clearPendingWrites(path);
			return;
		}
		this.calls.push(`delete:${path}`);
	}

	async handleRemoteRename(oldPath, newPath) {
		if (!this.isPathSyncable(oldPath) || !this.isPathSyncable(newPath)) {
			this.clearPendingWrites(oldPath);
			this.clearPendingWrites(newPath);
			return;
		}
		this.calls.push(`rename:${oldPath}->${newPath}`);
	}
}

const isSyncable = (path) =>
	path.endsWith(".md") && !path.startsWith("references/") && !path.startsWith("archives/");

console.log("\n--- Test: DiskMirror sync-scope guard policy ---");

{
	const mirror = new DiskMirrorSyncScopeHarness(isSyncable);
	mirror.scheduleWrite("references/www/stale.md");
	assert.equal(mirror.debounceTimers.size, 0, "excluded remote writes are not scheduled");
}

{
	const mirror = new DiskMirrorSyncScopeHarness(isSyncable);
	await mirror.flushWrite("archives/tasks/completed.md");
	assert.deepEqual(mirror.calls, [], "excluded remote flushes do not write or create files");
}

{
	const mirror = new DiskMirrorSyncScopeHarness(isSyncable);
	await mirror.handleRemoteDelete("references/www/stale.md");
	assert.deepEqual(mirror.calls, [], "excluded remote deletes do not touch disk");
}

{
	const mirror = new DiskMirrorSyncScopeHarness(isSyncable);
	await mirror.handleRemoteRename("tasks/live.md", "archives/tasks/live.md");
	assert.deepEqual(mirror.calls, [], "renames crossing sync scope do not move or recreate files");
}

{
	const mirror = new DiskMirrorSyncScopeHarness(isSyncable);
	mirror.scheduleWrite("tasks/live.md");
	await mirror.flushWrite("tasks/live.md");
	await mirror.handleRemoteDelete("tasks/live.md");
	await mirror.handleRemoteRename("tasks/old.md", "tasks/new.md");
	assert.deepEqual(mirror.calls, [
		"write:tasks/live.md",
		"delete:tasks/live.md",
		"rename:tasks/old.md->tasks/new.md",
	], "syncable paths still flow through normal remote disk operations");
}

console.log("  PASS  remote CRDT disk operations are gated by sync scope");
