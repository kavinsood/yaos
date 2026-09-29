import worker from "./worker";

export default {
	async fetch(request: Request, env: { YAOS_BUCKET: R2Bucket; R4_PROBE_TOKEN: string }): Promise<Response> {
		if (!env.R4_PROBE_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.R4_PROBE_TOKEN}`) {
			return new Response(null, { status: 401 });
		}
		const path = new URL(request.url).pathname;
		let unsafeHeader = false;
		request.headers.forEach((_value, name) => {
			if (name.startsWith("x-r4-")) unsafeHeader = true;
		});
		if (!/^\/(?:blobs|metadata|r2-checksum|conditional)\/[a-f0-9]{64}$/.test(path)
			|| !["GET", "PUT"].includes(request.method)
			|| ((path.startsWith("/r2-checksum/") || path.startsWith("/conditional/")) && request.method !== "PUT")
			|| unsafeHeader) {
			return new Response(null, { status: 400 });
		}
		return await worker.fetch(request, { BLOBS: env.YAOS_BUCKET });
	},
};
