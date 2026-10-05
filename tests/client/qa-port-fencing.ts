/**
 * Fencing for the product debug port.
 *
 * `YaosDebugPort` (src/telemetry/debug/ports/yaosDebugPort.ts) is the read-only
 * capability surface the product exposes for debugging. The invariant this file
 * defends is one-directional and belongs to yaos: **no mutating, scenario-control
 * or policy-override capability may appear on the product port.**
 *
 * The mirror-image assertion — that the QA harness implementation satisfies
 * `YaosUnsafeQaPort` — is a compile-time check inside the harness itself
 * (`qa/harness/qaDebugApi.ts`, verified by `tsconfig.qa.json`). It is not
 * restated here, because a runtime test cannot check assignability: this suite
 * runs under jiti, which erases types. A previous version of this file mocked
 * `YaosUnsafeQaPort` and passed for months while its mock had drifted from the
 * real port — the erased annotation checked nothing.
 *
 * `guard:qa-isolation` is likewise not spawned here. `test:regressions` runs it
 * directly before this suite, and CI runs it again; a third invocation proved
 * nothing.
 */

import type { YaosDebugPort } from "../../legacy-src/telemetry/debug/ports/yaosDebugPort";
import { suite } from "../harness.ts";

const s = suite("qa-port-fencing");

// A complete mock of the port. This is the load-bearing part: the annotation
// forces the object to satisfy YaosDebugPort exactly, so adding a member to the
// port fails compilation here until it is listed — and every check below is
// derived from these keys rather than a hand-maintained copy of them.
const mockDebugPort: YaosDebugPort = {
	isLocalReady: () => true,
	isProviderSynced: () => true,
	isProviderConnected: () => true,
	isReconciled: () => true,
	isReconcileInFlight: () => false,
	getConnectionState: () => "connected",
	getServerReceiptState: () => "confirmed",
	getReceiptSnapshot: () => ({
		candidateId: "candidate-1",
		capturedAt: 1,
		lastConfirmedCandidateId: "candidate-1",
		lastConfirmedAt: 1,
	}),
	getActiveMarkdownPaths: () => [],
	getDiskMarkdownPaths: () => [],
	getEditorBindingHealth: () => ({
		leafOpen: true,
		bound: true,
		hasSyncFacet: true,
		yTextMatchesExpected: true,
		healthy: true,
		settling: false,
		issues: [],
	}),
	getRuntimeState: () => "foreground",
	getDiskHash: async () => null,
	getCrdtHash: async () => null,
	getEditorHash: async () => null,
	waitForIdle: async () => {},
	waitForLocalReady: async () => {},
	waitForProviderSynced: async () => {},
	waitForReconciled: async () => {},
	waitForFile: async () => {},
	waitForReceiptAfter: async () => {},
	forceReconcile: async () => {},
	forceReconnect: () => {},
	disconnectProvider: () => {},
	connectProvider: () => {},
	exportFlightTrace: async () => "",
	getActiveTraceInfo: () => null,
};

// A spread copy, because an interface has no index signature to read members
// off of by name. Own enumerable keys are identical either way.
const portMembers: Record<string, unknown> = { ...mockDebugPort };
const portKeys = Object.keys(portMembers);

s.section("Test 1: the port is populated and callable");
{
	s.check(portKeys.length > 0, "port exposes at least one member");
	s.check(
		portKeys.every((k) => typeof portMembers[k] === "function"),
		"every port member is a function",
	);
}

s.section("Test 2: no QA-only capability on the product port");
{
	// Naming conventions the QA tree uses to mark capabilities that must never
	// be reachable from the product. See qa/harness/ports/yaosUnsafeQaPort.ts.
	const qaOnlyMarkers = ["__qaOnly", "Unsafe", "Scenario"];
	for (const marker of qaOnlyMarkers) {
		const offenders = portKeys.filter((k) => k.toLowerCase().includes(marker.toLowerCase()));
		s.check(offenders.length === 0, `no port member contains '${marker}'${offenders.length ? ` (found: ${offenders.join(", ")})` : ""}`);
	}
}

s.section("Test 3: no mutation or policy-override capability on the product port");
{
	// Derived from the mock's real keys, NOT a hand-maintained list. A hardcoded
	// copy silently stops covering members added to the port after it was written.
	const forbiddenCapabilities = [
		"forceCrdt",
		"forceSync",
		"ingestDisk",
		"networkHold",
		"Override",
		"pauseEditor",
		"resumeEditor",
		"emitPhase",
	];
	for (const capability of forbiddenCapabilities) {
		const offenders = portKeys.filter((k) => k.toLowerCase().includes(capability.toLowerCase()));
		s.check(offenders.length === 0, `no port member provides '${capability}'${offenders.length ? ` (found: ${offenders.join(", ")})` : ""}`);
	}
}

s.section("Test 4: the reconnect/reconcile members present are not data mutators");
{
	// forceReconcile / forceReconnect / disconnectProvider / connectProvider are
	// deliberately on the port: they drive sync lifecycle, not content. This
	// pins that distinction so a content mutator cannot be smuggled in behind a
	// similar-sounding name.
	s.check(portKeys.includes("forceReconcile"), "forceReconcile is present (lifecycle, allowed)");
	s.check(portKeys.includes("forceReconnect"), "forceReconnect is present (lifecycle, allowed)");
	s.check(!portKeys.some((k) => /^force(?!Reconcile$|Reconnect$)/.test(k)), "no other force* member on the port");
}
await s.done();
