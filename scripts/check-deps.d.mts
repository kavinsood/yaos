// Types for check-deps.mjs's exports, so src/host/checkDeps.test.ts imports them typed instead of through
// @ts-expect-error (which left every call an error type to the typed lint rules). Keep in sync with the .mjs.

export interface ImportRef {
	spec: string;
	typeOnly: boolean;
	line: number;
}

export interface CheckResult {
	errors: string[];
	warnings: string[];
}

export declare const MAIN_FORBIDDEN: string[];
export declare const MAIN_FORBIDDEN_DIRS: string[];
export declare const INLINE_TRANSPORT: string;
/** [label, pattern] pairs. */
export declare const FULL_READS: [string, RegExp][];
/** file -> pattern label -> [count, why]. */
export declare const FULL_READ_ALLOW: Record<string, Record<string, [number, string]>>;

/** Imports of one file. */
export declare function scanImports(text: string): ImportRef[];
/** Check one file; `file` is src-relative posix ("engine/workerMain.ts"). */
export declare function checkSource(file: string, text: string): CheckResult;
/** Transitive main-thread check over src-relative path -> text; returns error lines. */
export declare function mainReach(sources: Map<string, string>): string[];
/** Check every file under srcDir (default src/). */
export declare function checkTree(srcDir?: string): CheckResult & { files: number };
