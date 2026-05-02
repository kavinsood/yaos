import type { ExternalEditPolicy } from "../settings";

export type ExternalEditPolicyDecision = {
	allowImport: boolean;
	reason: "allowed" | "policy-never" | "policy-closed-only-open-file";
};

export function decideExternalEditImport(
	policy: ExternalEditPolicy,
	isOpenInEditor: boolean,
): ExternalEditPolicyDecision {
	if (policy === "never") {
		return {
			allowImport: false,
			reason: "policy-never",
		};
	}
	if (policy === "closed-only" && isOpenInEditor) {
		return {
			allowImport: false,
			reason: "policy-closed-only-open-file",
		};
	}
	return {
		allowImport: true,
		reason: "allowed",
	};
}

export default {
	decideExternalEditImport,
};
