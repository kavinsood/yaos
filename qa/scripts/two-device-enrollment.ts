import { randomBytes } from "node:crypto";

export interface QaDeviceEnrollment {
	host: string;
	deviceToken: string;
	vaultId: string;
	deviceId: string;
	vaultGeneration: string;
	originImport: boolean;
	deviceName: string;
}

export interface TwoDeviceEnrollmentInput {
	host: string;
	initialPairingCode: string;
	deviceNameA: string;
	deviceNameB: string;
}

export interface TwoDeviceEnrollments {
	deviceA: QaDeviceEnrollment;
	deviceB: QaDeviceEnrollment;
}

function normalizeHost(host: string): string {
	const parsed = new URL(host.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Server URL must use http or https.");
	}
	parsed.pathname = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/$/, "");
}

function isEnrollment(value: unknown): value is QaDeviceEnrollment {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const expected = ["deviceId", "deviceName", "deviceToken", "host", "originImport", "vaultGeneration", "vaultId"];
	const stringKeys = ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"];
	const keys = Object.keys(record).sort();
	return keys.length === expected.length
		&& keys.every((key, index) => key === expected[index])
		&& stringKeys.every((key) => typeof record[key] === "string" && record[key].trim().length > 0)
		&& typeof record.originImport === "boolean";
}

async function enrollDevice(
	host: string,
	pairingCode: string,
	deviceName: string,
	fetchImpl: typeof fetch,
): Promise<QaDeviceEnrollment> {
	const enrollmentRequestId = randomBytes(16).toString("base64url");
	const deviceId = randomBytes(16).toString("base64url");
	const deviceToken = randomBytes(32).toString("base64url");
	const response = await fetchImpl(`${host}/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode, enrollmentRequestId, deviceId, deviceToken, deviceName }),
	});
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok || !isEnrollment(body)) {
		throw new Error(`Enrollment failed for ${deviceName} (HTTP ${response.status}).`);
	}
	if (normalizeHost(body.host) !== host) {
		throw new Error(`Enrollment host mismatch for ${deviceName}.`);
	}
	return { ...body, host };
}

export async function enrollTwoQaDevices(
	input: TwoDeviceEnrollmentInput,
	fetchImpl: typeof fetch = fetch,
): Promise<TwoDeviceEnrollments> {
	const host = normalizeHost(input.host);
	const deviceA = await enrollDevice(
		host,
		input.initialPairingCode.trim(),
		input.deviceNameA.trim(),
		fetchImpl,
	);
	const pairingResponse = await fetchImpl(
		`${host}/vault/${encodeURIComponent(deviceA.vaultId)}/auth/pairing-code`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${deviceA.deviceToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ purpose: "device" }),
		},
	);
	const pairingBody: unknown = await pairingResponse.json().catch(() => null);
	const secondCode = pairingBody && typeof pairingBody === "object" && "pairingCode" in pairingBody
		&& typeof pairingBody.pairingCode === "string"
		? pairingBody.pairingCode
		: "";
	if (!pairingResponse.ok || !secondCode) {
		throw new Error(`Could not mint the second QA pairing code (HTTP ${pairingResponse.status}).`);
	}
	const deviceB = await enrollDevice(
		host,
		secondCode,
		input.deviceNameB.trim(),
		fetchImpl,
	);
	if (deviceB.vaultId !== deviceA.vaultId) {
		throw new Error("Two-device enrollment returned different vault IDs.");
	}
	if (deviceB.deviceId === deviceA.deviceId) {
		throw new Error("Two-device enrollment returned duplicate device IDs.");
	}
	return { deviceA, deviceB };
}

function parseCliArgs(args: readonly string[]): TwoDeviceEnrollmentInput {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "end of input"}.`);
		values.set(key, value);
	}
	const read = (key: string): string => {
		const value = values.get(key)?.trim();
		if (!value) throw new Error(`${key} is required.`);
		return value;
	};
	return {
		host: read("--host"),
		initialPairingCode: read("--pairing-code"),
		deviceNameA: read("--device-a-name"),
		deviceNameB: read("--device-b-name"),
	};
}

const moduleMeta = import.meta as ImportMeta & { readonly main?: boolean };
if (moduleMeta.main) {
	const enrollments = await enrollTwoQaDevices(parseCliArgs(process.argv.slice(2)));
	console.log(JSON.stringify(enrollments, null, 2));
}
