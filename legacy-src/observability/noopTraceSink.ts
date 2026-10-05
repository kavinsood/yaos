/**
 * NoopTraceSink — drops all events. Used in tests and contexts where
 * observability is not needed.
 */

import type { TraceSink, DomainTraceEvent, DomainPathTraceEvent } from "./traceSink";

export class NoopTraceSink implements TraceSink {
	record(_event: DomainTraceEvent): void {}
	recordPath(_event: DomainPathTraceEvent): void {}
}
