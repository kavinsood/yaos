/**
 * Tests for canonical path identity.
 *
 * Proves: NFC/NFD equivalence, separator normalization, leading ./ stripping,
 * displayPath preservation, and canonicalKey determinism.
 */

import { canonicalizeVaultPath } from "../../legacy-src/paths/canonicalPath";
import { suite } from "../harness.ts";

const s = suite("canonical-path");

s.section("Test 1: NFC path keeps same canonicalKey");
{
	const nfc = "notes/\u00C0.md"; // À (precomposed NFC)
	const result = canonicalizeVaultPath(nfc);
	s.check(result.canonicalKey === nfc, "NFC input: canonicalKey matches input");
	s.check(result.normalizedPath === nfc, "NFC input: normalizedPath matches input");
	s.check(result.displayPath === nfc, "NFC input: displayPath preserves original");
}

s.section("Test 2: NFD-equivalent path maps to same canonicalKey");
{
	const nfc = "notes/\u00C0.md"; // À (precomposed)
	const nfd = "notes/A\u0300.md"; // A + combining grave (decomposed)
	const nfcResult = canonicalizeVaultPath(nfc);
	const nfdResult = canonicalizeVaultPath(nfd);
	s.check(nfcResult.canonicalKey === nfdResult.canonicalKey, "NFC and NFD produce same canonicalKey");
	s.check(nfdResult.displayPath === nfd, "NFD displayPath preserves original NFD input");
	s.check(nfdResult.normalizedPath === nfc, "NFD normalizedPath is NFC form");
}

s.section("Test 3: backslashes normalize to forward slash");
{
	const result = canonicalizeVaultPath("notes\\sub\\file.md");
	s.check(result.canonicalKey === "notes/sub/file.md", "backslashes become forward slashes");
	s.check(result.displayPath === "notes\\sub\\file.md", "displayPath preserves backslashes");
}

s.section("Test 4: leading ./ is stripped");
{
	const result = canonicalizeVaultPath("./notes/file.md");
	s.check(result.canonicalKey === "notes/file.md", "leading ./ stripped");
	s.check(result.displayPath === "./notes/file.md", "displayPath preserves leading ./");

	const repeated = canonicalizeVaultPath("././notes/file.md");
	s.check(repeated.canonicalKey === "notes/file.md", "repeated ././ stripped");
}

s.section("Test 5: leading / is stripped");
{
	const result = canonicalizeVaultPath("/notes/file.md");
	s.check(result.canonicalKey === "notes/file.md", "leading / stripped");
}

s.section("Test 6: multiple slashes collapsed");
{
	const result = canonicalizeVaultPath("notes///sub//file.md");
	s.check(result.canonicalKey === "notes/sub/file.md", "multiple slashes collapsed");
}

s.section("Test 7: plain path is unchanged");
{
	const result = canonicalizeVaultPath("notes/daily/2024-01-01.md");
	s.check(result.canonicalKey === "notes/daily/2024-01-01.md", "clean path unchanged");
	s.check(result.normalizedPath === "notes/daily/2024-01-01.md", "normalizedPath same");
	s.check(result.displayPath === "notes/daily/2024-01-01.md", "displayPath same");
}

s.section("Test 8: two different NFC/NFD paths same canonical key");
{
	// e + combining acute = NFC é
	const nfd = "caf\u0065\u0301/menu.md";
	const nfc = "caf\u00E9/menu.md";
	s.check(
		canonicalizeVaultPath(nfd).canonicalKey === canonicalizeVaultPath(nfc).canonicalKey,
		"café NFC/NFD equivalence",
	);
}

s.section("Test 9: case-only difference produces DIFFERENT keys");
{
	const lower = canonicalizeVaultPath("notes/File.md");
	const upper = canonicalizeVaultPath("notes/file.md");
	s.check(lower.canonicalKey !== upper.canonicalKey, "case difference: distinct keys (no case folding)");
}

s.section("Test 10: empty string");
{
	const result = canonicalizeVaultPath("");
	s.check(result.canonicalKey === "", "empty string produces empty key");
	s.check(result.displayPath === "", "empty string displayPath is empty");
}

s.section("Test 11: rename NFC → NFD-equivalent does not produce two identities");
{
	const before = canonicalizeVaultPath("notes/\u00C0.md");
	const after = canonicalizeVaultPath("notes/A\u0300.md");
	s.check(before.canonicalKey === after.canonicalKey, "rename between NFC/NFD forms: same identity");
}
await s.done();
