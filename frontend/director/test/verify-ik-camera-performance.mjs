#!/usr/bin/env node
/** Regression checks for the IK exposure work avoided during camera navigation. */
import assert from "node:assert/strict";
import { shouldRefreshIkExposure } from "../src/use-render-activity.js";

assert.equal(
	shouldRefreshIkExposure({ cameraGesture: true, cameraGestureEnded: false, exposureDirty: true, poseDirty: false, elapsedMs: 500 }),
	false,
	"camera motion keeps the cached exposure result",
);
assert.equal(
	shouldRefreshIkExposure({ cameraGesture: false, cameraGestureEnded: true, exposureDirty: true, poseDirty: false, elapsedMs: 1 }),
	true,
	"the first settled frame refreshes after camera motion",
);
assert.equal(
	shouldRefreshIkExposure({ cameraGesture: false, cameraGestureEnded: false, exposureDirty: true, poseDirty: true, elapsedMs: 1 }),
	true,
	"pose changes refresh immediately",
);
assert.equal(
	shouldRefreshIkExposure({ cameraGesture: false, cameraGestureEnded: false, exposureDirty: true, poseDirty: false, elapsedMs: 99 }),
	false,
	"camera-only exposure remains throttled inside the interval",
);
assert.equal(
	shouldRefreshIkExposure({ cameraGesture: false, cameraGestureEnded: false, exposureDirty: true, poseDirty: false, elapsedMs: 100 }),
	true,
	"camera-only exposure refreshes at the interval",
);
assert.equal(
	shouldRefreshIkExposure({ cameraGesture: false, cameraGestureEnded: false, exposureDirty: false, poseDirty: true, elapsedMs: 500 }),
	false,
	"a clean input does not start an exposure pass",
);
console.log("PASS IK camera exposure refresh decisions");
