export type HostMethodListener = (args: readonly unknown[], result: unknown) => void | Promise<void>;

export type HostPatchRelease = () => void;

type Patch = {
	original: (...args: unknown[]) => unknown;
	wrapper: (...args: unknown[]) => unknown;
	listeners: Set<HostMethodListener>;
	originalDescriptor: PropertyDescriptor | undefined;
};

/**
 * Owns small, reversible host method observations. It deliberately patches
 * only methods YAOS needs and leaves a method alone if another plugin replaces
 * our wrapper before the final observer is released.
 */
export class HostPatchRegistry {
	private readonly patches = new WeakMap<object, Map<string, Patch>>();

	observe(target: object, method: string, listener: HostMethodListener): HostPatchRelease {
		const record = target as Record<string, unknown>;
		let targetPatches = this.patches.get(target);
		if (!targetPatches) {
			targetPatches = new Map();
			this.patches.set(target, targetPatches);
		}
		let patch = targetPatches.get(method);
		if (!patch) {
			const originalDescriptor = Object.getOwnPropertyDescriptor(target, method);
			if (originalDescriptor && (originalDescriptor.get || originalDescriptor.set || originalDescriptor.writable === false)) {
				return () => undefined;
			}
			const original = record[method];
			if (typeof original !== "function") return () => undefined;
			const originalMethod = original as (...args: unknown[]) => unknown;
			const listeners = new Set<HostMethodListener>();
			const notify = (args: readonly unknown[], result: unknown) => {
				for (const currentListener of listeners) {
					try {
						void Promise.resolve(currentListener(args, result)).catch(() => undefined);
					} catch {
						// An observer must never change the host operation's outcome.
					}
				}
			};
			const wrapper = function (this: object, ...args: unknown[]): unknown {
				const result = originalMethod.apply(this, args);
				if (isThenable(result)) {
					return Promise.resolve(result).then((value: unknown) => {
						notify(args, value);
						return value;
					});
				}
				notify(args, result);
				return result;
			};
			patch = { original: originalMethod, wrapper, listeners, originalDescriptor };
			targetPatches.set(method, patch);
			Object.defineProperty(target, method, {
				value: wrapper,
				writable: true,
				enumerable: originalDescriptor?.enumerable ?? true,
				configurable: true,
			});
		}
		const activePatch = patch;
		activePatch.listeners.add(listener);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			activePatch.listeners.delete(listener);
			if (activePatch.listeners.size > 0) return;
			if (record[method] === activePatch.wrapper) {
				if (activePatch.originalDescriptor) Object.defineProperty(target, method, activePatch.originalDescriptor);
				else Reflect.deleteProperty(target, method);
			}
			targetPatches.delete(method);
			if (targetPatches.size === 0) this.patches.delete(target);
		};
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null
		&& "then" in value && typeof (value as { then?: unknown }).then === "function";
}
