function parseSemver(version: string): number[] | null {
	const normalized = version.trim();
	if (!/^\d+(\.\d+){0,2}$/.test(normalized)) {
		return null;
	}
	return normalized.split(".").map((part) => Number(part));
}

export function compareSemver(left: string, right: string): number | null {
	const leftParts = parseSemver(left);
	const rightParts = parseSemver(right);
	if (!leftParts || !rightParts) return null;
	const maxLength = Math.max(leftParts.length, rightParts.length);
	for (let i = 0; i < maxLength; i++) {
		const leftValue = leftParts[i] ?? 0;
		const rightValue = rightParts[i] ?? 0;
		if (leftValue < rightValue) return -1;
		if (leftValue > rightValue) return 1;
	}
	return 0;
}
