import { isAbsolute, resolve } from "path";

/** Resolve the path returned by the QA export API against the vault root. */
export function resolveTraceExportPath(tracePath: string, vaultRoot: string | null): string {
	if (isAbsolute(tracePath)) return tracePath;
	if (!vaultRoot) {
		throw new Error("a vault path is required to collect a relative trace export");
	}
	return resolve(vaultRoot, tracePath);
}
