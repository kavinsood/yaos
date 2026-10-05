/** The engine worker bundle (src/engine/workerMain.ts) as an IIFE source string, injected by esbuild.config.mjs. */
declare module "virtual:yaos-engine-worker" {
	const source: string;
	export default source;
}
