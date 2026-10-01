import { canonicalizeMarkdown, canonicalMarkdownHash, canonicalMarkdownBytes, exactMarkdownDiskFingerprint } from "@shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "@shared/durableLimits";
import { markdownConflictArtifactPath } from "../runtime/reconcile/markdownConflictArtifact";
import { AttentionNoticeQueue } from "../ui/attentionNoticeQueue";

export interface ConflictVersion {
	hash: string;
	part: string;
	offset: number;
	length: number;
	device: string;
	at: string;
	source: "disk" | "body" | "base";
}

interface ConflictArtifactRelocation {
	root: string;
	logicalPart: number;
	attempts: number;
}

export interface ConflictEpisode {
	bodyId: string;
	id: string;
	path: string;
	epoch: number | null;
	parts: string[];
	versions: ConflictVersion[];
	latestDiskHash: string | null;
	baseHash: string | null;
	notified: boolean;
	error: string | null;
	partHashes?: Record<string, string>;
	obstructions?: string[];
	relocations?: Record<string, string>;
	pendingAppend?: {
		version: ConflictVersion;
		expected: string | null;
		content: string;
		artifactHash: string;
		relocation?: ConflictArtifactRelocation;
	};
}

export interface ConflictEpisodeState {
	episodes: Record<string, ConflictEpisode>;
	artifacts: Record<string, string>;
}

export interface ConflictEpisodePort {
	read(path: string): Promise<string | null>;
	write(path: string, content: string, expected: string | null): Promise<void>;
	persist(state: ConflictEpisodeState): Promise<void>;
	changed(): void;
	notify(bodyIds: string[]): void;
}

export const CONFLICT_PART_SOFT_BYTES = 1024 * 1024;
export const CONFLICT_RELOCATION_ATTEMPTS = 100;

export class ConflictEpisodes {
	private chain: Promise<unknown> = Promise.resolve();
	private readonly notices = new AttentionNoticeQueue((ids) => this.flushNotices(ids));

	constructor(private state: ConflictEpisodeState, private readonly port: ConflictEpisodePort) {}

	snapshot(): ConflictEpisodeState {
		return structuredClone(this.state);
	}

	list(): ConflictEpisode[] {
		return Object.values(this.state.episodes);
	}

	get(bodyId: string): ConflictEpisode | undefined {
		return this.state.episodes[bodyId];
	}

	private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
		const next = this.chain.catch(() => undefined).then(operation);
		this.chain = next;
		return next;
	}

	async preserve(input: {
		bodyId: string; path: string; epoch?: number; disk: string; body: string; base?: string | null; device: string;
	}): Promise<string> {
		return this.serialized(async () => {
			const episode = this.state.episodes[input.bodyId] ?? {
				bodyId: input.bodyId, id: crypto.randomUUID(), path: input.path, epoch: input.epoch ?? null,
				parts: [], versions: [], latestDiskHash: null, baseHash: null, notified: false, error: null,
			};
			this.state.episodes[input.bodyId] = episode;
			episode.path = input.path;
			episode.epoch = input.epoch ?? episode.epoch;
			try {
				await this.finishPendingAppend(episode);
				await this.recoverParts(episode);
				if (canonicalizeMarkdown(input.disk) !== canonicalizeMarkdown(input.body)) {
					episode.latestDiskHash = await this.append(episode, input.disk, "disk", input.device);
				}
				if (input.base != null && episode.baseHash === null) {
					episode.baseHash = await this.append(episode, input.base, "base", input.device);
				}
				await this.append(episode, input.body, "body", input.device);
				episode.error = null;
			} catch (error) {
				episode.error = `Could not preserve conflict input; keep the original file and free space or review the artifact: ${String(error)}`;
				await this.port.persist(this.snapshot());
				this.port.changed();
				if (!episode.notified) this.notices.add(input.bodyId);
				throw error;
			}
			await this.port.persist(this.snapshot());
			this.port.changed();
			if (!episode.notified) {
				this.notices.add(input.bodyId);
			}
			return episode.parts[0]!;
		});
	}

	private async append(episode: ConflictEpisode, text: string, source: ConflictVersion["source"], device: string): Promise<string> {
		text = canonicalizeMarkdown(text);
		const hash = await canonicalMarkdownHash(text);
		const existing = episode.versions.find((version) => version.hash === hash);
		if (existing) {
			await this.readPreservedVersion(episode.bodyId, hash);
			return hash;
		}
		const at = new Date().toISOString();
		const label = `\n\n## ${source} version — ${at} — ${device.replace(/[\r\n]/g, " ")}\nSHA-256: ${hash}\n\n`;
		let part = episode.parts[episode.parts.length - 1];
		let previous = part ? await this.port.read(part) : null;
		if (part && previous === null) throw new Error(`Missing conflict artifact ${part}`);
		if (part && previous !== null && this.state.artifacts[part] !== (await exactMarkdownDiskFingerprint(previous)).hash) {
			await this.recordObstruction(episode, part, previous);
			throw new Error(`Conflict artifact changed: ${part}; restore the original artifact before retrying`);
		}
		if (!part || canonicalMarkdownBytes((previous ?? "") + label + text).byteLength > CONFLICT_PART_SOFT_BYTES) {
			const first = episode.parts[0];
			const root = first ?? markdownConflictArtifactPath(episode.path, device, "disk");
			part = first ? root.replace(/\.md$/, ` (YAOS conflict – part ${episode.parts.length + 1}).md`) : root;
			previous = null;
		}
		const header = previous === null
			? `<!-- YAOS conflict episode ${episode.id} body ${encodeURIComponent(episode.bodyId)} -->\n# YAOS conflict history\nOriginal: ${episode.path}\n${episode.parts[0] ? `First part: [[${episode.parts[0]}]]\n` : ""}`
			: previous;
		const content = header + label + text;
		if (canonicalMarkdownBytes(content).byteLength > MAX_CLIENT_MARKDOWN_BYTES) throw new Error("Version and labels exceed the Markdown size limit");
		if (!episode.parts.includes(part)) episode.parts.push(part);
		episode.pendingAppend = {
			version: { hash, part, offset: header.length + label.length, length: text.length, device, at, source },
			expected: previous, content, artifactHash: (await exactMarkdownDiskFingerprint(content)).hash,
		};
		await this.finishPendingAppend(episode);
		return hash;
	}

	private async finishPendingAppend(episode: ConflictEpisode): Promise<void> {
		const pending = episode.pendingAppend;
		if (!pending) return;
		episode.partHashes ??= {};
		pending.relocation ??= {
			root: pending.version.part, logicalPart: episode.parts.indexOf(pending.version.part) + 1, attempts: 0,
		};
		await this.port.persist(this.snapshot());
		let relocations = 0;
		for (;;) {
			const current = await this.port.read(pending.version.part);
			if (current !== pending.content && current !== pending.expected) {
				if (++relocations > CONFLICT_RELOCATION_ATTEMPTS) throw this.relocationExhausted(pending.version.part);
				await this.relocate(episode);
				continue;
			}
			if (current !== pending.content) {
				try { await this.port.write(pending.version.part, pending.content, pending.expected); }
				catch (error) {
					const changed = await this.port.read(pending.version.part);
					if (changed !== current && changed !== pending.content) continue;
					throw error;
				}
			}
			break;
		}
		if (!episode.versions.some((version) => version.hash === pending.version.hash)) episode.versions.push(pending.version);
		this.state.artifacts[pending.version.part] = pending.artifactHash;
		episode.partHashes[pending.version.part] = pending.artifactHash;
		if (pending.version.source === "disk") episode.latestDiskHash = pending.version.hash;
		if (pending.version.source === "base") episode.baseHash = pending.version.hash;
		delete episode.pendingAppend;
		await this.port.persist(this.snapshot());
	}

	private relocationExhausted(part: string): Error {
		return new Error(`Conflict artifact relocation exhausted ${CONFLICT_RELOCATION_ATTEMPTS} paths for ${part}; move unrelated occupants out of the conflict destination folder and retry`);
	}

	private replacementPath(episode: ConflictEpisode, relocation: ConflictArtifactRelocation, attempt: number): string {
		const slash = relocation.root.lastIndexOf("/");
		const directory = relocation.root.slice(0, slash + 1);
		const suffix = ` (YAOS conflict relocation ${episode.id} part ${relocation.logicalPart} ${attempt}).md`;
		let basename = relocation.root.slice(slash + 1).replace(/\.md$/i, "");
		while (new TextEncoder().encode(basename + suffix).byteLength > 255) basename = Array.from(basename).slice(0, -1).join("");
		return directory + basename + suffix;
	}

	private async recordObstruction(episode: ConflictEpisode, part: string, content: string | null): Promise<void> {
		if (content !== null && this.state.artifacts[part] === (await exactMarkdownDiskFingerprint(content)).hash) return;
		episode.partHashes ??= {};
		if (episode.parts.includes(part) && this.state.artifacts[part]) episode.partHashes[part] = this.state.artifacts[part]!;
		delete this.state.artifacts[part];
		if (content !== null) {
			episode.obstructions ??= [];
			if (!episode.obstructions.includes(part)) episode.obstructions.push(part);
		}
	}

	private async relocate(episode: ConflictEpisode): Promise<void> {
		const pending = episode.pendingAppend!;
		const relocation = pending.relocation!;
		const from = pending.version.part;
		const obstructing = await this.port.read(from);
		await this.recordObstruction(episode, from, obstructing);
		await this.port.persist(this.snapshot());
		let replacement: string | undefined;
		const firstAttempt = relocation.attempts;
		for (let index = 0; index < CONFLICT_RELOCATION_ATTEMPTS; index++) {
			const attempt = (firstAttempt + index) % CONFLICT_RELOCATION_ATTEMPTS + 1;
			relocation.attempts = Math.max(relocation.attempts, attempt);
			const candidate = this.replacementPath(episode, relocation, attempt);
			await this.port.persist(this.snapshot());
			if (episode.parts.includes(candidate)) continue;
			const content = await this.port.read(candidate);
			if (content === null) {
				replacement = candidate;
				break;
			}
			await this.recordObstruction(episode, candidate, content);
		}
		if (replacement === undefined) {
			await this.port.persist(this.snapshot());
			throw this.relocationExhausted(from);
		}
		episode.parts = episode.parts.map((part) => part === from ? replacement : part);
		for (const version of episode.versions) if (version.part === from) version.part = replacement;
		pending.version.part = replacement;
		episode.relocations ??= {};
		for (const previous of Object.keys(episode.relocations)) {
			if (episode.relocations[previous] === from) episode.relocations[previous] = replacement;
		}
		episode.relocations[from] = replacement;
		if (episode.partHashes![from] !== undefined) {
			episode.partHashes![replacement] = episode.partHashes![from]!;
			delete episode.partHashes![from];
		}
		pending.expected = null;
		await this.port.persist(this.snapshot());
	}

	private async recoverParts(episode: ConflictEpisode): Promise<void> {
		episode.partHashes ??= {};
		for (let index = 0; index < episode.parts.length; index++) {
			const part = episode.parts[index]!;
			const current = await this.port.read(part);
			const expectedHash = episode.partHashes[part] ?? this.state.artifacts[part];
			if (expectedHash) episode.partHashes[part] = expectedHash;
			if (current !== null && expectedHash === (await exactMarkdownDiskFingerprint(current)).hash) {
				this.state.artifacts[part] = expectedHash;
				continue;
			}
			await this.recordObstruction(episode, part, current);
			await this.port.persist(this.snapshot());
			throw new Error(`Conflict artifact changed or missing: ${part}; completed history cannot be reconstructed from hashes; restore original bytes and retry`);
		}
	}

	async readVersion(bodyId: string, hash: string): Promise<string> {
		return this.serialized(() => this.readPreservedVersion(bodyId, hash));
	}

	private async readPreservedVersion(bodyId: string, hash: string): Promise<string> {
		const episode = this.get(bodyId);
		if (episode?.pendingAppend) await this.finishPendingAppend(episode);
		for (let attempt = 0; attempt < 3; attempt++) {
			if (episode) {
				await this.recoverParts(episode);
				await this.port.persist(this.snapshot());
			}
			const version = episode?.versions.find((candidate) => candidate.hash === hash);
			if (!version) throw new Error("Missing preserved conflict version");
			const content = await this.port.read(version.part);
			if (content === null || this.state.artifacts[version.part] !== (await exactMarkdownDiskFingerprint(content)).hash) continue;
			const text = content.slice(version.offset, version.offset + version.length);
			if (await canonicalMarkdownHash(text) !== hash) throw new Error(`Conflict artifact changed: ${version.part}; review it manually`);
			return text;
		}
		throw new Error("Conflict artifact keeps changing during recovery; pause external edits and retry");
	}

	async isArtifact(path: string, content: string): Promise<boolean> {
		return path.includes("(YAOS conflict") && this.state.artifacts[path] === (await exactMarkdownDiskFingerprint(content)).hash;
	}

	async close(bodyId: string): Promise<void> {
		await this.serialized(async () => {
			const episode = this.get(bodyId);
			if (episode) {
				await this.finishPendingAppend(episode);
				await this.recoverParts(episode);
			}
			delete this.state.episodes[bodyId];
			await this.port.persist(this.snapshot());
			this.port.changed();
		});
	}

	async rename(bodyId: string, path: string): Promise<void> {
		await this.serialized(async () => {
			const episode = this.get(bodyId);
			if (!episode) return;
			episode.path = path;
			await this.port.persist(this.snapshot());
			this.port.changed();
		});
	}

	private async flushNotices(pending: string[]): Promise<void> {
		await this.serialized(async () => {
			const ids = pending.filter((bodyId) => this.get(bodyId) && !this.get(bodyId)!.notified);
			for (const bodyId of ids) this.get(bodyId)!.notified = true;
			if (ids.length) {
				await this.port.persist(this.snapshot());
				this.port.notify(ids);
			}
		}).catch(() => undefined);
	}

	dispose(): void {
		this.notices.dispose();
	}
}
