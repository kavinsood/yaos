import { fnv1a32 } from "./fnv1a";

export interface DeviceCursorColor {
	color: string;
	colorLight: string;
}

const CURSOR_SATURATION_PCT = 72;
const CURSOR_LIGHTNESS_PCT = 52;
const SELECTION_ALPHA = 0.2;
const HUE_COUNT = 360;

/** Stable awareness colour derived from the server-minted device id. */
export function deviceCursorColor(deviceId: string): DeviceCursorColor {
	const hue = fnv1a32(deviceId) % HUE_COUNT;
	const base = `${hue}, ${CURSOR_SATURATION_PCT}%, ${CURSOR_LIGHTNESS_PCT}%`;
	return {
		color: `hsl(${base})`,
		colorLight: `hsla(${base}, ${SELECTION_ALPHA})`,
	};
}

export function awarenessCursorUser(deviceName: string, deviceId: string): {
	name: string;
	id: string;
	color: string;
	colorLight: string;
} {
	return {
		name: deviceName,
		id: deviceId,
		...deviceCursorColor(deviceId),
	};
}
