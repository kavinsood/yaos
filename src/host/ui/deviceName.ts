/**
 * Default human label for this device. Ported from the old client (adfa7a7:src/utils/defaultDeviceName.ts).
 * The parameter is structurally compatible with obsidian's `Platform` constant.
 */

export interface DevicePlatformFlags {
	readonly isAndroidApp?: boolean;
	readonly isIosApp?: boolean;
	readonly isPhone?: boolean;
	readonly isTablet?: boolean;
	readonly isMacOS?: boolean;
	readonly isWin?: boolean;
	readonly isLinux?: boolean;
	readonly isMobile?: boolean;
}

export function defaultDeviceName(platform: DevicePlatformFlags): string {
	if (platform.isAndroidApp) return platform.isTablet ? "Android tablet" : "Android";
	if (platform.isIosApp) return platform.isTablet ? "iPad" : "iPhone";
	if (platform.isMacOS) return "Mac";
	if (platform.isWin) return "Windows";
	if (platform.isLinux) return "Linux";
	if (platform.isMobile) return platform.isPhone ? "Phone" : "Mobile";
	return "Desktop";
}
