import { BootstrapService } from "../../server/src/bootstrap";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export async function bootstrapContract(storage: VaultStoragePort): Promise<string[]> {
	let now = 1_000;
	const store = new VaultStore(storage);
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", 8);
	store.provisionVault("g7-vault", "generation-g7-0001", Y.encodeStateAsUpdate(root), now);
	root.destroy();
	for (const bodyId of ["g7-note-a", "g7-note-b"]) {
		const body = new Y.Doc({ guid: bodyId });
		body.getText("body").insert(0, `content for ${bodyId}`);
		store.commitUpdate({ documentId: bodyId, kind: "body", update: Y.encodeStateAsUpdate(body),
			catalog: [{ bodyId, fileId: bodyId, path: `${bodyId}.md`, previousPath: null, lifecycle: "active", bodyGeneration: 1 }] });
		body.destroy();
	}
	const device = (id: string, currentStore = store) => new BootstrapService(currentStore, () => now, undefined, id);
	const results: string[] = [];
	const expectError = async (work: () => unknown, reason: string, status = 409) => {
		try { await work(); } catch (error) {
			const typed = error as { code?: string; reason?: string; status?: number };
			check(typed.code === (status === 403 ? "bootstrap_owner_mismatch" : "bootstrap_not_running")
				&& typed.reason === reason && typed.status === status, `expected ${status}/${reason}, got ${String(error)}`);
			return;
		}
		throw new Error(`expected ${status}/${reason}`);
	};
	const sameDevice = device("same-device-g7");
	const sameDeviceRestarted = device("same-device-g7", new VaultStore(storage));
	const [sameFirst, sameSecond] = await Promise.all([
		sameDevice.start("same-device-attempt-a"), sameDeviceRestarted.start("same-device-attempt-b"),
	]);
	check(sameFirst.bootstrapId === sameSecond.bootstrapId, "same-device concurrent distinct attempt IDs must reuse one running operation");
	check(store.activePins(now).length === 1, "same-device concurrent starts must allocate only one pin");
	check(store.getOperation("same-device-attempt-b") === null, "unused same-device attempt ID must not allocate an operation");
	check((await sameDeviceRestarted.start("same-device-attempt-c")).bootstrapId === sameFirst.bootstrapId,
		"a later fresh attempt must reuse the device's running operation");
	await expectError(() => sameDevice.start("same-device-unknown-resume", true), "unknown");
	sameDevice.complete(sameFirst.bootstrapId);
	const sameNext = await sameDevice.start("same-device-attempt-next");
	await expectError(() => sameDevice.start(sameFirst.bootstrapId, false), "complete");
	const foreign = device("foreign-device-g7");
	const foreignOperation = await foreign.start("foreign-device-attempt");
	await expectError(() => sameDevice.start(foreignOperation.bootstrapId, false), "owner_mismatch", 403);
	check((await sameDevice.start("same-device-another-fresh")).bootstrapId === sameNext.bootstrapId,
		"completed/foreign attempt rejection must leave the own running operation intact");
	sameDevice.complete(sameNext.bootstrapId);
	foreign.complete(foreignOperation.bootstrapId);
	results.push("same-device distinct attempt IDs share one operation/pin; known completed and foreign IDs still reject");
	for (let iteration = 0; iteration < 5; iteration++) {
		const first = device(`device-a-${iteration}`);
		const second = device(`device-b-${iteration}`);
		const [left, right] = await Promise.all([first.start(), second.start()]);
		check(left.bootstrapId !== right.bootstrapId, "concurrent devices must have distinct operations");
		check(store.activePins(now).length === 2, "concurrent devices must own separate pins");
		const entries = first.catalogPage(left.bootstrapId, null).entries;
		check(entries.length === 2, "bootstrap includes both ordinary notes");
		check(JSON.stringify(entries) === JSON.stringify(second.catalogPage(right.bootstrapId, null).entries), "concurrent bootstraps have identical note sets");
		for (const entry of entries) {
			for (const [service, id] of [[first, left.bootstrapId], [second, right.bootstrapId]] as const) {
				const state = service.bodyState(id, entry.bodyId);
				const body = crdtEngine.openDocument(entry.bodyId, state.encodedState);
				try { check(crdtEngine.readText(body, "body") === `content for ${entry.bodyId}`, "both bootstraps preserve exact note content"); }
				finally { crdtEngine.destroyDocument(body); }
			}
		}
		const restarted = device(`device-a-${iteration}`, new VaultStore(storage));
		check((await restarted.start()).bootstrapId === left.bootstrapId, "device restart reuses its durable operation");
		await expectError(() => second.catalogPage(left.bootstrapId, null), "owner_mismatch", 403);
		await expectError(() => second.start(left.bootstrapId, true), "owner_mismatch", 403);
		second.complete(right.bootstrapId);
		check(first.catalogPage(left.bootstrapId, null).bootstrapId === left.bootstrapId, "one completion must not wedge the other device");
		first.complete(left.bootstrapId);
		for (const work of [
			() => first.start(left.bootstrapId, true), () => first.describe(left.bootstrapId),
			() => first.rootState(left.bootstrapId), () => first.catalogPage(left.bootstrapId, null),
			() => first.bodyState(left.bootstrapId, "body"), () => first.semanticCatalogPage(left.bootstrapId, null),
			() => first.semanticState(left.bootstrapId, "canvas"), () => first.renew(left.bootstrapId, 1),
			() => first.complete(left.bootstrapId),
		]) await expectError(work, "complete");
	}
	results.push("5 concurrent starts, durable restart, ownership and complete endpoint matrix");
	const first = device("expired-device");
	const expired = await first.start();
	now += 60 * 60_000;
	for (const work of [
		() => first.rootState(expired.bootstrapId), () => first.catalogPage(expired.bootstrapId, null),
		() => first.bodyState(expired.bootstrapId, "body"), () => first.semanticCatalogPage(expired.bootstrapId, null),
		() => first.semanticState(expired.bootstrapId, "canvas"), () => first.renew(expired.bootstrapId, 1),
		() => first.complete(expired.bootstrapId), () => first.describe(expired.bootstrapId),
		() => first.start(expired.bootstrapId, true),
	]) await expectError(work, "expired");
	for (const work of [
		() => first.start("unknown", true), () => first.describe("unknown"), () => first.rootState("unknown"),
		() => first.catalogPage("unknown", null), () => first.bodyState("unknown", "body"),
		() => first.semanticCatalogPage("unknown", null), () => first.semanticState("unknown", "canvas"),
		() => first.renew("unknown", 0), () => first.complete("unknown"),
	]) await expectError(work, "unknown");
	results.push("expired and unknown endpoint matrices");
	const legacy = new BootstrapService(store, () => now);
	const legacyOperation = await legacy.start("legacy-g7");
	await expectError(() => first.start(legacyOperation.bootstrapId, true), "ownership_unknown");
	legacy.complete(legacyOperation.bootstrapId);
	results.push("unowned legacy operation fails closed for device-scoped callers");
	const active: Array<{ service: BootstrapService; id: string }> = [];
	for (let index = 0; index < 32; index++) {
		const service = device(`capacity-${index}`);
		active.push({ service, id: (await service.start()).bootstrapId });
	}
	check(store.activePins(now).length === 32, "pin capacity remains 32");
	try { await device("over-capacity").start(); throw new Error("capacity did not reject"); }
	catch (error) { check(String(error).includes("history_pin_count_limit"), "33rd pin must be rejected by existing admission guard"); }
	for (const entry of active) entry.service.complete(entry.id);
	check(store.activePins(now).length === 0, "completion releases all pins");
	results.push("unchanged 32-pin admission and release");
	const final = device("owner-cascade");
	const finalId = (await final.start()).bootstrapId;
	final.complete(finalId);
	check(store.deleteCompletedOperation(finalId, "bootstrap"), "completed operation can be pruned");
	check(store.bootstrapOwner(finalId) === null, "operation pruning also prunes its owner record");
	const failingStore = new VaultStore({
		sql: { exec(query: string, ...bindings: unknown[]) {
			if (query.startsWith("INSERT INTO vault_bootstrap_owners")) throw new Error("injected_owner_write_failure");
			return storage.sql.exec(query, ...bindings);
		} },
		transactionSync: <Result>(work: () => Result): Result => storage.transactionSync(work),
	} as VaultStoragePort);
	try { await device("rollback-device", failingStore).start("rollback-g7"); throw new Error("owner write did not fail"); }
	catch (error) { check(String(error).includes("injected_owner_write_failure"), "injected owner insert failure reaches caller"); }
	check(store.getOperation("rollback-g7") === null && store.getPin("rollback-g7") === null
		&& store.bootstrapOwner("rollback-g7") === null, "owner write failure atomically rolls back operation and pin");
	results.push("owner pruning and atomic operation/pin/owner rollback");
	return results;
}
