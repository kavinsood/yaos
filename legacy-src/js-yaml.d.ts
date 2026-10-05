declare module "js-yaml" {
	export function load(yaml: string): unknown;

	const yaml: {
		load: typeof load;
	};

	export default yaml;
}
