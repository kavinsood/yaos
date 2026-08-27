import { TFile } from "obsidian";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { RecoveryBackupHook } from "../../src/snapshots/recoveryBackup";
import { suite } from "../harness.ts";

installDomCrypto();

const s = suite("recovery-backup");

s.test("backup completes before replacement and detects a changed review target", async () => {
	const file = new TFile();
	file.path = "Note.md";
	file.extension = "md";
	let diskContent = "before";
	const events: string[] = [];
	const app = {
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (path: string) => path === file.path ? file : null,
			read: async () => diskContent,
			readBinary: async () => new TextEncoder().encode(diskContent).buffer,
			adapter: {
				exists: async () => true,
				mkdir: async () => {},
				write: async (_path: string, content: string) => { events.push(`backup:${content}`); },
				writeBinary: async () => { events.push("backup:binary"); },
			},
		},
	} as never;
	const hook = new RecoveryBackupHook(app, {
		now: () => new Date("2026-08-27T00:00:00.000Z"),
	});
	const backup = await hook.backupBeforeReplacement([file.path]);
	const review = backup.reviews.get(file.path);
	if (!review) throw new Error("backup omitted disk review");
	events.push("candidate");
	if (!backup.complete || events.join(",") !== "backup:before,candidate") {
		throw new Error("candidate could proceed before the disk backup completed");
	}
	diskContent = "changed after review";
	if (await hook.targetStillMatches(review, file.path)) {
		throw new Error("changed-during-review target was not fenced");
	}
});

s.test("missing targets are reviewed as absent and fenced if recreated", async () => {
	const file = new TFile();
	file.path = "Deleted.md";
	file.extension = "md";
	let recreated = false;
	const app = {
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: () => recreated ? file : null,
			read: async () => "new file",
			readBinary: async () => new ArrayBuffer(0),
			adapter: {
				exists: async () => true,
				mkdir: async () => {},
				write: async () => {},
				writeBinary: async () => {},
			},
		},
	} as never;
	const hook = new RecoveryBackupHook(app);
	const backup = await hook.backupBeforeReplacement([file.path]);
	const review = backup.reviews.get(file.path);
	if (!review || review.exists) throw new Error("missing target review was not captured");
	recreated = true;
	if (await hook.targetStillMatches(review, file.path)) {
		throw new Error("fresh restore could overwrite a path recreated after review");
	}
});

await s.done();
