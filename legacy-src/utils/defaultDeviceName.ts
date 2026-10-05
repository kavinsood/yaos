export interface DevicePlatform {
	isAndroidApp: boolean;
	isIosApp: boolean;
	isPhone: boolean;
	isTablet: boolean;
	isMacOS: boolean;
	isWin: boolean;
	isLinux: boolean;
	isMobile: boolean;
}

export function defaultDeviceName(platform: DevicePlatform): string {
	if (platform.isAndroidApp) return platform.isTablet ? "Android tablet" : "Android";
	if (platform.isIosApp) return platform.isTablet ? "iPad" : "iPhone";
	if (platform.isMacOS) return "Mac";
	if (platform.isWin) return "Windows";
	if (platform.isLinux) return "Linux";
	if (platform.isMobile) return platform.isPhone ? "Phone" : "Mobile";
	return "Desktop";
}
