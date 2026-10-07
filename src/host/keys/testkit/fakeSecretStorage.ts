/**
 * Test-only SecretStorage with the behaviour seen in Obsidian 1.13.7 / 1.14.4 (asar, read-only): getSecret and
 * listSecrets see nothing until the store loaded, load fires `changed`, setSecret validates the id
 * (/^[a-z0-9-]+$/, at most 64 chars), throws when no secure storage exists, saves and fires `changed`.
 * `backing` is the device's persistent store: a new FakeSecretStorage over the same map is an app restart.
 */

import type { SecretStorageLike } from "../secretStore";

export class FakeSecretStorage implements SecretStorageLike {
	private readonly listeners = new Set<() => void>();
	loaded: boolean;
	available: boolean;
	encryption: boolean;
	/** setSecret calls that stored a value. */
	writes = 0;

	constructor(
		readonly backing: Map<string, string> = new Map(),
		o: { readonly loaded?: boolean; readonly available?: boolean; readonly encryption?: boolean } = {},
	) {
		this.loaded = o.loaded ?? true;
		this.available = o.available ?? true;
		this.encryption = o.encryption ?? true;
	}

	/** The app finished loading secrets. */
	load(): void {
		this.loaded = true;
		this.trigger();
	}

	setSecret(id: string, secret: string): void {
		if (!this.available) throw new Error("Secure storage is not available.");
		if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) throw new Error(`Invalid secret ID: ${id}`);
		this.backing.set(id, secret);
		this.writes++;
		this.trigger();
	}

	getSecret(id: string): string | null {
		return this.loaded ? (this.backing.get(id) ?? null) : null;
	}

	listSecrets(): string[] {
		return this.loaded ? [...this.backing.keys()] : [];
	}

	on(name: "changed", callback: (...data: unknown[]) => unknown): { off(): void } {
		const fn = (): void => void callback();
		if (name === "changed") this.listeners.add(fn);
		return { off: () => this.listeners.delete(fn) };
	}

	offref(ref: never): void {
		(ref as { off(): void }).off();
	}

	isEncryptionAvailable(): boolean {
		return this.encryption;
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	private trigger(): void {
		for (const l of [...this.listeners]) l();
	}
}
