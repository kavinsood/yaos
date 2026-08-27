import { disabledAdminRouteResponse } from "../../server/src/server";
import { suite } from "../harness.ts";

const s = suite("admin-route-gating");

s.section("Test 1: admin route is hidden when the flag is absent");
{
	const response = disabledAdminRouteResponse({});
	s.check(response !== null, "missing admin flag returns a rejection");
	s.check(response?.status === 404, "disabled admin route returns 404, not an authorization status");
	const body: unknown = response ? await response.json() : null;
	const errorCode =
		body && typeof body === "object" && "error" in body
			? body.error
			: undefined;
	s.check(errorCode === "not found", "disabled admin route uses a not-found payload");
}

s.section("Test 2: any non-empty flag enables the admin route");
{
	s.check(
		disabledAdminRouteResponse({ YAOS_ENABLE_ADMIN_ROUTES: "true" }) === null,
		"documented true value enables admin routes",
	);
	s.check(
		disabledAdminRouteResponse({ YAOS_ENABLE_ADMIN_ROUTES: "1" }) === null,
		"the binding follows the runtime non-empty-string contract",
	);
}

await s.done();
