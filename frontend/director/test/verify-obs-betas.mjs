#!/usr/bin/env node
/** Verify the checked-in neutral mannequin SMPL-X shape fit. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const file = resolve(HERE, "../tools/bench/obs/mannequin-betas.json");
const fit = JSON.parse(readFileSync(file, "utf8"));
const fail = [];
const check = (condition, message) => {
	if (!condition) fail.push(message);
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);

check(fit.schema === "obs.mannequin-betas.v1", `schema=${fit.schema}`);
check(Array.isArray(fit.betas) && fit.betas.length === 10, "betas must contain 10 values");
check(Array.isArray(fit.betas) && fit.betas.every(finite), "betas must be finite");
const maxBeta = Array.isArray(fit.betas) && fit.betas.length ? Math.max(...fit.betas.map(Math.abs)) : Infinity;
check(maxBeta <= 3, `max |beta| ${maxBeta} exceeds 3`);
check(fit.method && typeof fit.method === "object", "method is missing");
check(fit.residuals && typeof fit.residuals === "object" && !Array.isArray(fit.residuals), "residuals are missing");
check(fit.summary && typeof fit.summary === "object", "residual summary is missing");

const rows = Object.values(fit.residuals ?? {});
check(rows.length > 0, "residual table is empty");
for (const [name, row] of Object.entries(fit.residuals ?? {})) {
	check(row && finite(row.target_m) && finite(row.fitted_m) && finite(row.residual_m), `${name} is not finite`);
	if (row && finite(row.target_m) && finite(row.fitted_m) && finite(row.residual_m)) {
		check(Math.abs((row.fitted_m - row.target_m) - row.residual_m) < 1e-8, `${name} residual does not reconcile`);
	}
}
const maxResidual = Math.max(...rows.map((row) => Math.abs(row.residual_m)));
check(finite(fit.summary?.max_bone_length_residual_m), "max bone-length residual is missing");
check(Math.abs(maxResidual - fit.summary.max_bone_length_residual_m) < 1e-8, "summary max residual does not reconcile");
// Targets are the rendered y-bot rig (tools/bench/obs/ybot-targets.mjs). Limb
// bones map joint-to-joint between SMPL and the Mixamo rig and must fit within
// 1.5 cm. Widths and the upper arm span joints defined differently on the two
// skeletons (SMPL hips/shoulders sit inside the body), so they get 3.5 cm.
check(String(fit.method?.source).startsWith("rendered rig rest pose"), `targets must come from the rendered rig, got: ${fit.method?.source}`);
const limbs = Object.entries(fit.residuals ?? {}).filter(([name]) => /^(thigh|shin|foot|forearm)_/.test(name));
check(limbs.length === 8, `expected 8 limb segments, got ${limbs.length}`);
const maxLimb = Math.max(...limbs.map(([, row]) => Math.abs(row.residual_m)));
check(maxLimb < 0.015, `max limb residual ${(maxLimb * 100).toFixed(3)} cm >= 1.5 cm`);
check(maxResidual < 0.035, `max bone-length residual ${(maxResidual * 100).toFixed(3)} cm >= 3.5 cm`);

if (fail.length) {
	console.error("FAIL");
	for (const message of fail) console.error(`  ${message}`);
	process.exit(1);
}
console.log(`PASS: 10 finite betas, max |beta| ${maxBeta.toFixed(3)}, ${rows.length} residuals, max limb residual ${(maxLimb * 100).toFixed(3)} cm, max bone-length residual ${(maxResidual * 100).toFixed(3)} cm`);
