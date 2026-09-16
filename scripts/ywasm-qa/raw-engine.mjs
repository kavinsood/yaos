import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadYwasm() {
	const requested = process.env.YAOS_YWASM_MODULE;
	if (!requested) return import("ywasm");
	const specifier = requested.startsWith("file:") || !isAbsolute(requested)
		? requested
		: pathToFileURL(resolve(requested)).href;
	return import(specifier);
}

export function destroyWasm(doc, ...children) {
	for (const child of children.reverse()) child?.free?.();
	doc.destroy(undefined);
	doc.free();
}

export function modelBoundaries(value) {
	const result = [0];
	let offset = 0;
	for (const symbol of value) {
		offset += symbol.length;
		result.push(offset);
	}
	return result;
}

export function seededRandom(seed) {
	let state = seed >>> 0 || 0x9e37_79b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

export function parsePositiveInteger(value, label, defaultValue) {
	const parsed = value === undefined ? defaultValue : Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
	return parsed;
}
