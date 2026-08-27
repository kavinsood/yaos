import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings";
import {
	SetupLinkController,
	startEnrollmentRuntime,
	type SetupLinkControllerDeps,
} from "../../src/runtime/setupLinkController";
import { RuntimeTeardownCoordinator } from "../../src/runtime/teardownLifecycle";
import { readSource, suite } from "../harness.ts";

const s = suite("multivault-enrollment-contract");

s.section("Setup links enroll with a pairing code");
{
	const source = readSource("src/runtime/setupLinkController.ts");
	s.check(source.includes('action !== "setup"'), "protocol handler requires action=setup");
	s.check(source.includes("params.pairingCode"), "protocol handler reads pairingCode");
	s.check(source.includes('url: `${normalizedHost}/enroll`'), "pairing code is exchanged at POST /enroll");
	s.check(source.includes("settings.deviceToken = nextEnrollment.deviceToken"), "enrollment persists the returned device token");
	s.check(source.includes("settings.deviceId = nextEnrollment.deviceId"), "enrollment persists the returned device id");
	s.check(source.includes("settings.deviceName = enrolledName"), "enrollment persists the server-returned name");
	s.check(!source.includes("params.token") && !source.includes("params.vaultId"), "old token and vault-id links cannot connect");
}

s.section("Existing enrollment replacement always requires informed consent");
interface EnrollmentExercise {
	confirmationCount: number;
	requestCount: number;
	settingsWriteCount: number;
	capabilityRefreshCount: number;
	initSyncCount: number;
	title: string;
	message: string;
	settingsChanged: boolean;
}

async function cancelReplacement(fileCount: number): Promise<EnrollmentExercise> {
	const settings: VaultSyncSettings = {
		...DEFAULT_SETTINGS,
		host: "https://old.example",
		vaultId: "existing-vault",
		deviceId: "existing-device",
		deviceToken: "existing-token",
		deviceName: "My device",
	};
	const originalSettings = JSON.stringify(settings);
	const exercise: EnrollmentExercise = {
		confirmationCount: 0,
		requestCount: 0,
		settingsWriteCount: 0,
		capabilityRefreshCount: 0,
		initSyncCount: 0,
		title: "",
		message: "",
		settingsChanged: false,
	};
	const files = Array.from({ length: fileCount }, (_, index) => ({ path: `note-${index}.md` }));
	const deps: SetupLinkControllerDeps = {
		app: {
			vault: {
				// @ts-expect-error focused enrollment test needs paths only.
				getMarkdownFiles: () => files,
			},
		},
		getSettings: () => settings,
		isMarkdownPathSyncable: () => true,
		updateSettings: async (mutator) => {
			exercise.settingsWriteCount++;
			mutator(settings);
		},
		refreshServerCapabilities: async () => {
			exercise.capabilityRefreshCount++;
		},
		startSyncAfterEnrollment: async () => {
			exercise.initSyncCount++;
		},
		retireCurrentEnrollment: async () => {
			throw new Error("cancelled replacement must not retire the current enrollment");
		},
		requestEnrollment: async () => {
			exercise.requestCount++;
			return { status: 500, json: {} };
		},
		confirmEnrollmentReplacement: async (title, message) => {
			exercise.confirmationCount++;
			exercise.title = title;
			exercise.message = message;
			return false;
		},
	};

	await new SetupLinkController(deps).handleSetupLink({
		action: "setup",
		host: "https://destination.example/",
		pairingCode: "attacker-controlled-code",
	});
	exercise.settingsChanged = JSON.stringify(settings) !== originalSettings;
	return exercise;
}

for (const fileCount of [0, 3]) {
	s.test(`${fileCount}-file enrolled folder cannot be silently replaced`, async () => {
		const exercise = await cancelReplacement(fileCount);
		if (exercise.confirmationCount !== 1) {
			throw new Error(`expected one confirmation, got ${exercise.confirmationCount}`);
		}
		if (!exercise.title.includes("Replace this folder")) {
			throw new Error(`confirmation title is not explicit: ${exercise.title}`);
		}
		if (!exercise.message.includes("https://destination.example")) {
			throw new Error(`confirmation does not name the destination origin: ${exercise.message}`);
		}
		if (!exercise.message.includes(`${fileCount} syncable local Markdown`)) {
			throw new Error(`confirmation does not describe the local vault size: ${exercise.message}`);
		}
		if (!exercise.message.includes("all local content in this folder will sync")) {
			throw new Error(`confirmation does not warn that local content will sync: ${exercise.message}`);
		}
		if (!exercise.message.includes("old membership remains active")) {
			throw new Error(`confirmation does not explain the old membership: ${exercise.message}`);
		}
		if (
			exercise.requestCount !== 0 ||
			exercise.settingsWriteCount !== 0 ||
			exercise.capabilityRefreshCount !== 0 ||
			exercise.initSyncCount !== 0 ||
			exercise.settingsChanged
		) {
			throw new Error(`cancellation changed enrollment runtime: ${JSON.stringify(exercise)}`);
		}
	});
}

s.test("fully unenrolled folder can enroll without replacement confirmation", async () => {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, deviceName: "Fresh device" };
	const lifecycle = new RuntimeTeardownCoordinator();
	await lifecycle.beginTeardown(async () => {});
	let restartedGeneration: number | null = null;
	let confirmationCount = 0;
	let requestCount = 0;
	let refreshCount = 0;
	let initCount = 0;
	const deps: SetupLinkControllerDeps = {
		app: {
			// @ts-expect-error focused enrollment test supplies only vault file enumeration.
			vault: {
				getMarkdownFiles: () => [],
			},
		},
		getSettings: () => settings,
		isMarkdownPathSyncable: () => true,
		updateSettings: async (mutator) => {
			mutator(settings);
		},
		refreshServerCapabilities: async () => {
			refreshCount++;
		},
		startSyncAfterEnrollment: async () => {
			initCount++;
			await startEnrollmentRuntime(lifecycle, async () => {
				restartedGeneration = lifecycle.beginInitialization();
			});
		},
		retireCurrentEnrollment: async () => {
			throw new Error("fully unenrolled folder has no current enrollment to retire");
		},
		requestEnrollment: async () => {
			requestCount++;
			return {
				status: 200,
				json: {
					vaultId: "new-vault",
					deviceId: "new-device",
					deviceToken: "new-token",
					name: "Server device name",
				},
			};
		},
		confirmEnrollmentReplacement: async () => {
			confirmationCount++;
			return false;
		},
	};

	await new SetupLinkController(deps).enrollWithCode("https://destination.example/", "valid-code");
	if (confirmationCount !== 0) throw new Error("fully unenrolled folder unexpectedly requested replacement consent");
	if (requestCount !== 1 || refreshCount !== 1 || initCount !== 1) {
		throw new Error("fully unenrolled enrollment did not complete exactly once");
	}
	if (
		settings.host !== "https://destination.example" ||
		settings.vaultId !== "new-vault" ||
		settings.deviceId !== "new-device" ||
		settings.deviceToken !== "new-token" ||
		settings.deviceName !== "Server device name"
	) {
		throw new Error(`server enrollment was not persisted: ${JSON.stringify(settings)}`);
	}
	if (
		restartedGeneration === null ||
		!lifecycle.isInitializationCurrent(restartedGeneration)
	) {
		throw new Error("leave then enrollment did not reopen the completed teardown lifecycle");
	}
});

async function exerciseIncompleteEnrollment(
	requestEnrollment: SetupLinkControllerDeps["requestEnrollment"],
	options: { currentEnrollment?: boolean; retirementFails?: boolean } = {},
): Promise<{ completed: boolean; settingsChanged: boolean; startCount: number }> {
	const settings: VaultSyncSettings = {
		...DEFAULT_SETTINGS,
		deviceName: "Test device",
		...(options.currentEnrollment
			? {
				host: "https://old.example",
				vaultId: "old-vault",
				deviceId: "old-device",
				deviceToken: "old-token",
			}
			: {}),
	};
	const originalSettings = JSON.stringify(settings);
	let startCount = 0;
	const controller = new SetupLinkController({
		app: {
			// @ts-expect-error focused enrollment test supplies only vault file enumeration.
			vault: { getMarkdownFiles: () => [] },
		},
		getSettings: () => settings,
		isMarkdownPathSyncable: () => true,
		updateSettings: async (mutator) => { mutator(settings); },
		refreshServerCapabilities: async () => {},
		startSyncAfterEnrollment: async () => { startCount++; },
		retireCurrentEnrollment: async () => {
			if (options.retirementFails) throw new Error("retirement failed");
		},
		requestEnrollment,
		confirmEnrollmentReplacement: async () => true,
	});
	const completed = await controller.enrollWithCode("https://new.example", "still-usable-code");
	return {
		completed,
		settingsChanged: JSON.stringify(settings) !== originalSettings,
		startCount,
	};
}

for (const [label, requestEnrollment] of [
	["network failure", async () => { throw new Error("offline"); }],
	["server failure", async () => ({ status: 503, json: { message: "unavailable" } })],
	["malformed response", async () => ({ status: 200, json: { vaultId: "incomplete" } })],
] satisfies Array<[string, SetupLinkControllerDeps["requestEnrollment"]]>) {
	s.test(`${label} does not complete enrollment`, async () => {
		const result = await exerciseIncompleteEnrollment(requestEnrollment);
		if (result.completed || result.settingsChanged || result.startCount !== 0) {
			throw new Error(`${label} advanced incomplete enrollment: ${JSON.stringify(result)}`);
		}
	});
}

s.test("failed retirement preserves the current enrollment", async () => {
	const result = await exerciseIncompleteEnrollment(
		async () => ({
			status: 200,
			json: {
				vaultId: "new-vault",
				deviceId: "new-device",
				deviceToken: "new-token",
				name: "New device",
			},
		}),
		{ currentEnrollment: true, retirementFails: true },
	);
	if (result.completed || result.settingsChanged || result.startCount !== 0) {
		throw new Error(`failed retirement advanced replacement: ${JSON.stringify(result)}`);
	}
});

s.test("successful replacement retires the captured old membership before persisting new credentials", async () => {
	const settings: VaultSyncSettings = {
		...DEFAULT_SETTINGS,
		host: "https://old.example/",
		vaultId: "old-vault",
		deviceId: "old-device",
		deviceToken: "old-token",
		deviceName: "Existing device",
	};
	const events: string[] = [];
	const lifecycle = new RuntimeTeardownCoordinator();
	let restartedGeneration: number | null = null;
	let retiredMembership: Record<string, string> | null = null;
	const deps: SetupLinkControllerDeps = {
		app: {
			// @ts-expect-error focused enrollment test supplies only vault file enumeration.
			vault: {
				getMarkdownFiles: () => [],
			},
		},
		getSettings: () => settings,
		isMarkdownPathSyncable: () => true,
		confirmEnrollmentReplacement: async () => {
			events.push("confirm");
			return true;
		},
		requestEnrollment: async () => {
			events.push("enroll-request");
			return {
				status: 200,
				json: {
					vaultId: "new-vault",
					deviceId: "new-device",
					deviceToken: "new-token",
					name: "Replacement device",
				},
			};
		},
		retireCurrentEnrollment: async (membership) => {
			events.push("retire-old");
			retiredMembership = { ...membership };
			if (settings.vaultId !== "old-vault" || settings.deviceToken !== "old-token") {
				throw new Error("new settings were persisted before old enrollment retirement");
			}
			await lifecycle.beginTeardown(async () => {});
		},
		updateSettings: async (mutator) => {
			events.push("persist-new");
			mutator(settings);
		},
		refreshServerCapabilities: async () => {
			events.push("refresh-capabilities");
		},
		startSyncAfterEnrollment: async () => {
			events.push("init-sync");
			await startEnrollmentRuntime(lifecycle, async () => {
				restartedGeneration = lifecycle.beginInitialization();
			});
		},
	};

	await new SetupLinkController(deps).enrollWithCode("https://new.example/", "fresh-code");
	const expectedMembership = {
		host: "https://old.example",
		deviceToken: "old-token",
		vaultId: "old-vault",
		deviceId: "old-device",
	};
	if (JSON.stringify(retiredMembership) !== JSON.stringify(expectedMembership)) {
		throw new Error(`old enrollment was not captured exactly: ${JSON.stringify(retiredMembership)}`);
	}
	if (
		events.join(",") !==
		"confirm,enroll-request,retire-old,persist-new,refresh-capabilities,init-sync"
	) {
		throw new Error(`replacement lifecycle ran out of order: ${events.join(",")}`);
	}
	if (
		restartedGeneration === null ||
		!lifecycle.isInitializationCurrent(restartedGeneration)
	) {
		throw new Error("replacement enrollment did not reopen the completed teardown lifecycle");
	}
});

s.section("Pairing links come from the server");
{
	const main = readSource("src/main.ts");
	s.check(main.includes("/auth/pairing-code"), "pair another device mints a server pairing code");
	s.check(main.includes("body.obsidianUrl") && main.includes("body.mobileSetupUrl"), "client displays only server-returned URLs");
	s.check(main.includes("async mintDevicePairing()"), "pairing links are minted instead of assembled from stored credentials");
}

s.section("Roster and leave stay device-scoped");
{
	const main = readSource("src/main.ts");
	s.check(main.includes("async refreshVaultRoster()"), "client fetches the enrolled device roster");
	s.check(main.includes("isDeviceOnline(deviceId: string)"), "awareness presence is matched by server device id");
	s.check(main.includes('method: "DELETE"'), "leave attempts to revoke this device");
	s.check(main.includes("await this.teardownSync()"), "leave tears down locally even after revoke failure");
	s.check(main.includes("settings.deviceToken = \"\"") && main.includes("settings.deviceId = \"\""), "leave clears local membership");
	s.check(main.includes("await VaultSync.deleteIdb(vaultId, await this.ensureFolderKey())"), "leave deletes only this folder's vault database");
	s.check(main.includes("clearServerReceiptCandidate"), "leave clears this enrollment's server-receipt candidate");
}

s.section("Device credentials are device-scoped");
{
	const main = readSource("src/main.ts");
	s.check(main.includes("YAOS Device Credentials"), "export uses honest device credential terminology");
	for (const field of ["Host:", "Vault ID:", "Device ID:", "Device token:"]) {
		s.check(main.includes(field), `${field} is exported`);
	}
	s.check(!main.includes("operatorRecovery"), "operator recovery key never enters plugin source");
}

await s.done();
