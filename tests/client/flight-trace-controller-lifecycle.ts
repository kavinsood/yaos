import {
	FlightTraceController,
	setupFlightTraceBestEffort,
	type FlightTraceDeps,
} from "../../src/telemetry/debug/flightTraceController";
import { FLIGHT_KIND } from "../../src/observability/flightTaxonomy";
import { suite } from "../harness.ts";

const s = suite("flight-trace-controller-lifecycle");

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakeWindow {
	private nextTimerId = 0;
	readonly intervals = new Map<number, () => void>();
	readonly timeouts = new Map<number, () => void>();
	readonly listeners = new Map<string, Set<(event: unknown) => void>>();

	setInterval(handler: () => void): number {
		const id = this.nextTimerId++;
		this.intervals.set(id, handler);
		return id;
	}

	clearInterval(id: number): void {
		this.intervals.delete(id);
	}

	setTimeout(handler: () => void): number {
		const id = this.nextTimerId++;
		this.timeouts.set(id, handler);
		return id;
	}

	clearTimeout(id: number): void {
		this.timeouts.delete(id);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

async function settleAsyncWrites(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

s.section("Trace setup failure is availability-neutral");
{
	const marker = new Error("trace startup failed");
	let reported: unknown = null;
	let productInitializationContinued = false;
	await setupFlightTraceBestEffort(
		async () => {
			throw marker;
		},
		(error) => {
			reported = error;
		},
	);
	productInitializationContinued = true;
	s.check(reported === marker, "trace setup failure is reported");
	s.check(productInitializationContinued, "trace setup rejection resolves so product initialization can continue");
}

s.section("Deferred start, stop, and restart share one lifecycle");
{
	const fakeWindow = new FakeWindow();
	Object.defineProperty(globalThis, "window", {
		value: fakeWindow,
		configurable: true,
		writable: true,
	});

	const written: string[] = [];
	const app = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_path: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};
	const settings = {
		vaultId: "vault-lifecycle",
		host: "https://sync.example.com",
		deviceToken: "super-secret-device-token",
		deviceName: "private-device",
		debug: true,
		enableAttachmentSync: false,
		externalEditPolicy: "newest-wins",
	};
	let deviceIdGate = deferred<string>();
	let indexedDbDegradedCount = 0;
	const deps: FlightTraceDeps = {
		app: app as never,
		getSettings: () => settings as never,
		getPluginVersion: () => "test",
		getDocSchemaVersion: () => 3,
		buildCheckpoint: async () => ({}),
		collectTraceHeaderInput: async () => null,
		isIndexedDbRelatedError: (error) => error instanceof Error && error.message.includes("IndexedDB"),
		isObsidianFileMetadataRaceError: (error) => error instanceof Error && error.message.includes("metadata race"),
		handleIndexedDbDegraded: () => { indexedDbDegradedCount++; },
		getLocalDeviceId: () => deviceIdGate.promise,
		log: () => {},
	};
	const controller = new FlightTraceController(deps);

	const firstStart = controller.start();
	const coalescedStart = controller.start();
	s.check(firstStart === coalescedStart, "concurrent starts coalesce onto the same transition promise");

	settings.debug = false;
	const stopDuringStart = controller.refreshFromSettings("debug-disabled-during-start");
	deviceIdGate.resolve("device-id-one");
	await Promise.all([firstStart, coalescedStart, stopDuringStart]);
	s.check(!controller.isEnabled && controller.currentRecorder === null, "stop during deferred start prevents recorder publication");
	s.check(fakeWindow.intervals.size === 0, "cancelled start leaves no polling interval");
	s.check(fakeWindow.listenerCount("error") === 0, "cancelled start leaves no error listener");
	s.check(fakeWindow.listenerCount("unhandledrejection") === 0, "cancelled start leaves no rejection listener");

	settings.debug = true;
	deviceIdGate = deferred<string>();
	const restarted = controller.start();
	const restartedAgain = controller.start();
	s.check(restarted === restartedAgain, "restart calls also coalesce while device identity is deferred");
	deviceIdGate.resolve("device-id-two");
	await Promise.all([restarted, restartedAgain]);
	const publishedRecorder = controller.currentRecorder;
	s.check(controller.isEnabled && publishedRecorder !== null, "restart publishes one recorder");
	s.check(fakeWindow.intervals.size === 1, "running trace owns exactly one polling interval");
	s.check(fakeWindow.listenerCount("error") === 1, "running trace owns exactly one error listener");
	s.check(fakeWindow.listenerCount("unhandledrejection") === 1, "running trace owns exactly one rejection listener");
	await controller.start();
	s.check(controller.currentRecorder === publishedRecorder, "refresh while enabled does not replace the recorder");
	s.check(fakeWindow.intervals.size === 1, "refresh while enabled does not duplicate polling");

	const crash = new TypeError(`Could not read /Users/alice/private/secret.md token=${settings.deviceToken}`);
	crash.stack = `TypeError: ${crash.message}\n    at run (/Users/alice/private/plugin.js:12:8)`;
	fakeWindow.emit("error", {
		error: crash,
		message: crash.message,
		filename: "/Users/alice/private/plugin.js",
		lineno: 12,
		colno: 8,
		preventDefault: () => {},
	});
	await settleAsyncWrites();
	const durableAfterWindowCrash = written.join("");
	const windowCrash = durableAfterWindowCrash
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind?: string; data?: { event?: string; details?: Record<string, unknown> } })
		.find((event) => event.kind === FLIGHT_KIND.debugTraceEvent && event.data?.event === "window-error");
	const windowCrashDetails = windowCrash?.data?.details;
	s.check(windowCrash !== undefined, "window crash is durably appended without waiting for the normal timer");
	s.check(windowCrashDetails?.name === "TypeError", "window crash preserves the error name");
	s.check(String(windowCrashDetails?.message).includes("Could not read"), "window crash preserves a useful sanitized message");
	s.check(typeof windowCrashDetails?.stack === "string", "window crash preserves a sanitized stack");
	s.check(windowCrashDetails?.line === 12 && windowCrashDetails?.column === 8, "window crash preserves source coordinates");
	s.check(windowCrashDetails?.file === "[redacted-file]", "window crash records that a source file existed without exposing it");
	s.check(!durableAfterWindowCrash.includes(settings.deviceToken), "durable crash evidence excludes the bearer token");
	s.check(!durableAfterWindowCrash.includes("/Users/alice"), "durable crash evidence excludes raw filesystem paths");
	s.check(!durableAfterWindowCrash.includes("secret.md"), "durable crash evidence excludes raw sensitive filenames");

	const rejection = new Error(`Rejected request for /Users/alice/private/other.md with token=${settings.deviceToken}`);
	let rejectionPrevented = false;
	fakeWindow.emit("unhandledrejection", {
		reason: rejection,
		preventDefault: () => { rejectionPrevented = true; },
	});
	await settleAsyncWrites();
	const durableAfterRejection = written.join("");
	s.check(durableAfterRejection.includes("unhandled-rejection"), "unhandled rejection is immediately made durable");
	s.check(!durableAfterRejection.includes(settings.deviceToken), "rejection evidence excludes the token");
	s.check(!durableAfterRejection.includes("/Users/alice"), "rejection evidence excludes raw paths");
	s.check(!rejectionPrevented, "ordinary rejection remains visible to the host error policy");

	let metadataPrevented = 0;
	for (let i = 0; i < 2; i++) {
		fakeWindow.emit("unhandledrejection", {
			reason: new Error("metadata race in private file"),
			preventDefault: () => { metadataPrevented++; },
		});
	}
	const metadataEvents = controller.currentRecorder?.recentEvents.filter((event) =>
		event.kind === FLIGHT_KIND.debugTraceEvent
		&& event.data?.event === "unhandled-rejection-file-metadata-race") ?? [];
	s.check(metadataEvents.length === 1, "metadata-race crash evidence remains throttled");
	s.check(metadataPrevented === 2, "every recognized metadata race remains handled");

	let indexedDbPrevented = false;
	fakeWindow.emit("unhandledrejection", {
		reason: new Error("IndexedDB transaction failed"),
		preventDefault: () => { indexedDbPrevented = true; },
	});
	await settleAsyncWrites();
	s.check(indexedDbDegradedCount === 1, "IndexedDB rejection still invokes degraded-mode handling");
	s.check(indexedDbPrevented, "IndexedDB rejection remains handled");
	s.check(written.join("").includes("unhandled-rejection-indexeddb"), "IndexedDB crash evidence is durably requested");

	settings.debug = false;
	await controller.refreshFromSettings("debug-off");
	s.check(!controller.isEnabled && controller.currentRecorder === null, "debug-off disposes the recorder");
	s.check(fakeWindow.intervals.size === 0, "debug-off removes polling");
	s.check(fakeWindow.listenerCount("error") === 0, "debug-off removes the error listener");
	s.check(fakeWindow.listenerCount("unhandledrejection") === 0, "debug-off removes the rejection listener");
	s.check(fakeWindow.timeouts.size === 0, "debug-off clears checkpoint and recorder flush timers");
}

await s.done();
