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
				if (input.base != null && episode.baseHash === null) {
					episode.baseHash = await this.append(episode, input.base, "base", input.device);
				}
				await this.append(episode, input.body, "body", input.device);
				if (canonicalizeMarkdown(input.disk) !== canonicalizeMarkdown(input.body)) {
					episode.latestDiskHash = await this.append(episode, input.disk, "disk", input.device);
				}
				episode.error = null;
			} catch (error) {
				episode.error = `Could not preserve conflict input; keep the original file and free space or review the artifact: ${String(error)}`;
				await this.port.persist(this.snapshot());
				this.port.changed();
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
			await this.readVersion(episode.bodyId, hash);
			return hash;
		}
		const at = new Date().toISOString();
		const label = `\n\n## ${source} version — ${at} — ${device.replace(/[\r\n]/g, " ")}\nSHA-256: ${hash}\n\n`;
		let part = episode.parts[episode.parts.length - 1];
		let previous = part ? await this.port.read(part) : null;
		if (part && previous === null) throw new Error(`Missing conflict artifact ${part}`);
		if (!part || canonicalMarkdownBytes((previous ?? "") + label + text).byteLength > CONFLICT_PART_SOFT_BYTES) {
			const first = episode.parts[0];
			const root = first ?? markdownConflictArtifactPath(episode.path, device, "disk");
			part = first ? root.replace(/\.md$/, ` (YAOS conflict – part ${episode.parts.length + 1}).md`) : root;
			for (let index = 0; await this.port.read(part) !== null; index++) {
				if (index >= 100) throw new Error("No available conflict artifact path");
				part = root.replace(/\.md$/, ` ${episode.id}-${index + 1}.md`);
			}
			previous = null;
		}
		const header = previous === null
			? `<!-- YAOS conflict episode ${episode.id} body ${encodeURIComponent(episode.bodyId)} -->\n# YAOS conflict history\nOriginal: ${episode.path}\n${episode.parts[0] ? `First part: [[${episode.parts[0]}]]\n` : ""}`
			: previous;
		const content = header + label + text;
		if (canonicalMarkdownBytes(content).byteLength > MAX_CLIENT_MARKDOWN_BYTES) throw new Error("Version and labels exceed the Markdown size limit");
		await this.port.write(part, content, previous);
		if (!episode.parts.includes(part)) episode.parts.push(part);
		episode.versions.push({ hash, part, offset: header.length + label.length, length: text.length, device, at, source });
		this.state.artifacts[part] = (await exactMarkdownDiskFingerprint(content)).hash;
		return hash;
	}

	async readVersion(bodyId: string, hash: string): Promise<string> {
		const version = this.get(bodyId)?.versions.find((candidate) => candidate.hash === hash);
		if (!version) throw new Error("Missing preserved conflict version");
		const content = await this.port.read(version.part);
		if (content === null) throw new Error(`Missing conflict artifact ${version.part}`);
		const text = content.slice(version.offset, version.offset + version.length);
		if (await canonicalMarkdownHash(text) !== hash) throw new Error(`Conflict artifact changed: ${version.part}; review it manually`);
		return text;
	}

	async isArtifact(path: string, content: string): Promise<boolean> {
		return path.includes("(YAOS conflict") && this.state.artifacts[path] === (await exactMarkdownDiskFingerprint(content)).hash;
	}

	async close(bodyId: string): Promise<void> {
		await this.serialized(async () => {
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
