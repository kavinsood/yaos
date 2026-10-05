import { decideExternalEditImport } from "../../legacy-src/sync/externalEditPolicy";
import { suite } from "../harness.ts";

const s = suite("external-edit-policy-regressions");

s.section("Test 1: always policy imports both open and closed files");
{
	const closed = decideExternalEditImport("always", false);
	const open = decideExternalEditImport("always", true);
	s.check(closed.allowImport, "always+closed allows import");
	s.check(open.allowImport, "always+open allows import");
	s.check(closed.reason === "allowed", "always+closed reason is allowed");
	s.check(open.reason === "allowed", "always+open reason is allowed");
}

s.section("Test 2: closed-only policy imports only closed files");
{
	const closed = decideExternalEditImport("closed-only", false);
	const open = decideExternalEditImport("closed-only", true);
	s.check(closed.allowImport, "closed-only+closed allows import");
	s.check(!open.allowImport, "closed-only+open blocks import");
	s.check(
		open.reason === "policy-closed-only-open-file",
		"closed-only+open reason is policy-closed-only-open-file",
	);
}

s.section("Test 3: never policy blocks imports regardless of openness");
{
	const closed = decideExternalEditImport("never", false);
	const open = decideExternalEditImport("never", true);
	s.check(!closed.allowImport, "never+closed blocks import");
	s.check(!open.allowImport, "never+open blocks import");
	s.check(closed.reason === "policy-never", "never+closed reason is policy-never");
	s.check(open.reason === "policy-never", "never+open reason is policy-never");
}
await s.done();
