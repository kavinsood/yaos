import { formatAttachmentStorageStatus } from "../src/settings/attachmentStorageStatus";

let failed = 0;

const text = formatAttachmentStorageStatus(
	{ usedBytes: 512 * 1024 * 1024, blobCount: 42 },
	"do",
);
if (!text || !text.includes("512") || !text.includes("42")) {
	console.error("FAIL: DO backend status text:", text);
	failed++;
} else {
	console.log("PASS:", text);
}

const hidden = formatAttachmentStorageStatus(
	{ usedBytes: 512 * 1024 * 1024, blobCount: 42 },
	"r2",
);
if (hidden !== null) {
	console.error("FAIL: R2 backend should hide storage status, got:", hidden);
	failed++;
} else {
	console.log("PASS: R2 backend returns null");
}

if (failed > 0) {
	process.exit(1);
}
