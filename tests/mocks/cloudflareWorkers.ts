// Node stand-in for the workerd-only "cloudflare:workers" module (aliased in tests/run-typescript.mjs), so suites can
// load server/src/worker.ts and the Durable Object classes. It provides only the DurableObject base class.
export abstract class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState;
	protected env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
