import { PersistentTraceLogger } from "../src/debug/trace";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function makeFakeApp() {
	const writes = new Map<string, string>();
	return {
		writes,
		app: {
			vault: {
				configDir: ".obsidian",
				adapter: {
					mkdir: async () => {},
					exists: async () => true,
					write: async (path: string, data: string) => {
						writes.set(path, data);
					},
					append: async (path: string, data: string) => {
						writes.set(path, (writes.get(path) ?? "") + data);
					},
				},
			},
		},
	};
}

console.log("\n--- Test 1: persistent trace logger drops instead of growing unbounded ---");
{
	const fake = makeFakeApp();
	const logger = new PersistentTraceLogger(fake.app as any, {
		enabled: true,
		deviceName: "Device",
		vaultId: "vault",
	});

	for (let i = 0; i < 2_500; i++) {
		logger.record("test", "storm", { i, path: `Private/${i}.md` });
	}
	await logger.shutdown();

	const sessionLog = [...fake.writes.entries()]
		.find(([path]) => path.endsWith(".ndjson") && !path.endsWith("-state.ndjson"))?.[1] ?? "";
	const lines = sessionLog.trim().split("\n").filter(Boolean);
	const dropped = lines
		.map((line) => JSON.parse(line))
		.find((event) => event.msg === "trace-events-dropped");

	assert(Boolean(dropped), "trace storm emits a dropped-event marker");
	assert(dropped?.details?.count > 0, "dropped-event marker reports how many events were dropped");
	assert(lines.length <= 2_002, "trace storm log stays bounded after marker and shutdown event");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
