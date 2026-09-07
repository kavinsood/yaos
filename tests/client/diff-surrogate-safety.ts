/**
 * Guards the one place YAOS mutates a Y.Text at partial indices.
 *
 * THE HAZARD
 *
 * Y.Text indices address UTF-16 code units, so an edit boundary can fall
 * between the halves of a surrogate pair.  A diff algorithm working on code
 * units can produce exactly that: replacing 💩 (U+1F4A9 = D83D DCA9) with 😀
 * (U+1F600 = D83D DE00) shares the high surrogate D83D, so a naive longest-
 * common-subsequence pass emits
 *
 *     EQUAL  D83D  /  DELETE DCA9  /  INSERT DE00
 *
 * Applying that splits the Yjs Item mid-character and leaves a lone surrogate.
 * The document still reads back correctly in memory, so nothing looks wrong —
 * but a lone surrogate has no UTF-8 representation, so encoding the document to
 * an update and decoding it again silently substitutes U+FFFD.  The corruption
 * only appears after a persistence round trip.
 *
 * WHY THERE IS NO SANITISER HERE
 *
 * fast-diff already does this.  Its exported entry point hardcodes
 * `fix_unicode = true` (diff.js: `return diff_main(text1, text2, cursor_pos,
 * cleanup, true)`), and diff_cleanupMerge then "shaves off stray surrogates
 * from the end of the previous equality and the beginning of this equality",
 * rolling them into the surrounding delete/insert blocks.  That is precisely
 * the sanitisation the hazard calls for, so adding our own pass would duplicate
 * it and risk disagreeing with it.
 *
 * These tests exist because that is an assumption about a dependency.  A
 * version bump, a swap to another diff library, or a new partial-index mutation
 * would break it silently and only surface as mangled emoji in users' notes
 * days later.
 *
 * The canary at the end applies a deliberately unsanitised patch through the
 * same loop, proving the detector actually fires rather than passing vacuously.
 */

import * as Y from "yjs";
import diff from "fast-diff";
import { boundedTextDiff, MAX_EXACT_DIFF_TOTAL_CHARACTERS } from "../../src/sync/boundedTextDiff";
import { applyDiffToYText } from "../../src/sync/diff";
import { suite } from "../harness.ts";

const s = suite("diff-surrogate-safety");

/** Count code units that are not part of a well-formed surrogate pair. */
function loneSurrogates(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
			else count++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			count++;
		}
	}
	return count;
}

/** Apply an edit through the real code path and report what storage would see. */
function applyAndRoundTrip(oldText: string, newText: string) {
	const doc = new Y.Doc();
	const ytext = doc.getText("t");
	ytext.insert(0, oldText);
	applyDiffToYText(ytext, oldText, newText, "test");

	const live = ytext.toString();
	const reloaded = new Y.Doc();
	Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
	const persisted = reloaded.getText("t").toString();

	doc.destroy();
	reloaded.destroy();
	return { live, persisted };
}

const POO = "\u{1F4A9}";      // D83D DCA9
const GRIN = "\u{1F600}";     // D83D DE00 — shares the HIGH surrogate with POO
const SWEAT = "\u{1F605}";    // D83D DE05 — shares HIGH and most of LOW with GRIN
const OK = "\u{1F44C}";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
const THUMB_LIGHT = "\u{1F44D}\u{1F3FB}";
const THUMB_DARK = "\u{1F44D}\u{1F3FF}";
const FLAG_IN = "\u{1F1EE}\u{1F1F3}";
const FLAG_JP = "\u{1F1EF}\u{1F1F5}";

// ---------------------------------------------------------------------------

s.section("Test 1: the canonical case — replacing an emoji that shares a high surrogate");
{
	const { live, persisted } = applyAndRoundTrip(POO, GRIN);
	s.check(live === GRIN, `live text is the new emoji (${JSON.stringify(live)})`);
	s.check(loneSurrogates(live) === 0, "no lone surrogate in the document");
	s.check(persisted === GRIN, `survives a persistence round trip (${JSON.stringify(persisted)})`);
	s.check(!persisted.includes("\uFFFD"), "no U+FFFD replacement character");
}

s.section("Test 2: fast-diff never emits an op boundary inside a pair");
{
	const pairs: Array<[string, string]> = [
		[POO, GRIN], [GRIN, SWEAT], [POO, OK],
		[`hi ${POO} there`, `hi ${GRIN} there`],
		[FLAG_IN, FLAG_JP],
		[THUMB_LIGHT, THUMB_DARK],
		[FAMILY, `${FAMILY}!`],
		[`a${POO}b`, `a${GRIN}b`],
		[`${POO}${POO}`, `${POO}${GRIN}`],
	];
	let offenders = 0;
	for (const [a, b] of pairs) {
		for (const [, text] of diff(a, b)) {
			if (loneSurrogates(text) > 0) offenders++;
		}
	}
	s.check(offenders === 0, `every diff op is surrogate-complete across ${pairs.length} pairs`);
}

s.section("Test 3: applying those edits never corrupts the document");
{
	const pairs: Array<[string, string]> = [
		[POO, GRIN], [GRIN, SWEAT], [FLAG_IN, FLAG_JP], [THUMB_LIGHT, THUMB_DARK],
		[`note ${POO} end`, `note ${GRIN} end`],
		[FAMILY, THUMB_DARK],
		[`${POO}${GRIN}${OK}`, `${OK}${GRIN}${POO}`],
	];
	let bad = 0;
	for (const [a, b] of pairs) {
		const { live, persisted } = applyAndRoundTrip(a, b);
		if (live !== b || persisted !== b || loneSurrogates(live) > 0) bad++;
	}
	s.check(bad === 0, `all ${pairs.length} edits round-trip exactly`);
}

s.section("Test 4: deterministic fuzz over emoji-heavy text");
{
	const POOL = [
		POO, GRIN, SWEAT, OK, FAMILY, THUMB_LIGHT, THUMB_DARK, FLAG_IN, FLAG_JP,
		"\u{1F680}", "\u{1F9E0}", "e\u0301", "a\u0308\u0331", "\u0915\u094D\u0937",
		"hello", "world ", " note ", "# heading\n", "tab\there",
	];
	let seed = 12345;
	const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
	const randomText = () => {
		let s = "";
		const parts = 1 + Math.floor(rnd() * 6);
		for (let i = 0; i < parts; i++) s += POOL[Math.floor(rnd() * POOL.length)];
		return s;
	};

	let runs = 0, mismatched = 0, lone = 0, corrupted = 0;
	for (let iteration = 0; iteration < 600; iteration++) {
		const doc = new Y.Doc();
		const ytext = doc.getText("t");
		let current = randomText();
		ytext.insert(0, current);

		// Successive edits, as a file saved repeatedly during a session.
		for (let step = 0; step < 4; step++) {
			const next = randomText();
			applyDiffToYText(ytext, current, next, "test");
			runs++;
			const live = ytext.toString();
			if (live !== next) mismatched++;
			if (loneSurrogates(live) > 0) lone++;

			const reloaded = new Y.Doc();
			Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
			if (reloaded.getText("t").toString() !== live) corrupted++;
			reloaded.destroy();
			current = next;
		}
		doc.destroy();
	}
	s.check(mismatched === 0, `text matches the target after every edit (${runs} applications)`);
	s.check(lone === 0, "no lone surrogate ever entered the document");
	s.check(corrupted === 0, "every document survived a persistence round trip unchanged");
}

s.section("Test 5: canary — the detector fires on a deliberately split pair");
{
	// Hand-built unsanitised patch: retain the high surrogate, swap the low one.
	// This is what a diff library WITHOUT surrogate handling would emit for
	// POO -> GRIN, and is the exact shape fast-diff's fix_unicode prevents.
	const doc = new Y.Doc();
	const ytext = doc.getText("t");
	ytext.insert(0, POO);
	doc.transact(() => {
		ytext.delete(1, 1);            // drop DCA9, keeping the lone D83D
		ytext.insert(1, "\uDE00");     // splice in a lone low surrogate
	}, "test");

	const live = ytext.toString();
	// Exact count is brittle: the retained high surrogate ends up adjacent to the
	// spliced-in low one, so how many read as "lone" depends on item boundaries.
	// What matters is that at least one exists — the document is now ill-formed.
	s.check(loneSurrogates(live) >= 1, `canary produced an ill-formed document (${loneSurrogates(live)} lone surrogate(s))`);

	const reloaded = new Y.Doc();
	Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
	const persisted = reloaded.getText("t").toString();

	// The document looks fine in memory; the damage only appears after encoding.
	s.check(
		persisted !== live || persisted.includes("\uFFFD"),
		`an unsanitised patch DOES corrupt through persistence (live ${JSON.stringify(live)} -> stored ${JSON.stringify(persisted)})`,
	);
	s.check(
		loneSurrogates(live) > 0 || persisted.includes("\uFFFD"),
		"the detector used above is capable of catching this — the suite is not vacuous",
	);
	doc.destroy();
	reloaded.destroy();
}

s.section("Test 6: pathological large rewrites are bounded and remain exact");
{
	const edge = `${POO}${GRIN}`;
	const oldText = `${edge}${"a".repeat(1_300_000)}${edge}`;
	const newText = `${edge}${"b".repeat(1_300_000)}${edge}`;
	const startedAt = performance.now();
	const segments = boundedTextDiff(oldText, newText);
	const elapsedMs = performance.now() - startedAt;
	const { live, persisted } = applyAndRoundTrip(oldText, newText);

	s.check(
		segments.some(([kind, text]) => kind === -1 && text.length > MAX_EXACT_DIFF_TOTAL_CHARACTERS),
		"large irreducible middle uses the bounded replacement path",
	);
	s.check(elapsedMs < 2_000, `large rewrite diff completes promptly (${elapsedMs.toFixed(1)}ms)`);
	s.check(live === newText && persisted === newText, "large rewrite is exact live and after persistence");
	s.check(loneSurrogates(live) === 0, "bounded edge retention never splits a surrogate pair");
}

s.section("Test 7: asymmetric large rewrites cannot sneak into Myers");
{
	const oldText = "a".repeat(64 * 1024);
	const newText = "b".repeat(1_499_000);
	const startedAt = performance.now();
	const segments = boundedTextDiff(oldText, newText);
	const elapsedMs = performance.now() - startedAt;
	const { live, persisted } = applyAndRoundTrip(oldText, newText);

	s.check(segments.length === 2 && segments[0]?.[0] === -1 && segments[1]?.[0] === 1,
		"unrelated asymmetric inputs use one bounded replacement");
	s.check(elapsedMs < 2_000, `asymmetric rewrite diff completes promptly (${elapsedMs.toFixed(1)}ms)`);
	s.check(live === newText && persisted === newText, "asymmetric rewrite is exact live and after persistence");
}

s.section("Test 8: moderate unrelated middles cannot enter Myers worst case");
{
	const oldText = "a".repeat(16_384);
	const newText = "b".repeat(16_384);
	const startedAt = performance.now();
	const segments = boundedTextDiff(oldText, newText);
	const elapsedMs = performance.now() - startedAt;

	s.check(segments.length === 2 && segments[0]?.[0] === -1 && segments[1]?.[0] === 1,
		"wide unrelated middle uses one bounded replacement");
	s.check(segments[0]?.[1] === oldText && segments[1]?.[1] === newText,
		"bounded replacement remains exact");
	s.check(elapsedMs < 250, `moderate rewrite diff completes promptly (${elapsedMs.toFixed(1)}ms)`);
}
await s.done();
