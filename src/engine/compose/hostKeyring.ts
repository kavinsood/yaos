/**
 * The keyring as main last stored it (e2ee-design §6.1, §18.4), one per init and shared by the gate, the KeyReader
 * and every VaultRuntime of that init. `persist` is the keyringChanged round trip: it resolves only once main
 * answered keyringStored (persist-before-use), then zero-fills the keys it was handed. `records` is the winning set
 * main holds now, so a runtime started after a change (the gate opening, an epoch or settings restart) begins
 * from it rather than from init's copy.
 */

import type { EngineInitConfig } from "../../protocol/messages";
import type { KeyringChange } from "../keyring/keyring";
import type { HostLink } from "./hostLink";

export class HostKeyring {
	private stored: readonly Uint8Array[];

	constructor(private readonly link: HostLink, crypto: EngineInitConfig["crypto"]) {
		this.stored = crypto.suite === 1 ? crypto.records.map((b) => b.slice()) : [];
	}

	/** The winning records main holds (public bytes). */
	get records(): readonly Uint8Array[] {
		return this.stored;
	}

	readonly persist = async (ch: KeyringChange): Promise<void> => {
		// The message transfers its buffers: hand over copies. The keyring keeps the originals to retry a failed store.
		await this.link.keyringChanged({ keys: ch.keys.map((x) => ({ e: x.e, k: x.k.slice() })), records: ch.records.map((b) => b.slice()), pending: ch.pending });
		for (const x of ch.keys) x.k.fill(0);
		// Main keeps its records when a change carries none (secretStore.ts merge); so does this copy.
		if (ch.records.length > 0) this.stored = ch.records.map((b) => b.slice());
	};
}
