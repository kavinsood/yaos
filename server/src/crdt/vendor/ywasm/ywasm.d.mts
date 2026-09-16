export class YTransaction {
	free(): void;
}

export class YText {
	free(): void;
	toString(txn: YTransaction | undefined): string;
	insert(index: number, value: string, attributes: undefined, txn: YTransaction | undefined): void;
	delete(index: number, length: number, txn: YTransaction | undefined): void;
}

export class YArray {
	constructor(initial?: unknown[] | null);
	free(): void;
	get(index: number, txn: YTransaction | undefined): unknown;
	length(txn: YTransaction | undefined): number;
	delete(index: number, length: number, txn: YTransaction | undefined): void;
	insert(index: number, values: unknown[], txn: YTransaction | undefined): void;
}

export class YMap {
	constructor(initial?: object | null);
	free(): void;
	entries(txn: YTransaction | undefined): Iterable<[string, unknown]>;
	get(key: string, txn: YTransaction | undefined): unknown;
	set(key: string, value: unknown, txn: YTransaction | undefined): void;
	delete(key: string, txn: YTransaction | undefined): void;
}

export class YDoc {
	constructor(options: { readonly guid: string });
	readonly guid: string;
	free(): void;
	destroy(parentTransaction: undefined): void;
	getText(name: string): YText;
	getArray(name: string): YArray;
	getMap(name: string): YMap;
	roots(txn: YTransaction | undefined): Array<[string, unknown]>;
	beginTransaction(origin: unknown): YTransaction;
	documentStats(): { readonly totalStructs: number; readonly deletedStructs: number };
}

export function applyUpdate(doc: YDoc, update: Uint8Array, origin: unknown): void;
export function applyUpdateAndCheckIfChanged(doc: YDoc, update: Uint8Array, origin: unknown): boolean;
export function encodeStateVector(doc: YDoc): Uint8Array;
export function encodeStateAsUpdate(doc: YDoc, vector?: Uint8Array | null): Uint8Array;
export function mergeUpdatesV1(updates: Array<Uint8Array>): Uint8Array;
export function wasmMemoryByteLength(): number;
