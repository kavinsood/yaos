import type { TwoDeviceScenarios } from "./shared";
import { basicScenarios } from "./basic";
import { issue22RoundtripScenarios } from "./issue22-roundtrip";
import { issue22ReconnectScenarios } from "./issue22-reconnect";
import { syncMetadataScenarios } from "./sync-metadata";

export const TWO_DEVICE_SCENARIOS: TwoDeviceScenarios = {
	...basicScenarios,
	...issue22RoundtripScenarios,
	...issue22ReconnectScenarios,
	...syncMetadataScenarios,
};
