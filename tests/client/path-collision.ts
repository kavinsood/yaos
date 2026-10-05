/**
 * Tests for path collision detection.
 */

import {
	findCanonicalPathCollisions,
	isCanonicalPathFileIdCollision,
} from "../../legacy-src/paths/pathCollision";
import { suite } from "../harness.ts";

const s = suite("path-collision");

s.section("Test 1: NFC and NFD-equivalent display paths produce collision");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const collisions = findCanonicalPathCollisions([nfc, nfd]);
	s.check(collisions.length === 1, "one collision found");
	s.check(collisions[0]!.displayPaths.length === 2, "collision has 2 display paths");
	s.check(collisions[0]!.displayPaths.includes(nfc), "collision includes NFC path");
	s.check(collisions[0]!.displayPaths.includes(nfd), "collision includes NFD path");
	s.check(collisions[0]!.kind === "canonical-equivalence", "collision kind is canonical-equivalence");
}

s.section("Test 2: exact duplicate paths do not produce false collision");
{
	const collisions = findCanonicalPathCollisions(["notes/a.md", "notes/a.md"]);
	s.check(collisions.length === 0, "exact duplicates: no collision (same display path)");
}

s.section("Test 3: different paths do not collide");
{
	const collisions = findCanonicalPathCollisions(["notes/a.md", "notes/b.md", "other/c.md"]);
	s.check(collisions.length === 0, "different paths: no collisions");
}

s.section("Test 4: case-only variants do NOT collide (no case folding)");
{
	const collisions = findCanonicalPathCollisions(["notes/File.md", "notes/file.md"]);
	s.check(collisions.length === 0, "case-only variants: no collision (case folding deferred)");
}

s.section("Test 5: separator variants collide");
{
	const collisions = findCanonicalPathCollisions(["notes\\file.md", "notes/file.md"]);
	s.check(collisions.length === 1, "backslash vs forward slash: collision");
	s.check(collisions[0]!.displayPaths.length === 2, "both paths in collision");
}

s.section("Test 6: leading ./ variant collides with clean path");
{
	const collisions = findCanonicalPathCollisions(["./notes/file.md", "notes/file.md"]);
	s.check(collisions.length === 1, "leading ./ collides with clean path");
}

s.section("Test 7: multiple collisions detected independently");
{
	const nfc1 = "a/\u00C0.md";
	const nfd1 = "a/A\u0300.md";
	const nfc2 = "b/\u00E9.md";
	const nfd2 = "b/e\u0301.md";
	const safe = "c/normal.md";
	const collisions = findCanonicalPathCollisions([nfc1, nfd1, nfc2, nfd2, safe]);
	s.check(collisions.length === 2, "two independent collisions found");
}

s.section("Test 8: file-ID-aware canonical collision diagnostics");
{
	const oldCanonicalKey = "notes/\u00C0.md";
	const newCanonicalKey = "notes/\u00C0.md";

	s.check(
		isCanonicalPathFileIdCollision({
			oldCanonicalKey,
			newCanonicalKey,
			oldFileId: "file-id-a",
			newFileId: "file-id-b",
		}),
		"same canonical key with distinct file IDs is a collision",
	);
	s.check(
		!isCanonicalPathFileIdCollision({
			oldCanonicalKey,
			newCanonicalKey,
			oldFileId: "file-id-a",
			newFileId: "file-id-a",
		}),
		"same file ID through equivalent paths is not a collision",
	);
	s.check(
		!isCanonicalPathFileIdCollision({
			oldCanonicalKey,
			newCanonicalKey: "notes/other.md",
			oldFileId: "file-id-a",
			newFileId: "file-id-b",
		}),
		"distinct file IDs without a matching canonical key are not a collision",
	);
	s.check(
		!isCanonicalPathFileIdCollision({
			oldCanonicalKey,
			newCanonicalKey,
			oldFileId: undefined,
			newFileId: "file-id-b",
		}),
		"unresolved path entries are not a collision",
	);
}

s.section("Test 9: empty input produces no collisions");
{
	s.check(findCanonicalPathCollisions([]).length === 0, "empty input: no collisions");
}

s.section("Test 10: single path produces no collisions");
{
	s.check(findCanonicalPathCollisions(["notes/a.md"]).length === 0, "single path: no collision");
}
await s.done();
