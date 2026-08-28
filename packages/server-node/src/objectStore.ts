import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	type FileHandle,
	link,
	mkdir,
	open,
	opendir,
	rm,
	unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
	ObjectBody,
	ObjectListPage,
	ObjectMetadata,
	ObjectStorePort,
	ObjectWriteOptions,
} from "../../../server/src/platformPorts";

const MAGIC = Buffer.from("YAOSOBJ1", "ascii");
const PREFIX_BYTES = MAGIC.byteLength + 4;
const MAX_HEADER_BYTES = 64 * 1024;

export class ImmutableObjectConflictError extends Error {
	constructor(readonly key: string) {
		super(`immutable object already exists with different content or metadata: ${key}`);
		this.name = "ImmutableObjectConflictError";
	}
}

interface StoredHeader {
	readonly format: 1;
	readonly key: string;
	readonly size: number;
	readonly sha256: string;
	readonly uploadedAt: number;
	readonly contentType: string | null;
	readonly customMetadata: Record<string, string>;
}

export interface FilesystemObjectStoreOperations {
	open(path: string, flags: string, mode?: number): Promise<FileHandle>;
	link(existingPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	remove(path: string): Promise<void>;
}

const DEFAULT_OPERATIONS: FilesystemObjectStoreOperations = {
	open,
	link,
	unlink,
	remove: async (path) => await rm(path, { force: true }),
};

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateKey(key: string): string[] {
	if (!key || key.startsWith("/") || key.endsWith("/") || key.includes("\\") || hasControlCharacter(key)) {
		throw new Error("invalid object key");
	}
	const segments = key.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error("invalid object key");
	}
	return segments;
}

function canonicalCustomMetadata(metadata: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const canonical: Record<string, string> = {};
	for (const key of Object.keys(metadata ?? {}).sort()) {
		const value = metadata?.[key];
		if (typeof value !== "string" || hasControlCharacter(key) || hasControlCharacter(value)) {
			throw new Error("invalid object custom metadata");
		}
		canonical[key] = value;
	}
	return canonical;
}

async function writeAll(file: FileHandle, bytes: Uint8Array, start: number): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await file.write(bytes, offset, bytes.byteLength - offset, start + offset);
		if (result.bytesWritten === 0) throw new Error("object write made no progress");
		offset += result.bytesWritten;
	}
}

async function readExactly(file: FileHandle, bytes: Uint8Array, start: number): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await file.read(bytes, offset, bytes.byteLength - offset, start + offset);
		if (result.bytesRead === 0) throw new Error("truncated filesystem object");
		offset += result.bytesRead;
	}
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function objectMetadata(header: StoredHeader): ObjectMetadata {
	return {
		key: header.key,
		size: header.size,
		uploadedAt: header.uploadedAt,
		contentType: header.contentType,
		customMetadata: header.customMetadata,
	};
}

/** Immutable filesystem objects published with fsync + atomic hard-link. */
export class FilesystemObjectStore implements ObjectStorePort {
	readonly root: string;
	private readonly operations: FilesystemObjectStoreOperations;

	constructor(root: string, operations: Partial<FilesystemObjectStoreOperations> = {}) {
		this.root = resolve(root);
		this.operations = { ...DEFAULT_OPERATIONS, ...operations };
	}

	async initialize(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		const location = this.location(key);
		try {
			const { header } = await this.readHeader(location, key);
			return objectMetadata(header);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async get(key: string): Promise<ObjectBody | null> {
		const location = this.location(key);
		try {
			const { header, bodyOffset } = await this.readHeader(location, key);
			const file = await this.operations.open(location, "r");
			try {
				const bytes = new Uint8Array(header.size);
				await readExactly(file, bytes, bodyOffset);
				const digest = createHash("sha256").update(bytes).digest("hex");
				if (digest !== header.sha256) throw new Error(`filesystem object checksum mismatch: ${key}`);
				return { ...objectMetadata(header), bytes };
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async put(key: string, bytes: Uint8Array, options: ObjectWriteOptions = {}): Promise<void> {
		await this.publish(key, bytes, options);
	}

	async createOnly(
		key: string,
		bytes: Uint8Array,
		options: ObjectWriteOptions = {},
	): Promise<"created" | "exists"> {
		return await this.publish(key, bytes, options);
	}

	async delete(key: string): Promise<void> {
		const location = this.location(key);
		try {
			await this.operations.unlink(location);
			await fsyncDirectory(dirname(location));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async list(input: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListPage> {
		const limit = input.limit ?? 1_000;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
			throw new RangeError("object list limit must be between 1 and 10000");
		}
		const keys: string[] = [];
		await this.collectKeys(this.root, keys);
		keys.sort();
		const selected = keys.filter((key) => key.startsWith(input.prefix) && (input.cursor === undefined || key > input.cursor));
		const pageKeys = selected.slice(0, limit);
		const objects: ObjectMetadata[] = [];
		for (const key of pageKeys) {
			const object = await this.head(key);
			if (object) objects.push(object);
		}
		const truncated = selected.length > pageKeys.length;
		return {
			objects,
			truncated,
			cursor: truncated && pageKeys.length > 0 ? pageKeys[pageKeys.length - 1]! : null,
		};
	}

	private async publish(
		key: string,
		bytes: Uint8Array,
		options: ObjectWriteOptions,
	): Promise<"created" | "exists"> {
		const location = this.location(key);
		const directory = dirname(location);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const header: StoredHeader = {
			format: 1,
			key,
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			uploadedAt: Date.now(),
			contentType: options.contentType ?? null,
			customMetadata: canonicalCustomMetadata(options.customMetadata),
		};
		const encodedHeader = Buffer.from(JSON.stringify(header));
		if (encodedHeader.byteLength > MAX_HEADER_BYTES) throw new Error("object metadata is too large");
		const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
		MAGIC.copy(prefix, 0);
		prefix.writeUInt32BE(encodedHeader.byteLength, MAGIC.byteLength);
		const temporary = join(directory, `.yaos-tmp-${process.pid}-${randomUUID()}`);
		try {
			const file = await this.operations.open(temporary, "wx", 0o600);
			try {
				await writeAll(file, prefix, 0);
				await writeAll(file, encodedHeader, PREFIX_BYTES);
				await writeAll(file, bytes, PREFIX_BYTES + encodedHeader.byteLength);
				await file.sync();
			} finally {
				await file.close();
			}
			try {
				await this.operations.link(temporary, location);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await this.validateWinner(location, header, bytes);
				return "exists";
			}
			await fsyncDirectory(directory);
			return "created";
		} finally {
			await this.operations.remove(temporary);
			await fsyncDirectory(directory);
		}
	}

	private async validateWinner(location: string, expected: StoredHeader, expectedBytes: Uint8Array): Promise<void> {
		const { header, bodyOffset } = await this.readHeader(location, expected.key);
		const sameMetadata = header.size === expected.size
			&& header.sha256 === expected.sha256
			&& header.contentType === expected.contentType
			&& JSON.stringify(header.customMetadata) === JSON.stringify(expected.customMetadata);
		if (!sameMetadata) throw new ImmutableObjectConflictError(expected.key);
		const file = await this.operations.open(location, "r");
		try {
			const winner = new Uint8Array(header.size);
			await readExactly(file, winner, bodyOffset);
			if (!timingSafeEqual(winner, expectedBytes)) throw new ImmutableObjectConflictError(expected.key);
		} finally {
			await file.close();
		}
	}

	private async readHeader(location: string, expectedKey: string): Promise<{ header: StoredHeader; bodyOffset: number }> {
		const file = await this.operations.open(location, "r");
		try {
			const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
			await readExactly(file, prefix, 0);
			if (!timingSafeEqual(prefix.subarray(0, MAGIC.byteLength), MAGIC)) {
				throw new Error(`invalid filesystem object: ${expectedKey}`);
			}
			const headerLength = prefix.readUInt32BE(MAGIC.byteLength);
			if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
				throw new Error(`invalid filesystem object header: ${expectedKey}`);
			}
			const headerBytes = Buffer.allocUnsafe(headerLength);
			await readExactly(file, headerBytes, PREFIX_BYTES);
			const parsed: unknown = JSON.parse(headerBytes.toString("utf8"));
			if (!parsed || typeof parsed !== "object") throw new Error(`invalid filesystem object header: ${expectedKey}`);
			const header = parsed as StoredHeader;
			if (header.format !== 1 || header.key !== expectedKey || !Number.isSafeInteger(header.size) || header.size < 0
				|| !/^[a-f0-9]{64}$/.test(header.sha256) || !Number.isSafeInteger(header.uploadedAt)
				|| (header.contentType !== null && typeof header.contentType !== "string")
				|| !header.customMetadata || typeof header.customMetadata !== "object") {
				throw new Error(`invalid filesystem object header: ${expectedKey}`);
			}
			const fileStat = await file.stat();
			const bodyOffset = PREFIX_BYTES + headerLength;
			if (fileStat.size !== bodyOffset + header.size) throw new Error(`invalid filesystem object size: ${expectedKey}`);
			return { header, bodyOffset };
		} finally {
			await file.close();
		}
	}

	private location(key: string): string {
		const location = resolve(this.root, ...validateKey(key));
		if (location === this.root || !location.startsWith(`${this.root}${sep}`)) {
			throw new Error("object key escaped storage root");
		}
		return location;
	}

	private async collectKeys(directory: string, keys: string[]): Promise<void> {
		let handle;
		try {
			handle = await opendir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for await (const entry of handle) {
			if (entry.name.startsWith(".yaos-tmp-")) continue;
			const location = join(directory, entry.name);
			if (entry.isDirectory()) await this.collectKeys(location, keys);
			else if (entry.isFile()) keys.push(relative(this.root, location).split(sep).join("/"));
		}
	}
}
