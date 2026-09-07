import * as Y from "yjs";
import { splitMarkdownComponents } from "./frontmatterBoundary";
import { projectFrontmatterSemantics } from "./frontmatterProjection";
import {
	FRONTMATTER_META_ROOT,
	FRONTMATTER_ORDERED_ROOT_PREFIX,
	FRONTMATTER_PRESENCE_ROOT,
	FRONTMATTER_REGISTERS_ROOT,
	FRONTMATTER_SET_ADDS_ROOT,
	FRONTMATTER_SET_REMOVES_ROOT,
	applyFrontmatterSemanticTransition,
	readFrontmatterSemanticSnapshot,
} from "./frontmatterSemanticModel";

export const ORIGIN_FRONTMATTER_SEMANTIC_PROJECTION = "frontmatter-semantic-projection";

export interface FrontmatterSemanticMirrorOptions {
	textName?: string;
	createToken?: () => string;
	onOpaque?: (reason: string) => void;
	onProjected?: (changedFields: string[]) => void;
}

/** Keeps known property CRDTs and their Markdown projection convergent. */
export class FrontmatterSemanticMirror {
	private readonly text: Y.Text;
	private readonly previousText = new WeakMap<Y.Transaction, string>();
	private readonly semanticTransactions = new WeakSet<Y.Transaction>();
	private readonly unobserve: Array<() => void> = [];
	private projectionQueued = false;
	private destroyed = false;

	constructor(
		private readonly doc: Y.Doc,
		private readonly options: FrontmatterSemanticMirrorOptions = {},
	) {
		this.text = doc.getText(options.textName ?? "body");
		const beforeTransaction = (transaction: Y.Transaction) => {
			this.previousText.set(transaction, this.text.toJSON());
		};
		const onText = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.origin === ORIGIN_FRONTMATTER_SEMANTIC_PROJECTION) return;
			const outcome = applyFrontmatterSemanticTransition(
				this.doc,
				this.previousText.get(transaction) ?? this.text.toJSON(),
				this.text.toJSON(),
				this.options.createToken,
			);
			if (outcome.kind === "opaque") this.options.onOpaque?.(outcome.reason);
		};
		const afterTransaction = (transaction: Y.Transaction) => {
			if (this.semanticTransactions.has(transaction)) this.queueProjection();
		};
		this.doc.on("beforeTransaction", beforeTransaction);
		this.doc.on("afterTransaction", afterTransaction);
		this.text.observe(onText);
		this.unobserve.push(
			() => this.doc.off("beforeTransaction", beforeTransaction),
			() => this.doc.off("afterTransaction", afterTransaction),
			() => this.text.unobserve(onText),
		);

		for (const name of [
			FRONTMATTER_META_ROOT,
			FRONTMATTER_REGISTERS_ROOT,
			FRONTMATTER_PRESENCE_ROOT,
			FRONTMATTER_SET_ADDS_ROOT,
			FRONTMATTER_SET_REMOVES_ROOT,
		]) {
			const map = this.doc.getMap(name);
			const observer = (_event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
				this.semanticTransactions.add(transaction);
			};
			map.observe(observer);
			this.unobserve.push(() => map.unobserve(observer));
		}
		for (const field of ["aliases"]) {
			const list = this.doc.getArray(`${FRONTMATTER_ORDERED_ROOT_PREFIX}${field}`);
			const observer = (_event: Y.YArrayEvent<unknown>, transaction: Y.Transaction) => {
				this.semanticTransactions.add(transaction);
			};
			list.observe(observer);
			this.unobserve.push(() => list.unobserve(observer));
		}
	}

	/** Seed a newly-created body before its provider is attached. */
	seedCurrent(): boolean {
		if (this.destroyed || readFrontmatterSemanticSnapshot(this.doc)) return false;
		let applied = false;
		this.doc.transact(() => {
				const content = this.text.toJSON();
			const outcome = applyFrontmatterSemanticTransition(
				this.doc,
				content,
				content,
				this.options.createToken,
			);
			applied = outcome.kind === "applied";
			if (outcome.kind === "opaque") this.options.onOpaque?.(outcome.reason);
		}, this);
		return applied;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const stop of this.unobserve.splice(0)) stop();
	}

	private queueProjection(): void {
		if (this.destroyed || this.projectionQueued) return;
		this.projectionQueued = true;
		queueMicrotask(() => {
			this.projectionQueued = false;
			if (!this.destroyed) this.project();
		});
	}

	private project(): void {
		const snapshot = readFrontmatterSemanticSnapshot(this.doc);
		if (!snapshot) return;
		const current = this.text.toJSON();
		const projected = projectFrontmatterSemantics(current, snapshot);
		if (projected.kind === "opaque") {
			this.options.onOpaque?.(projected.reason);
			return;
		}
		if (projected.kind === "unchanged") return;
		const before = splitMarkdownComponents(current);
		const after = splitMarkdownComponents(projected.content);
		if (before.kind === "ambiguous" || after.kind === "ambiguous" || before.body !== after.body) {
			this.options.onOpaque?.("projection-boundary-changed");
			return;
		}
		this.doc.transact(() => {
			if (before.bodyOffset > 0) this.text.delete(0, before.bodyOffset);
			if (after.propertiesRegion.length > 0) this.text.insert(0, after.propertiesRegion);
		}, ORIGIN_FRONTMATTER_SEMANTIC_PROJECTION);
		this.options.onProjected?.(projected.changedFields);
	}
}
