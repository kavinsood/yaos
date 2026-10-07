/**
 * e2ee-design §6.1 "Linux desktop without an OS keyring": SecretStorage then keeps the vault key in plaintext
 * (Obsidian shows its own `msgSecretsNotEncrypted` warning). YAOS tells the user once per vault, the first time it
 * stores or loads a key on such a device. The "shown" flag lives in the vault's local storage
 * (App.loadLocalStorage / saveLocalStorage, obsidian.d.ts :472 / :480), never in data.json.
 */

export const PLAINTEXT_NOTICE_KEY = "yaos-e2ee-plaintext-notice";

export const PLAINTEXT_NOTICE_TEXT =
	"YAOS: this device has no system keyring, so Obsidian stores the vault encryption key unencrypted on this device. "
	+ "Anyone who can read this device's Obsidian data can read the key.";

export interface PlaintextNoticeEnv {
	load(key: string): unknown;
	save(key: string, value: string): void;
	show(text: string): void;
}

/** A function that shows the notice the first time it is called on this vault, and never again. */
export function plaintextNoticeOnce(env: PlaintextNoticeEnv): () => void {
	let shown = false;
	return () => {
		if (shown) return;
		shown = true;
		try {
			if (env.load(PLAINTEXT_NOTICE_KEY) === "1") return;
			env.save(PLAINTEXT_NOTICE_KEY, "1");
		} catch {
			// Local storage unavailable: still tell the user once per session.
		}
		env.show(PLAINTEXT_NOTICE_TEXT);
	};
}
