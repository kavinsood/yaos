export interface ObsidianCdpTarget {
	type?: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export function selectObsidianTarget(targets: unknown): ObsidianCdpTarget | null;

export interface ObsidianClientOptions {
	port?: number;
	host?: string;
	connectTimeoutMs?: number;
}

export interface ScenarioResult {
	passed: boolean;
	durationMs: number;
	errors: string[];
	warnings: string[];
}

export interface BuildIdentity {
	[key: string]: string;
	pluginVersion: string;
	bundleHash: string;
	obsidianVersion: string;
	electronVersion: string;
	chromeVersion: string;
	platform: string;
	vaultName: string;
}

export class ObsidianClient {
	constructor(options?: ObsidianClientOptions);
	connect(): Promise<void>;
	evalRaw<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
	evalInObsidian<T>(fn: () => T | Promise<T>): Promise<T>;
	isQaReady(): Promise<boolean>;
	waitForQaReady(timeoutMs?: number): Promise<void>;
	runScenario(id: string): Promise<ScenarioResult>;
	manifest(): Promise<unknown>;
	debugState(): Promise<{
		localReady: boolean;
		providerSynced: boolean;
		reconciled: boolean;
		serverReceiptState: string;
		connectionState: string;
		activeMarkdownPaths: string[];
	}>;
	exportTrace(privacy?: "safe" | "full"): Promise<string>;
	getBuildIdentity(): Promise<BuildIdentity>;
	close(): Promise<void>;
}
