import type { RecoveryPageSizingValidationResult } from "./recovery-page-sizing-harness";

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function accessHeaders(): Record<string, string> {
	const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim() || null;
	const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim() || null;
	if ((clientId === null) !== (clientSecret === null)) {
		throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be supplied together");
	}
	return clientId && clientSecret ? {
		"CF-Access-Client-Id": clientId,
		"CF-Access-Client-Secret": clientSecret,
	} : {};
}

function requestedPageSizes(): number[] | undefined {
	const raw = process.env.YAOS_DEPLOYED_PAGE_SIZES?.trim();
	if (!raw) return undefined;
	const values = raw.split(",").map((part) => Number(part.trim()));
	if (values.some((value) => !Number.isSafeInteger(value))) {
		throw new Error("YAOS_DEPLOYED_PAGE_SIZES must be a comma-separated integer list");
	}
	return values;
}

function parseResult(value: unknown): RecoveryPageSizingValidationResult {
	if (!value || typeof value !== "object") throw new Error("benchmark returned a non-object response");
	const result = value as Partial<RecoveryPageSizingValidationResult>;
	if (result.format !== "yaos-deployed-recovery-page-sizing-v1"
		|| result.implementation !== "VaultRecoveryService"
		|| result.passed !== true
		|| !Array.isArray(result.cases)
		|| result.cases.length === 0) {
		throw new Error(`malformed or failed benchmark response: ${JSON.stringify(value)}`);
	}
	for (const item of result.cases) {
		for (const [label, method] of [["capture plan", item.capturePlan], ["catalog delta", item.catalogDelta]] as const) {
			if (method.entriesReturned !== item.pageSize
				|| method.terminal
				|| method.sizingSerializationCalls !== item.pageSize
				|| method.uniqueEntriesSized !== item.pageSize
				|| method.duplicateSizingSerializations !== 0
				|| method.lookaheadSerializationCalls !== 0) {
				throw new Error(`${label} was not linear at page size ${item.pageSize}: ${JSON.stringify(method)}`);
			}
		}
	}
	return result as RecoveryPageSizingValidationResult;
}

const host = requiredEnv("YAOS_DEPLOYED_BENCH_HOST").replace(/\/+$/, "");
const secret = requiredEnv("YAOS_DEPLOYED_BENCH_SECRET");
const pageSizes = requestedPageSizes();
const response = await fetch(`${host}/__yaos/benchmark/recovery-page-sizing`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		"x-yaos-benchmark-secret": secret,
		...accessHeaders(),
	},
	body: JSON.stringify(pageSizes === undefined ? {} : { pageSizes }),
});
if (!response.ok) {
	throw new Error(`deployed page-sizing benchmark failed (${response.status}): ${await response.text()}`);
}
const result = parseResult(await response.json());
for (const item of result.cases) {
	console.log(
		`N=${item.pageSize}: capture=${item.capturePlan.sizingSerializationCalls}, `
		+ `delta=${item.catalogDelta.sizingSerializationCalls}, old=${item.capturePlan.oldQuadraticSizingCalls}, `
		+ `worker=${(item.capturePlan.elapsedMs + item.catalogDelta.elapsedMs).toFixed(3)}ms`,
	);
}
console.log("Deployed recovery page sizing is linear for both production methods.");
