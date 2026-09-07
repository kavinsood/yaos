import { HostPatchRegistry } from "../../src/host/hostPatchRegistry";
import { createObsidianHostAdapter, leafIdentity } from "../../src/host/obsidianHostAdapter";
import { suite } from "../harness.ts";

const s = suite("obsidian-host-adapter");

s.test("patch registry preserves receiver, arguments, and asynchronous result", async () => {
	const target = {
		prefix: "host",
		async operation(this: { prefix: string }, value: string): Promise<string> { return `${this.prefix}:${value}`; },
	};
	const registry = new HostPatchRegistry();
	let received = "";
	registry.observe(target, "operation", (args, result) => { received = `${args[0]}:${result}`; });
	const result = await target.operation("value");
	s.check(result === "host:value", "wrapped method preserves original receiver and result");
	s.check(received === "value:host:value", "observer receives original arguments and settled result");
});

s.test("patch registry isolates listeners and restores only its own wrapper", async () => {
	const original = async (): Promise<boolean> => true;
	const target = { operation: original };
	const registry = new HostPatchRegistry();
	let delivered = 0;
	const first = registry.observe(target, "operation", () => { throw new Error("ignored"); });
	const second = registry.observe(target, "operation", () => { delivered++; });
	await target.operation();
	s.check(delivered === 1, "one bad listener does not block another listener");
	first();
	s.check(target.operation !== original, "one release keeps shared wrapper installed");
	second();
	second();
	s.check(target.operation === original, "last idempotent release restores exact original");
	const release = registry.observe(target, "operation", () => undefined);
	const foreign = async (): Promise<boolean> => false;
	target.operation = foreign;
	release();
	s.check(target.operation === foreign, "cleanup does not overwrite a foreign replacement");
});

s.test("patch registry preserves rejected host operations without notification", async () => {
	const target = { operation: async (): Promise<void> => { throw new Error("host failure"); } };
	const registry = new HostPatchRegistry();
	let notified = false;
	registry.observe(target, "operation", () => { notified = true; });
	let rejected = false;
	try {
		await target.operation();
	} catch (error) {
		rejected = error instanceof Error && error.message === "host failure";
	}
	s.check(rejected, "host rejection is preserved");
	s.check(!notified, "failed host operation does not notify observers");
});

s.test("adapter observes installer completion and safely degrades without host APIs", async () => {
	const pluginHost = {
		enabledPlugins: new Set<string>(),
		manifests: { calendar: { id: "calendar", name: "Calendar", version: "1.0.0", minAppVersion: "0", description: "" } },
		isEnabled: () => true,
		async installPlugin(_repo: string, _version: string, manifest: { id: string }): Promise<void> { this.enabledPlugins.add(manifest.id); },
		async enablePluginAndSave(id: string): Promise<boolean> { this.enabledPlugins.add(id); return true; },
	};
	const app = { plugins: pluginHost };
	const adapter = createObsidianHostAdapter(app as never);
	const events: string[] = [];
	const release = adapter.observeCommunityPluginInstalls((event) => { events.push(`${event.kind}:${event.id}`); });
	await pluginHost.installPlugin("repo/calendar", "1.0.0", { id: "calendar" });
	await pluginHost.enablePluginAndSave("calendar");
	await Promise.resolve();
	s.check(events.join(",") === "installed:calendar,enabled:calendar", "adapter reports successful installer operations");
	s.check(adapter.communityEnabledIds().has("calendar") && adapter.communityPluginVersion("calendar") === "1.0.0", "adapter returns copied scalar plugin state");
	release();
	const missing = createObsidianHostAdapter({} as never);
	s.check(missing.communityPluginsRestricted() && !missing.canInstallCommunityPlugins(), "missing plugin manager fails closed");
	s.check(leafIdentity({ id: "leaf-a" } as never, "fallback") === "leaf-a" && leafIdentity({} as never, "fallback") === "fallback", "leaf identity has a stable fallback");
});

await s.done();
