/**
 * TEST ONLY (testkit/: never imported by product code). A YaosUiHost stand-in for the pure UI flows
 * (createVault.ts, keyActions.ts): data, status and run state are plain fields a test sets, every command goes to a
 * scripted handler, and main's own pin rules come from src/host/keys/pin.ts as in the controller.
 */

import type { UserCommand, EngineResultValue } from "../../../protocol/messages";
import type { E2eeStatus, EnginePhase, StatusSnapshot } from "../../../protocol/status";
import { markedCreating, pinAcross, withoutCreating } from "../../keys/pin";
import { defaultPluginData, type EngineRunState, type PairedIdentity, type YaosPluginData, type YaosUiHost } from "../api";

export const RUNNING: EngineRunState = { phase: "running", transport: "worker", lastError: null };

export function snapshot(phase: EnginePhase, e2ee: Partial<E2eeStatus> = {}, over: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		phase,
		deviceClass: "desktop",
		transport: "worker",
		vaultEpoch: "e1",
		vaultSeq: 0,
		headSeq: 0,
		relay: { connected: true, lastCloseCode: null, reconnectInMs: null, rttMs: null },
		counts: {
			liveDocs: 0, staleStreams: 0, outboxFrames: 0, outboxBytes: 0, unreceiptedFrames: 0, residentDocs: 0,
			residentBytesEstimate: 0, pendingDiskOps: 0, pendingBlobs: 0, quarantinedRows: 0, frozenDocs: 0, conflictCopiesToday: 0,
		},
		bootstrap: null,
		brake: null,
		lastFullReconcileAtMs: null,
		lastSyncedAtMs: null,
		dailyFramesUsed: 0,
		maxBlobBytes: null,
		notices: [],
		e2ee: { suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: false, ...e2ee },
		...over,
	};
}

export function identityFor(vaultId: string, host = "https://sync.example.com"): PairedIdentity {
	return { host, vaultId, deviceId: "dev_ABCDEFGHIJKLMNOP", deviceToken: "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", deviceName: "Mac", vaultGeneration: null };
}

export type CommandHandler = (command: UserCommand, host: FakeUiHost) => Promise<EngineResultValue> | EngineResultValue;

export class FakeUiHost implements YaosUiHost {
	readonly app = {} as YaosUiHost["app"];
	readonly pluginVersion = "0.0.0-test";
	current: YaosPluginData;
	snap: StatusSnapshot | null = null;
	run: EngineRunState = RUNNING;
	/** Every command, in order (the bytes as they arrived, before the caller zero-filled its copy). */
	readonly commands: UserCommand[] = [];
	/** Calls of the host methods, in order: "markCreating:<id>", "abandonCreating:<id>", "updateData", "command:<t>". */
	readonly calls: string[] = [];
	handler: CommandHandler = () => ({ t: "ok" });
	qrKey: { readonly e: number; readonly k: Uint8Array } | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(data: Partial<YaosPluginData> = {}) {
		this.current = { ...defaultPluginData("Mac"), ...data };
	}

	data(): YaosPluginData { return this.current; }

	async updateData(mutate: (d: YaosPluginData) => YaosPluginData): Promise<void> {
		this.calls.push("updateData");
		const prev = this.current;
		const raw = mutate(prev);
		if (raw === prev) return;
		// As the controller does (pluginController.ts updateData): the UI never writes the pin fields.
		const same = prev.identity !== null && raw.identity !== null && prev.identity.host === raw.identity.host && prev.identity.vaultId === raw.identity.vaultId;
		this.current = pinAcross(prev, raw, same, raw.identity?.vaultId ?? null);
		this.emit();
	}

	status(): StatusSnapshot | null { return this.snap; }
	runState(): EngineRunState { return this.run; }

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	get listenerCount(): number { return this.listeners.size; }

	/** Set the status (and optionally data) and notify listeners. */
	setStatus(snap: StatusSnapshot | null): void {
		this.snap = snap;
		this.emit();
	}

	/** What the controller does after an authenticated answer (pinnedSuite0 / pinnedSuite1): pin and drop the marker. */
	pin(suite: 0 | 1): void {
		const { creating: _c, ...rest } = this.current;
		this.current = { ...rest, e2ee: { suite } };
		this.emit();
	}

	emit(): void {
		for (const l of [...this.listeners]) l();
	}

	async command(command: UserCommand): Promise<EngineResultValue> {
		this.calls.push(`command:${command.t}`);
		this.commands.push(cloneCommand(command));
		return this.handler(command, this);
	}

	async restartEngine(): Promise<void> {}
	brake(): null { return null; }
	async writeDiagnosticsFile(name: string): Promise<string> { return name; }

	async markCreating(vaultId: string): Promise<void> {
		this.calls.push(`markCreating:${vaultId}`);
		this.current = markedCreating(this.current, vaultId, this.current.identity?.vaultId ?? null);
		this.emit();
	}

	async abandonCreating(vaultId: string): Promise<void> {
		this.calls.push(`abandonCreating:${vaultId}`);
		this.current = withoutCreating(this.current, vaultId);
		this.emit();
	}

	/** A stand-in checksum: NOT SHA-256; recoveryKeyText.test.ts checks the real one. */
	async rkChecksum(secret: Uint8Array): Promise<Uint8Array> {
		let a = 7, b = 11, c = 13;
		for (const x of secret) { a = (a * 31 + x) & 0xff; b = (b ^ x) & 0xff; c = (c + x * 3) & 0xff; }
		return Uint8Array.of(a, b, c);
	}

	vaultKeyForQr(): { readonly e: number; readonly k: Uint8Array } | null {
		return this.qrKey ? { e: this.qrKey.e, k: this.qrKey.k.slice() } : null;
	}
}

function cloneCommand(c: UserCommand): UserCommand {
	switch (c.t) {
		case "enableE2ee": return { t: "enableE2ee", rk: c.rk.slice() };
		case "revokeRekey": return { t: "revokeRekey", rk: c.rk.slice() };
		case "installKey": return c.source === "rk" ? { t: "installKey", source: "rk", rk: c.rk.slice() } : { t: "installKey", source: "qr", e: c.e, k: c.k.slice() };
		default: return c;
	}
}
