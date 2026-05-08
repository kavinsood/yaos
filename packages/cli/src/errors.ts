export const CLI_EXIT_CODES = {
	success: 0,
	failure: 1,
	updateRequired: 2,
} as const;

export type HeadlessFatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

export class HeadlessCliError extends Error {
	constructor(
		message: string,
		readonly fatalAuthCode?: HeadlessFatalAuthCode | null,
	) {
		super(message);
		this.name = "HeadlessCliError";
	}
}

export function exitCodeForError(error: unknown): number {
	const commanderExitCode = (error as { exitCode?: unknown })?.exitCode;
	if (typeof commanderExitCode === "number") {
		return commanderExitCode;
	}
	if (error instanceof HeadlessCliError && error.fatalAuthCode === "update_required") {
		return CLI_EXIT_CODES.updateRequired;
	}
	return CLI_EXIT_CODES.failure;
}
