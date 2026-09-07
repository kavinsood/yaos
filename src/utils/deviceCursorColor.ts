import { fnv1a32 } from "./fnv1a";

export interface DeviceCursorColor {
	color: string;
	colorLight: string;
}

const CURSOR_SATURATION_PCT = 72;
const CURSOR_LIGHTNESS_PCT = 52;
const SELECTION_ALPHA = 0.2;
const HUE_COUNT = 360;

/** Stable awareness colour derived from a server-owned identity seed. */
export function deviceCursorColor(identitySeed: string): DeviceCursorColor {
	const hue = fnv1a32(identitySeed) % HUE_COUNT;
	const base = `${hue}, ${CURSOR_SATURATION_PCT}%, ${CURSOR_LIGHTNESS_PCT}%`;
	return {
		color: `hsl(${base})`,
		colorLight: `hsla(${base}, ${SELECTION_ALPHA})`,
	};
}

export function awarenessCursorUser(deviceName: string, deviceId: string): {
	name: string; id: string; principalId: string; deviceId: string; deviceName: string; color: string; colorLight: string;
};
export function awarenessCursorUser(
	displayName: string,
	principalId: string,
	principalColorSeed: string,
	deviceName: string,
	deviceId: string,
): {
	name: string; id: string; principalId: string; deviceId: string; deviceName: string; color: string; colorLight: string;
};
export function awarenessCursorUser(
	displayName: string,
	principalId: string,
	principalColorSeed?: string,
	deviceName?: string,
	deviceId?: string,
): {
	name: string;
	id: string;
	principalId: string;
	deviceId: string;
	deviceName: string;
	color: string;
	colorLight: string;
} {
	const resolvedDeviceId = deviceId ?? principalId;
	const resolvedDeviceName = deviceName ?? displayName;
	const resolvedPrincipalId = deviceId ? principalId : resolvedDeviceId;
	return {
		name: displayName,
		id: resolvedDeviceId,
		principalId: resolvedPrincipalId,
		deviceId: resolvedDeviceId,
		deviceName: resolvedDeviceName,
		...deviceCursorColor(principalColorSeed ?? resolvedDeviceId),
	};
}
