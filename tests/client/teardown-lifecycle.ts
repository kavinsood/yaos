import {
	RuntimeTeardownCoordinator,
	runTeardownStages,
	TeardownStagesError,
} from "../../src/runtime/teardownLifecycle";
import { readSource, suite } from "../harness.ts";

const s = suite("teardown-lifecycle");

s.section("Teardown lifecycle");

{
	const lifecycle = new RuntimeTeardownCoordinator();
	const initialGeneration = lifecycle.beginInitialization();
	s.check(initialGeneration !== null, "initialization starts while the lifecycle is open");
	s.check(
		initialGeneration !== null && lifecycle.isInitializationCurrent(initialGeneration),
		"current initialization generation is accepted before teardown",
	);

	let teardownRuns = 0;
	let releaseTeardown!: () => void;
	const teardownBarrier = new Promise<void>((resolve) => {
		releaseTeardown = resolve;
	});
	const first = lifecycle.beginTeardown(async () => {
		teardownRuns++;
		await teardownBarrier;
	});
	const second = lifecycle.beginTeardown(async () => {
		teardownRuns++;
	});

	s.check(first === second, "concurrent teardown callers receive one retained promise");
	s.check(teardownRuns === 1, "concurrent teardown callers do not run cleanup twice");
	s.check(lifecycle.isClosing, "teardown closes the lifecycle synchronously");
	s.check(!lifecycle.reopenAfterTeardown(), "reset cannot reopen while teardown is still pending");
	s.check(lifecycle.beginInitialization() === null, "closing gate rejects late initialization");
	s.check(
		initialGeneration !== null && !lifecycle.isInitializationCurrent(initialGeneration),
		"closing invalidates an in-flight initialization generation",
	);

	releaseTeardown();
	await first;
	s.check(lifecycle.beginTeardown(async () => { teardownRuns++; }) === first, "settled teardown promise remains retained");
	s.check(teardownRuns === 1, "retained settled promise still prevents duplicate teardown");
	s.check(lifecycle.reopenAfterTeardown(), "intentional reset can reopen a completed teardown");
	const restartedGeneration = lifecycle.beginInitialization();
	s.check(restartedGeneration !== null, "reopened lifecycle permits reset initialization");

	lifecycle.requestPermanentShutdown();
	s.check(lifecycle.beginInitialization() === null, "permanent unload gate rejects initialization");
	s.check(!lifecycle.reopenAfterTeardown(), "permanent unload cannot be reopened by reset logic");
}

{
	const lifecycle = new RuntimeTeardownCoordinator();
	const order: string[] = [];
	let releaseStartup!: () => void;
	const startupBlocked = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});
	const staleStartup = (async (): Promise<void> => {
		const generation = lifecycle.beginInitialization();
		if (generation === null) return;
		order.push("startup-waiting");
		await startupBlocked;
		if (!lifecycle.isInitializationCurrent(generation)) {
			order.push("startup-aborted");
			return;
		}
		order.push("startup-published-runtime");
	})();

	await Promise.resolve();
	await lifecycle.beginTeardown(async () => {
		order.push("teardown-complete");
	});
	releaseStartup();
	await staleStartup;
	s.check(
		order.join(",") === "startup-waiting,teardown-complete,startup-aborted",
		"startup released after teardown cannot publish a stale runtime",
	);
}

{
	const order: string[] = [];
	const reports: string[] = [];
	let thrown: unknown = null;
	try {
		await runTeardownStages([
			{ name: "disk-pending-writes", run: () => { order.push("disk-pending-writes"); } },
			{
				name: "disk-index-persistence",
				run: () => {
					order.push("disk-index-persistence");
					throw new Error("disk index unavailable");
				},
			},
			{ name: "attachments", run: () => { order.push("attachments"); } },
			{ name: "connection-controller", run: () => { order.push("connection-controller"); } },
			{ name: "vault-sync", run: () => { order.push("vault-sync"); } },
		], ({ stage }) => reports.push(stage));
	} catch (error) {
		thrown = error;
	}

	s.check(
		order.join(",") === "disk-pending-writes,disk-index-persistence,attachments,connection-controller,vault-sync",
		"teardown preserves stage ordering while continuing after a failure",
	);
	s.check(reports.join(",") === "disk-index-persistence", "stage failure is reported when it occurs");
	s.check(thrown instanceof TeardownStagesError, "teardown rejects after all stages with aggregate failure context");
	s.check(
		thrown instanceof TeardownStagesError && thrown.failures.length === 1 && thrown.failures[0]?.stage === "disk-index-persistence",
		"aggregate failure identifies the failed stage",
	);
}
{
	const main = readSource("src/main.ts");
	const settingsStage = main.indexOf('name: "settings-sync"');
	const diskStage = main.indexOf('name: "disk-pending-writes"');
	s.check(settingsStage >= 0 && settingsStage < diskStage, "settings engine is the first runtime teardown stage");
	s.check(
		main.includes("await this.settingsSyncEngine?.stop()"),
		"runtime teardown awaits the settings engine and its current operation",
	);
	const retirementStart = main.indexOf("private async retireSettingsSyncLocalState");
	const enrollmentRetirement = main.indexOf("private async retireCurrentEnrollment");
	const retirement = main.slice(retirementStart, enrollmentRetirement);
	s.check(
		retirementStart >= 0 && retirement.includes("await engine.retire()"),
		"membership retirement clears the exact settings queue",
	);
	const proof = main.indexOf("const provisioning = await fetchVaultProvisioningProof");
	const settingsStart = main.indexOf("await this.installSettingsSyncEngine(folderKey, provisioning)");
	s.check(proof >= 0 && proof < settingsStart, "settings engine starts only after current provisioning proof");
	const capabilityRefresh = main.slice(
		main.indexOf("async refreshServerCapabilities"),
		main.indexOf("async refreshUpdateManifest"),
	);
	s.check(
		capabilityRefresh.includes("reconcileSettingsSyncEngineInner")
			&& !capabilityRefresh.includes("teardownSync"),
		"capability refresh reconciles settings availability without tearing down note sync",
	);
	const settingsReconcile = main.slice(
		main.indexOf("private async reconcileSettingsSyncEngineInner"),
		main.indexOf("async refreshSettingsSyncRuntime"),
	);
	s.check(
		settingsReconcile.includes("catch (error)")
			&& settingsReconcile.includes("Settings sync unavailable; note sync is continuing"),
		"settings startup failure is isolated from note runtime initialization",
	);
}

await s.done();
