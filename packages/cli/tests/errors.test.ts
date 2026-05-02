import assert from "node:assert/strict";
import test from "node:test";
import { CLI_EXIT_CODES, exitCodeForError, HeadlessCliError } from "../src/errors";

test("exitCodeForError preserves commander exit codes", () => {
	assert.equal(exitCodeForError({ exitCode: 0 }), CLI_EXIT_CODES.success);
	assert.equal(exitCodeForError({ exitCode: 9 }), 9);
});

test("exitCodeForError maps update_required to a non-restarting daemon code", () => {
	assert.equal(CLI_EXIT_CODES.updateRequired, 2);
	assert.notEqual(CLI_EXIT_CODES.updateRequired, CLI_EXIT_CODES.failure);
	assert.notEqual(CLI_EXIT_CODES.updateRequired, CLI_EXIT_CODES.success);
	assert.equal(
		exitCodeForError(new HeadlessCliError("update required", "update_required")),
		CLI_EXIT_CODES.updateRequired,
	);
});

test("exitCodeForError maps other failures to generic failure", () => {
	assert.equal(exitCodeForError(new HeadlessCliError("unauthorized", "unauthorized")), CLI_EXIT_CODES.failure);
	assert.equal(exitCodeForError(new Error("boom")), CLI_EXIT_CODES.failure);
});
