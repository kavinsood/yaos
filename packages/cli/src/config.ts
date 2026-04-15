import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { ExternalEditPolicy } from "../../../src/settings";

const DEFAULT_CONFIG_DIR = ".obsidian";

export interface CliCommandOptions {
	host?: string;
	token?: string;
	vaultId?: string;
	dir?: string;
	deviceName?: string;
	debug?: boolean;
	excludePatterns?: string;
	maxFileSizeKB?: number;
	externalEditPolicy?: ExternalEditPolicy;
	frontmatterGuardEnabled?: boolean;
	configDir?: string;
}

export interface CliFileConfig {
	host?: string;
	token?: string;
	vaultId?: string;
	dir?: string;
	deviceName?: string;
	debug?: boolean;
	excludePatterns?: string;
	maxFileSizeKB?: number;
	externalEditPolicy?: ExternalEditPolicy;
	frontmatterGuardEnabled?: boolean;
	configDir?: string;
}

export interface ResolvedCliConfig {
	host?: string;
	token?: string;
	vaultId?: string;
	dir?: string;
	deviceName: string;
	debug: boolean;
	excludePatterns: string;
	maxFileSizeKB: number;
	externalEditPolicy: ExternalEditPolicy;
	frontmatterGuardEnabled: boolean;
	configDir: string;
	configPath: string;
}

export interface RuntimeCliConfig extends ResolvedCliConfig {
	host: string;
	token: string;
	vaultId: string;
	dir: string;
}

const DEFAULTS = {
	deviceName: os.hostname(),
	debug: false,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always" as ExternalEditPolicy,
	frontmatterGuardEnabled: true,
	configDir: DEFAULT_CONFIG_DIR,
};

export function getDefaultConfigPath(): string {
	const baseDir = process.env.XDG_CONFIG_HOME
		? nodePath.resolve(process.env.XDG_CONFIG_HOME)
		: nodePath.join(os.homedir(), ".config");
	return nodePath.join(baseDir, "yaos", "cli.json");
}

export async function resolveCliConfig(options: CliCommandOptions): Promise<ResolvedCliConfig> {
	const configPath = getDefaultConfigPath();
	const fileConfig = await readConfigFile(configPath);
	const envConfig = readEnvConfig(process.env);

	const raw = {
		...DEFAULTS,
		...fileConfig,
		...envConfig,
		...pickDefined(options),
		configPath,
	};

	return {
		...raw,
		dir: raw.dir ? nodePath.resolve(raw.dir.replace(/^~/, os.homedir())) : raw.dir,
	};
}

export function requireRuntimeConfig(
	config: ResolvedCliConfig,
	requirements: { requireDir: boolean },
): RuntimeCliConfig {
	const missing = [
		config.host ? null : "host",
		config.token ? null : "token",
		config.vaultId ? null : "vaultId",
		requirements.requireDir && !config.dir ? "dir" : null,
	].filter((value): value is string => value !== null);

	if (missing.length > 0) {
		throw new Error(`Missing required configuration: ${missing.join(", ")}`);
	}

	return {
		...config,
		host: config.host!,
		token: config.token!,
		vaultId: config.vaultId!,
		dir: config.dir!,
	};
}

async function readConfigFile(configPath: string): Promise<CliFileConfig> {
	try {
		const raw = await fs.readFile(configPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config file must contain a JSON object");
		}
		return sanitizeFileConfig(parsed as Record<string, unknown>);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw new Error(`Failed to load ${configPath}: ${(error as Error).message}`);
	}
}

function sanitizeFileConfig(value: Record<string, unknown>): CliFileConfig {
	const config: CliFileConfig = {};
	assignString(config, "host", value.host);
	assignString(config, "token", value.token);
	assignString(config, "vaultId", value.vaultId);
	assignString(config, "dir", value.dir);
	assignString(config, "deviceName", value.deviceName);
	assignBoolean(config, "debug", value.debug);
	assignString(config, "excludePatterns", value.excludePatterns);
	assignNumber(config, "maxFileSizeKB", value.maxFileSizeKB);
	assignExternalEditPolicy(config, value.externalEditPolicy);
	assignBoolean(config, "frontmatterGuardEnabled", value.frontmatterGuardEnabled);
	assignString(config, "configDir", value.configDir);
	return config;
}

function readEnvConfig(env: NodeJS.ProcessEnv): CliFileConfig {
	const config: CliFileConfig = {};
	assignString(config, "host", env.YAOS_HOST);
	assignString(config, "token", env.YAOS_TOKEN);
	assignString(config, "vaultId", env.YAOS_VAULT_ID);
	assignString(config, "dir", env.YAOS_DIR);
	assignString(config, "deviceName", env.YAOS_DEVICE_NAME);
	assignBoolean(config, "debug", parseBooleanEnv(env.YAOS_DEBUG));
	assignString(config, "excludePatterns", env.YAOS_EXCLUDE_PATTERNS);
	assignNumber(config, "maxFileSizeKB", parseNumberEnv(env.YAOS_MAX_FILE_SIZE_KB));
	assignExternalEditPolicy(config, env.YAOS_EXTERNAL_EDIT_POLICY);
	assignBoolean(config, "frontmatterGuardEnabled", parseBooleanEnv(env.YAOS_FRONTMATTER_GUARD));
	assignString(config, "configDir", env.YAOS_CONFIG_DIR);
	return config;
}

function pickDefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, entry]) => entry !== undefined && entry !== "",
		),
	) as Partial<T>;
}

function assignString<K extends keyof CliFileConfig>(
	target: CliFileConfig,
	key: K,
	value: unknown,
): void {
	if (typeof value === "string" && value.length > 0) {
		target[key] = value as CliFileConfig[K];
	}
}

function assignBoolean<K extends keyof CliFileConfig>(
	target: CliFileConfig,
	key: K,
	value: unknown,
): void {
	if (typeof value === "boolean") {
		target[key] = value as CliFileConfig[K];
	}
}

function assignNumber<K extends keyof CliFileConfig>(
	target: CliFileConfig,
	key: K,
	value: unknown,
): void {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		target[key] = value as CliFileConfig[K];
	}
}

const VALID_EXTERNAL_EDIT_POLICIES = ["always", "closed-only", "never"] as const;

function assignExternalEditPolicy(
	target: CliFileConfig,
	value: unknown,
): void {
	if (value == null) return;
	if (typeof value === "string" && VALID_EXTERNAL_EDIT_POLICIES.includes(value as ExternalEditPolicy)) {
		target.externalEditPolicy = value as ExternalEditPolicy;
		return;
	}
	const display = typeof value === "string" ? `"${value}"` : typeof value;
	throw new Error(
		`Invalid externalEditPolicy: ${display}. Must be one of: ${VALID_EXTERNAL_EDIT_POLICIES.join(", ")}`,
	);
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value == null) return undefined;
	if (value === "1" || value.toLowerCase() === "true") return true;
	if (value === "0" || value.toLowerCase() === "false") return false;
	return undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
	if (value == null || value.length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
