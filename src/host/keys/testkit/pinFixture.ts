/**
 * TEST ONLY (testkit/: never imported by product code). The data.json state a device has after main pinned it to
 * suite 0 on a successful pinSuite0 (a suite-0 link, or the creation opt-out, e2ee-design §12.4 (ii) / (iii)),
 * written through the same transition the controller applies (pin.ts pinnedSuite0). The harnesses use it so the
 * suite-0 e2e and sim runs keep syncing; production never infers a pin (absent = unpinned = blocked).
 */

import { pinnedSuite0, type E2eePin, type PinFields } from "../pin";

/** `d` as a device pinned to suite 0 would have it. */
export function withSuite0PinForTest<T extends PinFields>(d: T): T {
	return pinnedSuite0(d);
}

/** The bare pin value of that state. */
export function suite0PinForTest(): E2eePin {
	return pinnedSuite0<PinFields>({}).e2ee!;
}
