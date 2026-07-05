const DO_QUOTA_BYTES = 1024 * 1024 * 1024;

export function formatAttachmentStorageStatus(
	status: { usedBytes: number; blobCount: number },
	backend: "r2" | "do" | null | undefined,
): string | null {
	if (backend !== "do") return null;
	const usedMb = Math.round(status.usedBytes / (1024 * 1024));
	const quotaMb = Math.round(DO_QUOTA_BYTES / (1024 * 1024));
	return `${usedMb} / ${quotaMb} MB used · ${status.blobCount} attachment(s)`;
}
