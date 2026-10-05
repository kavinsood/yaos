import * as Y from "yjs";

export function formatUnknown(value: unknown): string {
	if (value instanceof Error) {
		return value.message || value.name;
	}
	if (typeof value === "string") return value;
	if (
		typeof value === "number"
		|| typeof value === "boolean"
		|| typeof value === "bigint"
		|| typeof value === "symbol"
	) {
		return String(value);
	}
	if (value && typeof value === "object") {
		const maybeMessage = "message" in value ? value.message : undefined;
		if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
			return maybeMessage;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}
	return String(value);
}

export function yTextToString(value: Y.Text | null | undefined): string | null {
	return value ? value.toJSON() : null;
}
