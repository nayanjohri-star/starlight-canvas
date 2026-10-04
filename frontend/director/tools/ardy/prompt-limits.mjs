// Shared ARDY prompt and duration limits. Keep this module dependency-free so
// browser tooling, the bridge, and the Workers API can import the same values.
export const PROMPT_MAX_CHARS = 500;
export const DURATION_MIN = 0.15;
export const DURATION_MAX = 1200;
