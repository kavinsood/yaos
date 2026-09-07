/**
 * Frontmatter guard / quarantine orchestration.
 *
 * Extracted from src/main.ts to give the nine notice-dedup + quarantine
 * methods a clear home with minimal dependencies.
 *
 * The coordinator owns:
 *   - per-path notice fingerprint deduplication (internal Map)
 *   - all logic for deciding whether to show a Notice, trace an event,
 *     or persist a quarantine entry
 *
 * It does NOT own the quarantine entry list itself — that lives in the plugin
 * and is accessed through FrontmatterGuardHost so that settings persistence
 * and load/unload can continue to manage it centrally.
 */

import { Notice } from "obsidian";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	extractFrontmatter,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";
import {
	upsertFrontmatterQuarantineEntry,
	clearFrontmatterQuarantinePath,
	clearResolvedFrontmatterQuarantinePath,
	type FrontmatterQuarantineEntry,
	type FrontmatterQuarantineEvidence,
} from "./frontmatterQuarantine";
import { sha256TextHex } from "../utils/sha256";
import { FRONTMATTER_BOUNDARY_VERSION } from "./frontmatterBoundary";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/**
 * Narrow interface the plugin must satisfy.
 *
 * The coordinator reads the setting through a host callback so it always sees
 * the live value without holding a stale copy.
 */
export interface FrontmatterGuardHost {
	isFrontmatterGuardEnabled(): boolean;
	trace(source: string, event: string, data?: Record<string, unknown>): void;
	persistPluginState(): Promise<void>;
	getFrontmatterQuarantineEntries(): FrontmatterQuarantineEntry[];
	setFrontmatterQuarantineEntries(entries: FrontmatterQuarantineEntry[]): void;
	getFrontmatterQuarantineEvidence?(path: string): Promise<FrontmatterQuarantineEvidence>;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class FrontmatterGuardCoordinator {
	/**
	 * Per-direction-per-path fingerprint of the last notice shown.
	 * Key: `"{direction}:{path}"`, value: fingerprint string.
	 * Used to deduplicate repeated notices for the same unchanged validation.
	 */
	private readonly fingerprintMap = new Map<string, string>();

	constructor(private readonly host: FrontmatterGuardHost) {}

	// -----------------------------------------------------------------------
	// Public API (mirrors the former private methods on VaultCrdtSyncPlugin)
	// -----------------------------------------------------------------------

	shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean {
		if (!this.host.isFrontmatterGuardEnabled()) return false;

		const validation = validateFrontmatterTransition(previousContent, nextContent);
		this.handleFrontmatterValidation(
			path,
			"disk-to-crdt",
			reason,
			validation,
			previousContent,
			nextContent,
		);
		return isFrontmatterBlocked(validation);
	}

	handleFrontmatterValidation(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
	): void {
		if (validation.risk === "ok") {
			this.clearFrontmatterNoticeFingerprint(path, direction);
			void this.resolveFrontmatterQuarantine(path, `${direction}:${reason}`, nextContent);
			return;
		}

		if (!isFrontmatterBlocked(validation)) return;

		const noticeFingerprint = this.buildFrontmatterNoticeFingerprint(validation);
		const shouldNotify = this.shouldNotifyFrontmatterQuarantine(
			path,
			direction,
			noticeFingerprint,
		);
		const notifiedAt = shouldNotify ? Date.now() : null;

		this.traceFrontmatterQuarantine(
			path,
			direction,
			reason,
			validation,
			previousContent?.length ?? null,
			nextContent.length,
		);
		if (shouldNotify) {
			this.showFrontmatterGuardNotice(path);
		}
		void this.persistFrontmatterQuarantine(
			path,
			direction,
			validation,
			previousContent,
			nextContent,
			noticeFingerprint,
			notifiedAt,
		);
	}

	showFrontmatterGuardNotice(path: string): void {
		new Notice(
			`YAOS paused a properties update in "${path}" because the frontmatter looked unsafe. Check diagnostics before accepting the change.`,
			12_000,
		);
	}

	buildFrontmatterNoticeFingerprint(
		validation: FrontmatterValidationResult,
	): string {
		const reasons = [...validation.reasons].sort().join("|");
		return [
			reasons,
			String(validation.previousFrontmatterLength ?? "none"),
			String(validation.frontmatterLength ?? "none"),
		].join("#");
	}

	shouldNotifyFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		noticeFingerprint: string,
	): boolean {
		const key = `${direction}:${path}`;
		if (this.fingerprintMap.get(key) === noticeFingerprint) return false;
		this.fingerprintMap.set(key, noticeFingerprint);
		return true;
	}

	clearFrontmatterNoticeFingerprint(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
	): void {
		this.fingerprintMap.delete(`${direction}:${path}`);
	}

	traceFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousLength: number | null,
		nextLength: number,
	): void {
		this.host.trace("quarantine", "frontmatter-quarantined", {
			path,
			direction,
			reason,
			risk: validation.risk,
			reasons: validation.reasons,
			previousLength,
			nextLength,
			previousFrontmatterLength: validation.previousFrontmatterLength ?? null,
			nextFrontmatterLength: validation.frontmatterLength,
		});
	}

	async persistFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
		lastNotifiedFingerprint: string,
		lastNoticeAt: number | null,
	): Promise<void> {
		const now = Date.now();
		const [prevHash, nextHash, evidence] = await Promise.all([
			this.hashFrontmatterContent(previousContent),
			this.hashFrontmatterContent(nextContent),
			this.readQuarantineEvidence(path),
		]);
		const updated = upsertFrontmatterQuarantineEntry(
			this.host.getFrontmatterQuarantineEntries(),
			{
				path,
				...evidence,
				state: this.quarantineState(previousContent, nextContent),
				boundaryVersion: FRONTMATTER_BOUNDARY_VERSION,
				firstSeenAt: now,
				lastSeenAt: now,
				direction,
				reasons: validation.reasons,
				prevHash,
				nextHash,
				lastNotifiedFingerprint,
				lastNoticeAt: lastNoticeAt ?? undefined,
				count: 1,
			},
		);
		this.host.setFrontmatterQuarantineEntries(updated);
		await this.host.persistPluginState();
	}

	private async readQuarantineEvidence(path: string): Promise<FrontmatterQuarantineEvidence> {
		try {
			return await this.host.getFrontmatterQuarantineEvidence?.(path) ?? {};
		} catch {
			return {};
		}
	}

	private quarantineState(
		previousContent: string | null,
		nextContent: string,
	): "whole-blocked" | "properties-held" {
		const previous = extractFrontmatter(previousContent ?? "");
		const next = extractFrontmatter(nextContent);
		return previous.kind !== "malformed" && next.kind !== "malformed"
			? "properties-held"
			: "whole-blocked";
	}

	async clearFrontmatterQuarantine(path: string, reason: string): Promise<void> {
		const current = this.host.getFrontmatterQuarantineEntries();
		if (current.length === 0) return;
		const next = clearFrontmatterQuarantinePath(current, path);
		if (next.length === current.length) return;
		this.host.setFrontmatterQuarantineEntries(next);
		this.host.trace("quarantine", "frontmatter-quarantine-cleared", {
			path,
			reason,
		});
		await this.host.persistPluginState();
	}

	private async resolveFrontmatterQuarantine(
		path: string,
		reason: string,
		currentContent: string,
	): Promise<void> {
		const current = this.host.getFrontmatterQuarantineEntries();
		if (!current.some((entry) => entry.path === path)) return;
		const [currentPropertiesHash, evidence] = await Promise.all([
			this.hashFrontmatterContent(currentContent),
			this.readQuarantineEvidence(path),
		]);
		const next = clearResolvedFrontmatterQuarantinePath(
			current,
			path,
			currentPropertiesHash,
			evidence.settlementAgreement,
		);
		if (next.length === current.length) {
			this.host.trace("quarantine", "frontmatter-properties-still-held", { path, reason });
			return;
		}
		this.host.setFrontmatterQuarantineEntries(next);
		this.host.trace("quarantine", "frontmatter-quarantine-cleared", { path, reason });
		await this.host.persistPluginState();
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private async hashFrontmatterContent(
		content: string | null,
	): Promise<string | undefined> {
		if (content == null) return undefined;
		const block = extractFrontmatter(content);
		if (block.kind !== "present") return undefined;
		return sha256TextHex(block.frontmatterText);
	}
}
