/**
 * Relay v2 spike §5.5: client trigger policy reuses the server's
 * semanticCompactionPolicy numbers and decision function.
 */
import * as Y from "yjs";
import { BODY_COMPACTION_THRESHOLDS as SERVER_THRESHOLDS } from "../../server/src/semanticCompactionPolicy";
import { buildFreshSnapshot, buildFreshSnapshotFromContent } from "../../scripts/relay2/reset/builder";
import { bloatedDoc } from "../../scripts/relay2/reset/bloat";
import {
	BODY_COMPACTION_THRESHOLDS,
	ClientCompactionCadence,
	DEFAULT_COMPACTION_MEASUREMENT_CADENCE,
	confirmAfterBuild,
	evaluateClientTrigger,
	measureClientBody,
} from "../../scripts/relay2/reset/policy";
import { suite } from "../harness.ts";

const s = suite("relay2-reset-policy");
const NOW = 1_800_000_000_000;
const NEVER = { lastCompactedAt: null, postCompactionEncodedStateBytes: null };

s.test("thresholds are the server's, unchanged", () => {
	s.check(BODY_COMPACTION_THRESHOLDS === SERVER_THRESHOLDS, "same frozen threshold object");
	s.check(BODY_COMPACTION_THRESHOLDS.softEncodedStateBytes === 1.5 * 1024 * 1024
		|| BODY_COMPACTION_THRESHOLDS.softEncodedStateBytes === 1_500_000, `soft bytes ${BODY_COMPACTION_THRESHOLDS.softEncodedStateBytes}`);
	s.check(BODY_COMPACTION_THRESHOLDS.minimumProjectedReduction === 0.4, "40% projected reduction");
	s.check(DEFAULT_COMPACTION_MEASUREMENT_CADENCE.commits === 64, "64-commit cadence");
});

s.test("small healthy note never requests a lease", () => {
	const doc = new Y.Doc({ guid: "policy-small" });
	doc.getText("body").insert(0, "# hello\n\nshort note\n");
	const verdict = evaluateClientTrigger(doc, NEVER, NOW);
	s.check(!verdict.requestLease && verdict.decision.urgency === "none", `no request (${verdict.decision.reasons.join(",")})`);
	doc.destroy();
});

s.test("large but history-free 5 MiB note never requests a lease", async () => {
	const content = "a healthy large note line\n".repeat(Math.floor((5 * 1024 * 1024 - 65_536) / 26));
	const fresh = await buildFreshSnapshotFromContent("policy-large", content, undefined, { keepDocument: true });
	const verdict = evaluateClientTrigger(fresh.document!, NEVER, NOW);
	s.check(!verdict.requestLease, `no request for ${fresh.contentBytes} B live / ${verdict.measurement.census.encodedStateBytes} B encoded (${verdict.decision.reasons.join(",") || "none"})`);
	fresh.document!.destroy();
});

const bloated = bloatedDoc({ guid: "policy-bloat", edits: 14_000, seed: 21 });
const bloatedMeasurement = measureClientBody(bloated);

s.test("edited history crosses the soft deleted-ratio threshold", () => {
	const { census } = bloatedMeasurement;
	const verdict = evaluateClientTrigger(bloated, NEVER, NOW);
	s.check(census.totalStructs >= BODY_COMPACTION_THRESHOLDS.minimumRatioStructs,
		`≥ ${BODY_COMPACTION_THRESHOLDS.minimumRatioStructs} structs (${census.totalStructs}, ${census.deletedStructs} deleted)`);
	s.check(verdict.requestLease && verdict.decision.urgency !== "none", `requests lease: ${verdict.decision.urgency} ${verdict.decision.reasons.join(",")}`);
});

s.test("fresh-size estimate is conservative and phase 2 agrees", async () => {
	const fresh = await buildFreshSnapshot(bloated);
	s.check(bloatedMeasurement.estimatedFreshStateBytes >= fresh.after.encodedStateBytes,
		`estimate ${bloatedMeasurement.estimatedFreshStateBytes} ≥ actual ${fresh.after.encodedStateBytes}`);
	const phase2 = confirmAfterBuild(fresh, NEVER, NOW);
	s.check(phase2.semanticResetRecommended, `phase 2 confirms (${phase2.reasons.join(",")}, reduction ${phase2.projectedReduction.toFixed(3)})`);
	const phase1 = evaluateClientTrigger(bloated, NEVER, NOW).decision;
	s.check(phase2.projectedReduction >= phase1.projectedReduction, "exact reduction ≥ estimated reduction");
});

const soft = bloatedDoc({ guid: "policy-soft", edits: 10_000, seed: 21, deleteBias: 0.3 });
const softEncoded = measureClientBody(soft).census.encodedStateBytes;

s.test("soft cooldown and hysteresis suppress requests (server-owned state)", () => {
	const fresh = evaluateClientTrigger(soft, NEVER, NOW);
	s.check(fresh.requestLease && fresh.decision.urgency === "soft", `soft doc requests (${fresh.decision.reasons.join(",")})`);
	const cooling = evaluateClientTrigger(soft, { lastCompactedAt: NOW - 60 * 60_000, postCompactionEncodedStateBytes: null }, NOW);
	s.check(!cooling.requestLease && cooling.decision.reasons.includes("soft-cooldown"), `1 h after reset: ${cooling.decision.reasons.join(",")}`);
	const expired = evaluateClientTrigger(soft, { lastCompactedAt: NOW - 25 * 60 * 60_000, postCompactionEncodedStateBytes: null }, NOW);
	s.check(expired.requestLease, "cooldown expires after 24 h");
	const lowWater = evaluateClientTrigger(soft, {
		lastCompactedAt: NOW - 25 * 60 * 60_000, postCompactionEncodedStateBytes: Math.ceil(softEncoded / 1.4),
	}, NOW);
	s.check(!lowWater.requestLease && lowWater.decision.reasons.includes("hysteresis-low-water"),
		`regrowth < 1.5× low-water: ${lowWater.decision.reasons.join(",")}`);
	const rearmed = evaluateClientTrigger(soft, {
		lastCompactedAt: NOW - 25 * 60 * 60_000, postCompactionEncodedStateBytes: Math.floor(softEncoded / 1.6),
	}, NOW);
	s.check(rearmed.requestLease, "regrowth ≥ 1.5× re-arms");
});

s.test("hard urgency ignores cooldown and hysteresis", () => {
	const verdict = evaluateClientTrigger(bloated, { lastCompactedAt: NOW - 1, postCompactionEncodedStateBytes: bloatedMeasurement.census.encodedStateBytes }, NOW);
	s.check(verdict.decision.urgency === "hard" && verdict.requestLease, `hard → still requests (${verdict.decision.reasons.join(",")})`);
});

s.test("measurement cadence mirrors the server runtime", () => {
	let clock = NOW;
	const cadence = new ClientCompactionCadence(() => clock);
	s.check(!cadence.loaded("b", 100_000), "small loaded body not measured immediately");
	s.check(cadence.loaded("big", BODY_COMPACTION_THRESHOLDS.softEncodedStateBytes), "≥ soft bytes → measure on load");
	let due = false;
	for (let index = 0; index < 63; index++) due = cadence.observe("b", 10);
	s.check(!due, "63 small commits: not due");
	s.check(cadence.observe("b", 10), "64th commit: due");
	cadence.measured("b");
	s.check(cadence.observe("b", 384 * 1024), "384 KiB ingress: due");
	cadence.measured("b");
	clock += 15 * 60_000;
	s.check(cadence.observe("b", 1), "15 min elapsed: due");
});

await s.done();
