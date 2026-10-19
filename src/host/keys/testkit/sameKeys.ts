/**
 * TEST ONLY (testkit/: never imported by product code). Compares epoch keys without printing them: assertions
 * report a boolean, never key bytes.
 */

import { bytesEqual } from "../../../core/codec/lib0";
import type { EpochKey } from "../secretStore";

/** True when `a` and `b` hold the same epoch keys, in order. */
export function sameKeys(a: readonly EpochKey[], b: readonly EpochKey[]): boolean {
	return a.length === b.length && a.every((x, i) => x.e === b[i]!.e && bytesEqual(x.k, b[i]!.k));
}
