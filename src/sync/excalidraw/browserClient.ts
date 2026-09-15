import { BrowserExcalidrawHost, type AudienceSafeRemotePresence, type BrowserExcalidrawApi } from "./browserHost";
import { ExcalidrawSameVaultEngine, type ExcalidrawEngineStatus } from "./engine";
import type { ExcalidrawPersistencePort } from "./persistence";
import type { ExcalidrawResourcesPort } from "./host";
import type {
	AudienceSafePresenceFrame,
	PublicShareAuthorityEvent,
	PublicShareExcalidrawTransport,
	PublicShareSession,
} from "./browserTransport";
import { PublicShareWorkPreserver, type PublicShareWorkExport } from "./browserWork";

export interface PublicShareBrowserClientOptions {
	session: PublicShareSession;
	persistence: ExcalidrawPersistencePort;
	transport: PublicShareExcalidrawTransport;
	resources: ExcalidrawResourcesPort;
	onStatus?(status: ExcalidrawEngineStatus): void;
	onPresenceFrame?(frame: AudienceSafePresenceFrame): void;
	onDegraded?(reason: string): void;
	now?: () => number;
}

/** React-independent composition root for one public Excalidraw share tab. */
export class PublicShareBrowserClient {
	readonly host: BrowserExcalidrawHost;
	readonly engine: ExcalidrawSameVaultEngine;
	private readonly preserver: PublicShareWorkPreserver;
	private authorityWork = Promise.resolve();
	private started = false;

	constructor(private readonly options: PublicShareBrowserClientOptions) {
		this.host = new BrowserExcalidrawHost(options.session.publicDrawingId, {
			onSceneChange: (snapshot) => this.engine.capture(snapshot),
			onDegraded: (reason) => options.onDegraded?.(reason),
		}, { writable: options.session.permission === "read-write" });
		this.engine = new ExcalidrawSameVaultEngine({
			drawingId: options.session.publicDrawingId,
			drawingEpoch: options.session.drawingEpoch,
			path: options.session.publicDrawingId,
			persistence: options.persistence,
			transport: options.transport,
			host: this.host,
			resources: options.resources,
			now: options.now ? () => options.now?.() ?? Date.now() : undefined,
			onStatus: options.onStatus ? (status) => options.onStatus?.(status) : undefined,
		});
		this.preserver = new PublicShareWorkPreserver(options.persistence,
			options.session.publicDrawingId, options.now ? () => options.now?.() ?? Date.now() : undefined);
		options.transport.setAuthorityListener((event) => this.acceptAuthority(event));
		options.transport.setPresenceListener(options.onPresenceFrame ? (frame) => options.onPresenceFrame?.(frame) : undefined);
	}

	async start(api: BrowserExcalidrawApi): Promise<void> {
		this.host.bindApi(api);
		if (this.started) return;
		this.started = true;
		await this.engine.start();
	}

	stop(): void {
		this.started = false;
		this.engine.stop();
	}

	handleSceneChange(elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>): void {
		this.host.handleSceneChange(elements, appState, files);
	}

	handlePointerUpdate(payload: Parameters<BrowserExcalidrawHost["handlePointerUpdate"]>[0]): void {
		this.host.handlePointerUpdate(payload);
	}

	applyPresence(peers: readonly AudienceSafeRemotePresence[]): boolean {
		return this.host.applyAudienceSafePresence(peers);
	}

	async drainAuthority(): Promise<void> {
		await this.authorityWork;
	}

	exportRejectedWork(): Promise<{ value: PublicShareWorkExport; text: string }> {
		return this.preserver.exportPreserved();
	}

	private acceptAuthority(event: PublicShareAuthorityEvent): void {
		this.options.transport.setPermission(event.permission);
		this.host.setWritable(event.state === "active" && event.permission === "read-write");
		this.authorityWork = this.authorityWork.then(async () => {
			if (event.state === "active" && event.permission === "read-write") return;
			this.stop();
			await this.preserver.preservePending(this.options.session.drawingEpoch);
		}).catch(() => this.options.onDegraded?.("public Excalidraw work preservation failed"));
	}
}
