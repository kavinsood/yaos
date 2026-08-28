import { randomBytes } from "node:crypto";
import os from "node:os";

import type { EnrollmentConfig } from "./config";
import {
	ENROLLMENT_FORMAT,
	type EnrollmentMembership,
	type EnrollmentState,
	type PendingEnrollment,
	type StatePaths,
	folderKeyFor,
	readEnrollmentState,
	updateEnrollmentState,
	validateStateIdentity,
	writeEnrollmentState,
} from "./state";

const MAX_ENROLLMENT_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_KEYS = [
	"deviceId",
	"deviceName",
	"deviceToken",
	"host",
	"originImport",
	"vaultGeneration",
	"vaultId",
] as const;

export class EnrollmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnrollmentError";
	}
}

function randomId(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function initialState(realVaultPath: string, host: string): EnrollmentState {
	return {
		format: ENROLLMENT_FORMAT,
		realVaultPath,
		folderKey: folderKeyFor(realVaultPath),
		host,
		pending: null,
		membership: null,
		provisioningProof: null,
	};
}

function newPending(config: EnrollmentConfig): PendingEnrollment {
	return {
		host: config.host,
		pairingCode: config.pairingCode,
		enrollmentRequestId: randomId(22),
		deviceId: randomId(22),
		deviceToken: randomId(32),
		deviceName: `${os.hostname()}-headless`.slice(0, 80),
		createdAt: Date.now(),
	};
}

function requiredBoundedString(value: unknown, field: string, maximum = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new EnrollmentError(`Enrollment response has invalid ${field}`);
	}
	return value;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_ENROLLMENT_RESPONSE_BYTES) {
		throw new EnrollmentError("Enrollment response exceeded 64 KiB");
	}
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const reader = response.body?.getReader();
	if (reader) {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			byteLength += part.value.byteLength;
			if (byteLength > MAX_ENROLLMENT_RESPONSE_BYTES) {
				await reader.cancel();
				throw new EnrollmentError("Enrollment response exceeded 64 KiB");
			}
			chunks.push(part.value);
		}
	}
	let bytes: Uint8Array;
	if (chunks.length === 1) {
		bytes = chunks[0]!;
	} else {
		bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new EnrollmentError(`Enrollment response was not valid UTF-8 JSON: ${String(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new EnrollmentError("Enrollment response was not an object");
	}
	return value as Record<string, unknown>;
}

function exactMembership(payload: Record<string, unknown>, pending: PendingEnrollment): EnrollmentMembership {
	const keys = Object.keys(payload).sort();
	if (keys.length !== RESPONSE_KEYS.length || keys.some((key, index) => key !== RESPONSE_KEYS[index])) {
		throw new EnrollmentError("Enrollment response fields did not match the schema-4 contract");
	}
	const host = requiredBoundedString(payload.host, "host");
	if (host !== pending.host) throw new EnrollmentError("Enrollment response host does not match YAOS_HOST");
	if (payload.deviceId !== pending.deviceId || payload.deviceToken !== pending.deviceToken) {
		throw new EnrollmentError("Enrollment response did not echo the durable device identity");
	}
	if (typeof payload.originImport !== "boolean") {
		throw new EnrollmentError("Enrollment response has invalid originImport authority");
	}
	return {
		host,
		vaultId: requiredBoundedString(payload.vaultId, "vaultId", 128),
		vaultGeneration: requiredBoundedString(payload.vaultGeneration, "vaultGeneration", 128),
		deviceId: pending.deviceId,
		deviceToken: pending.deviceToken,
		deviceName: requiredBoundedString(payload.deviceName, "deviceName", 80),
		originImport: payload.originImport,
		originImportPending: payload.originImport,
	};
}

/** Persist a replay-stable device request before the first network byte is sent. */
export async function enrollDevice(
	config: EnrollmentConfig,
	realVaultPath: string,
	paths: StatePaths,
	fetchImpl: typeof fetch = fetch,
): Promise<EnrollmentMembership> {
	let state = await readEnrollmentState(paths) ?? initialState(realVaultPath, config.host);
	validateStateIdentity(state, realVaultPath, config.host);
	if (state.membership) {
		throw new EnrollmentError(`This vault path is already enrolled as device ${state.membership.deviceId}`);
	}

	let pending = state.pending;
	if (pending) {
		if (pending.host !== config.host || pending.pairingCode !== config.pairingCode) {
			throw new EnrollmentError("A different enrollment request is already pending; retry with its original host and pairing code");
		}
	} else {
		pending = newPending(config);
		state = updateEnrollmentState(state, { pending });
		await writeEnrollmentState(paths, state);
	}

	let response: Response;
	try {
		response = await fetchImpl(`${pending.host}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pairingCode: pending.pairingCode,
				enrollmentRequestId: pending.enrollmentRequestId,
				deviceId: pending.deviceId,
				deviceToken: pending.deviceToken,
				deviceName: pending.deviceName,
			}),
		});
	} catch (error) {
		throw new EnrollmentError(`Enrollment request failed; the durable request can be retried: ${String(error)}`);
	}
	const payload = await readBoundedJson(response);
	if (response.status !== 200) {
		const message = typeof payload.message === "string"
			? payload.message
			: typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
		throw new EnrollmentError(`Enrollment failed; the durable request was retained: ${message}`);
	}
	const membership = exactMembership(payload, pending);
	state = updateEnrollmentState(state, { membership, pending: null, provisioningProof: null });
	await writeEnrollmentState(paths, state);
	return membership;
}
