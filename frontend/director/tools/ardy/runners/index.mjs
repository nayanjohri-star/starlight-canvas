/**
 * Runner selection for the motion generation bridge.
 *
 * The local Studio has one supported backend: Kimodo. The former ARDY
 * local/remote selector lived here, which made an unrelated legacy runtime
 * part of every bridge launch. Keeping selection in one place still gives the
 * bridge a small, testable seam while refusing stale ARDY environment values.
 */

import { createKimodoRunner } from "../../kimodo/runner.mjs";

export function createRunner() {
	const backend = (process.env.CCLAY_MOTION_BACKEND || "").trim().toLowerCase();
	if (backend && backend !== "kimodo") {
		throw new Error(`unknown CCLAY_MOTION_BACKEND "${backend}" (expected "kimodo")`);
	}
	return createKimodoRunner();
}
