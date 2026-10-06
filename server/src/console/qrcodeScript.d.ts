// wrangler.toml's Text rule imports qrcode-generator's browser build as its source text (console.ts, DECISIONS O12).
declare module "qrcode-generator/dist/qrcode.js" {
	const source: string;
	export default source;
}
