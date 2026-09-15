import { decideExcalidrawElement } from "@shared/excalidrawProtocol";
import { validateExcalidrawElement } from "./canonical";
import type { ExcalidrawElementRecord } from "./types";

export class ExcalidrawRevisionEquivocationError extends Error {
	constructor(readonly elementId: string) {
		super(`Excalidraw element ${elementId} has different content at one native revision`);
		this.name = "ExcalidrawRevisionEquivocationError";
	}
}

export type ExcalidrawWinner = "current" | "candidate" | "duplicate";

/** Durable subset of pinned upstream reconciliation: higher version, then lower nonce. */
export function selectExcalidrawWinner(current: ExcalidrawElementRecord, candidate: ExcalidrawElementRecord): ExcalidrawWinner {
	if (candidate.id !== current.id) throw new Error("Cannot reconcile different Excalidraw element IDs");
	const decision = decideExcalidrawElement(candidate, current);
	if (decision === "incoming") return "candidate";
	if (decision === "current") return "current";
	if (decision === "equal") return "duplicate";
	throw new ExcalidrawRevisionEquivocationError(current.id);
}

export function reconcileExcalidrawElements(current: readonly ExcalidrawElementRecord[],
	candidates: readonly ExcalidrawElementRecord[]): ExcalidrawElementRecord[] {
	const records = new Map(current.map((value) => {
		const element = validateExcalidrawElement(value);
		return [element.id, element] as const;
	}));
	for (const value of candidates) {
		const candidate = validateExcalidrawElement(value);
		const existing = records.get(candidate.id);
		if (!existing || selectExcalidrawWinner(existing, candidate) === "candidate") records.set(candidate.id, candidate);
	}
	return [...records.values()].sort(compareElementOrder);
}

/** Directly-coupled records travel in the same semantic operation even when only one revision changed. */
export function expandExcalidrawDependencyClosure(scene: readonly ExcalidrawElementRecord[],
	changed: readonly ExcalidrawElementRecord[]): ExcalidrawElementRecord[] {
	const records = new Map(scene.map((element) => [element.id, element] as const));
	const adjacent = new Map<string, Set<string>>();
	const groups = new Map<string, string[]>();
	const link = (left: string, right: string) => {
		if (!records.has(left) || !records.has(right) || left === right) return;
		let leftSet = adjacent.get(left); if (!leftSet) { leftSet = new Set(); adjacent.set(left, leftSet); }
		let rightSet = adjacent.get(right); if (!rightSet) { rightSet = new Set(); adjacent.set(right, rightSet); }
		leftSet.add(right); rightSet.add(left);
	};
	for (const element of scene) {
		for (const key of ["containerId", "frameId"] as const) {
			const target = element[key]; if (typeof target === "string") link(element.id, target);
		}
		for (const key of ["startBinding", "endBinding"] as const) {
			const binding = element[key];
			if (binding && typeof binding === "object" && typeof (binding as { elementId?: unknown }).elementId === "string") {
				link(element.id, (binding as { elementId: string }).elementId);
			}
		}
		if (Array.isArray(element.boundElements)) for (const binding of element.boundElements) {
			if (binding && typeof binding === "object" && typeof (binding as { id?: unknown }).id === "string") {
				link(element.id, (binding as { id: string }).id);
			}
		}
		if (Array.isArray(element.groupIds)) for (const groupId of element.groupIds) if (typeof groupId === "string") {
			const members = groups.get(groupId) ?? []; members.push(element.id); groups.set(groupId, members);
		}
	}
	for (const members of groups.values()) for (let index = 1; index < members.length; index++) link(members[0]!, members[index]!);
	const included = new Set(changed.map((element) => element.id));
	const queue = [...included];
	for (let index = 0; index < queue.length; index++) for (const neighbor of adjacent.get(queue[index]!) ?? []) {
		if (!included.has(neighbor)) { included.add(neighbor); queue.push(neighbor); }
	}
	return scene.filter((element) => included.has(element.id));
}

function compareElementOrder(left: ExcalidrawElementRecord, right: ExcalidrawElementRecord): number {
	const leftIndex = typeof left.index === "string" ? left.index : "";
	const rightIndex = typeof right.index === "string" ? right.index : "";
	if (leftIndex !== rightIndex) return leftIndex < rightIndex ? -1 : 1;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}
