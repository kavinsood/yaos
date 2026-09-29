import type { Env } from "./types";

export function withVaultRequestAuthorization(env: Env, vaultId: string): Env {
	let authorization: { tokenHash: string; response: Response; includesActor: boolean } | null = null;
	return {
		...env,
		YAOS_CONFIG: {
			async call(actorName, request) {
				const path = new URL(request.url).pathname;
				const deviceAuthorization = path === "/__yaos/authorize-device";
				const actorAuthorization = path === "/__yaos/collaboration/authorize"
					|| path === "/__yaos/collaboration/authorize-outcome";
				if (actorName !== "global-config" || request.method !== "POST"
					|| !deviceAuthorization && !actorAuthorization) return env.YAOS_CONFIG.call(actorName, request);
				const input = await request.clone().json().catch(() => null) as { tokenHash?: unknown; vaultId?: unknown } | null;
				if (input?.vaultId !== vaultId || typeof input.tokenHash !== "string") {
					return env.YAOS_CONFIG.call(actorName, request);
				}
				if (authorization?.tokenHash === input.tokenHash && (deviceAuthorization || authorization.includesActor)) {
					return authorization.response.clone();
				}
				const response = await env.YAOS_CONFIG.call(actorName, request);
				if (deviceAuthorization) {
					const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
					authorization = { tokenHash: input.tokenHash, response: response.clone(),
						includesActor: payload !== null && Object.hasOwn(payload, "actor") };
				}
				return response;
			},
		},
	};
}
