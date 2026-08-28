import { strict as assert } from "node:assert";
import { connectDocument, createVaultAndEnroll, pass, waitFor } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const first = await connectDocument(target.deviceA, "root", "root");
const second = await connectDocument(target.deviceB, "root", "root");
try {
	first.provider.awareness.setLocalStateField("conformance", { device: "a" });
	await waitFor(() => [...second.provider.awareness.getStates().values()].some((state) => (state.conformance as { device?: unknown } | undefined)?.device === "a"), "root awareness relay");
	pass("root sockets relay awareness between vault peers");
	// Presence removal is not part of the current public Worker contract:
	// hibernated sockets relay awareness updates but do not synthesize a
	// protocol removal frame when a peer disconnects.

	const otherIdentity = await createVaultAndEnroll(target, "awareness-isolation");
	const otherSource = await connectDocument(otherIdentity, "root", "root");
	const otherWitness = await connectDocument(otherIdentity, "root", "root");
	try {
		const isolationMarker = `original-vault-${crypto.randomUUID()}`;
		second.provider.awareness.setLocalStateField("isolated", isolationMarker);
		await waitFor(
			() => [...first.provider.awareness.getStates().values()]
				.some((state) => state.isolated === isolationMarker),
			"same-vault isolation marker observation",
		);

		const barrier = `other-vault-barrier-${crypto.randomUUID()}`;
		otherSource.provider.awareness.setLocalStateField("conformanceBarrier", barrier);
		await waitFor(
			() => [...otherWitness.provider.awareness.getStates().values()]
				.some((state) => state.conformanceBarrier === barrier),
			"ordered other-vault awareness barrier",
		);
		const leaked = [otherSource, otherWitness].some((connection) =>
			[...connection.provider.awareness.getStates().values()]
				.some((state) => state.isolated === isolationMarker));
		assert.equal(leaked, false);
		pass("root awareness is isolated by vault after both vault broadcasts are observed");
	} finally {
		otherWitness.destroy();
		otherSource.destroy();
	}
} finally {
	second.destroy();
	try { first.destroy(); } catch { /* already destroyed */ }
}
