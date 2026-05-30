/**
 * ScenarioStateController — Puppeteer-owned scenario annotation controller.
 *
 * This file lives in qa/ and must never be imported from src/.
 * It owns scenario run identity and step advancement for QA test harnesses.
 *
 * Architecture:
 *   - DeviceWitnessTracker (Observer) reads ScenarioContext passively.
 *   - ScenarioStateController (Puppeteer) owns mutation of scenario state.
 *
 * Never import this from the telemetry runtime or product code.
 */

import type { ScenarioContext } from "../../src/telemetry/diagnostics/deviceWitnessTracker";

export class ScenarioStateController implements ScenarioContext {
	scenarioRunId: string | null = null;
	scenarioId: string | null = null;
	stepIndex: number | null = null;
	stepLabel: string | undefined = undefined;

	setScenarioRunId(scenarioRunId: string, scenarioId: string): void {
		this.scenarioRunId = scenarioRunId;
		this.scenarioId = scenarioId;
	}

	/**
	 * Advance the scenario step index.
	 * stepIndex must be strictly greater than the current step index.
	 * Returns false if validation fails (backwards step, no scenarioRunId).
	 */
	advanceScenarioStep(stepIndex: number, label?: string): boolean {
		if (!this.scenarioRunId) return false;
		if (!Number.isInteger(stepIndex) || stepIndex < 0) return false;
		if (this.stepIndex !== null && stepIndex <= this.stepIndex) return false;
		this.stepIndex = stepIndex;
		this.stepLabel = label;
		return true;
	}

	getScenarioStepState(): { scenarioRunId: string | null; scenarioId: string | null; stepIndex: number | null; stepLabel: string | undefined } {
		return {
			scenarioRunId: this.scenarioRunId,
			scenarioId: this.scenarioId,
			stepIndex: this.stepIndex,
			stepLabel: this.stepLabel,
		};
	}
}
