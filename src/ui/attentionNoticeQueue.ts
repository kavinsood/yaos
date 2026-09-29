export function createConflictAttentionNotice(document: Document, count: number, review: () => void): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const content = document.createElement("div");
	content.className = "yaos-attention-notice";
	const message = document.createElement("div");
	message.className = "yaos-attention-notice-message";
	message.textContent = `${count} note${count === 1 ? " needs" : "s need"} a conflict decision.`;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "yaos-attention-notice-action";
	button.textContent = "Review YAOS conflicts";
	button.addEventListener("click", review);
	content.appendChild(message);
	content.appendChild(button);
	fragment.appendChild(content);
	return fragment;
}

export class AttentionNoticeQueue {
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deliver: (keys: string[]) => void | Promise<void>) {}

	add(key: string): void {
		this.pending.add(key);
		if (this.timer === null) this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 250);
	}

	async flush(): Promise<void> {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		const keys = [...this.pending];
		this.pending.clear();
		if (keys.length) await this.deliver(keys);
	}

	dispose(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.pending.clear();
	}
}
