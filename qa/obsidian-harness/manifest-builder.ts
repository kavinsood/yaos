/**
 * In-process vault manifest builder for the QA harness.
 * Produces the same format as qa/scripts/manifest.ts but runs inside Obsidian.
 */

import { type App } from "obsidian";
import { buildManifest, classifyManifestPath, type ManifestInput, type VaultManifest } from "../manifest";


export async function buildVaultManifest(app: App): Promise<VaultManifest> {
	const inputs: ManifestInput[] = [];
	for (const file of app.vault.getFiles()) {
		if (classifyManifestPath(file.path) === null) continue;
		try {
			inputs.push({
				path: file.path,
				bytes: new Uint8Array(await app.vault.readBinary(file)),
			});
		} catch {
			// A file deleted during enumeration is absent from this point-in-time manifest.
		}
	}
	return buildManifest(inputs);
}
