function throwFromTypeScript(): never {
	throw new Error("RUNNER_STACK_TRACE_PROBE"); // STACK_TRACE_EXPECTED_LINE
}

throwFromTypeScript();
