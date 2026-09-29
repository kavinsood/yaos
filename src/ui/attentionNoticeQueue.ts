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
