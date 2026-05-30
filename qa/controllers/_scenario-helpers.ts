/**
 * s12a-with-edit and s12c-conflict scenarios for two-device CDP controller.
 * Paste these into TWO_DEVICE_SCENARIOS in two-device.ts.
 */

// -----------------------------------------------------------------------
// Shared bundle builder (same pattern as s13)
// -----------------------------------------------------------------------

async function buildBundleFromSegments(
	client: { evalRaw: <T>(expr: string) => Promise<T> },
	scratch: string,
	runId: string,
	scenarioId: string,
	deviceLabel: string,
	platform: string,
): Promise<{ bundle: string; deviceId: string; pathId: string | null; eventCount: number }> {
	const traceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.localTraceId ?? ""`);
	const deviceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId()`);
	const secretHash = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.qaTraceSecretHash ?? ""`);
	const segs = await client.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceId)}) ?? null`);
	const pathIdRaw = await client.evalRaw<string | null>(`(async () => { const ftc = app.plugins.plugins.yaos?.flightTrace; if (!ftc) return null; const p = await ftc.getPathId(${JSON.stringify(scratch)}); return p?.pathId ?? null; })()`);

	const lines = (segs || "").split("\n").filter((l) => l.trim());
	const filtered = lines.filter((l) => {
		try {
			const obj = JSON.parse(l) as Record<string, unknown>;
			if (obj.kind === "checkpoint.segment.header") return true;
			if (obj.kind !== "device.witness.settled" && obj.kind !== "device.witness.diverged") return true;
			return obj.pathId === pathIdRaw;
		} catch { return false; }
	});
	const eventCount = filtered.filter((l) => { try { return (JSON.parse(l) as Record<string, unknown>).kind !== "checkpoint.segment.header"; } catch { return false; } }).length;
	const header = {
		kind: "bundle.header", bundleSchemaVersion: 1, createdAt: new Date().toISOString(),
		pluginVersion: "1.6.1", deviceId, deviceLabel, platform,
		runtimeState: "foreground", localTraceId: traceId,
		scenarioRunId: runId, scenarioId,
		qaTraceSecretHash: secretHash, flightMode: "qa-safe", eventCount,
		containsRawPaths: false, hashDomain: "witness-state-v1", privacyMode: "safe",
	};
	const bundle = [JSON.stringify(header), ...filtered].join("\n") + "\n";
	return { bundle, deviceId, pathId: pathIdRaw, eventCount };
}
