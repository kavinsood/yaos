import { CoalescedStatusRefresh } from "../../legacy-src/status/coalescedStatusRefresh";
import { sleep, suite } from "../harness.ts";

const s = suite("coalesced-status-refresh");

s.section("Coalesced receipt status refresh");
let refreshCount = 0;
const refresh = new CoalescedStatusRefresh(() => {
	refreshCount++;
});

refresh.request();
refresh.request();
refresh.request();
s.check(refreshCount === 0, "a requested refresh is deferred");
await sleep(5);
s.check(refreshCount === 1, "a burst of accepted receipt updates causes one redraw");

refresh.request();
refresh.cancel();
await sleep(5);
s.check(refreshCount === 1, "cancelling during teardown prevents a stale redraw");

refresh.request();
await sleep(5);
s.check(refreshCount === 2, "the coalescer accepts a later receipt update after rendering");
await s.done();
