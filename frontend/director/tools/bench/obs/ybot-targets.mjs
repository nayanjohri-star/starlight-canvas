#!/usr/bin/env node
// Body-size targets for fit_mannequin_betas.py, measured on the character that
// is actually rendered: the y-bot FBX rig in its rest (T) pose, at the Studio's
// 0.01 armature scale. Only the character model is read (no motion, no video).
// Usage: node tools/bench/obs/ybot-targets.mjs [model] > targets.json
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// Segment name -> Mixamo bone pair, matching fit_mannequin_betas.py SEGMENTS
// (SMPL joint pairs there). Upper arm: the SMPL spine3 -> shoulder span maps to
// Spine2 -> Arm on the rig, the same visible shoulder reach.
export const RIG_SEGMENTS = {
	thigh_left: ["LeftUpLeg", "LeftLeg"], thigh_right: ["RightUpLeg", "RightLeg"],
	shin_left: ["LeftLeg", "LeftFoot"], shin_right: ["RightLeg", "RightFoot"],
	foot_left: ["LeftFoot", "LeftToeBase"], foot_right: ["RightFoot", "RightToeBase"],
	pelvis_width: ["LeftUpLeg", "RightUpLeg"], spine_length: ["Hips", "Spine2"],
	upper_arm_left: ["Spine2", "LeftArm"], upper_arm_right: ["Spine2", "RightArm"],
	forearm_left: ["LeftForeArm", "LeftHand"], forearm_right: ["RightForeArm", "RightHand"],
	shoulder_width: ["LeftArm", "RightArm"],
};

export function ybotTargets(model = "y-bot-tpose") {
	const path = ["public", "dist"].map((d) => join(ROOT, d, "models", `${model}.fbx`)).find(existsSync);
	if (!path) throw new Error(`character model ${model}.fbx not found under public/ or dist/models`);
	const bytes = readFileSync(path);
	const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
	rig.scale.setScalar(0.01);
	rig.updateMatrixWorld(true);
	const bones = new Map();
	rig.traverse((o) => { if (o.isBone) bones.set(o.name.replace(/^mixamorig:?/, ""), o); });
	const at = (name) => {
		const bone = bones.get(name);
		if (!bone) throw new Error(`${model}: no bone ${name}`);
		return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
	};
	const targets = Object.fromEntries(Object.entries(RIG_SEGMENTS).map(([name, [a, b]]) => [name, at(a).distanceTo(at(b))]));
	// Standing height: the skinned mesh's rest bounding box (sole to crown).
	const box = new THREE.Box3();
	rig.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
	targets.total_height = box.max.y - box.min.y;
	return { schema: "obs.ybot-targets.v1", model: path.slice(ROOT.length + 1), scale: 0.01, pose: "FBX rest (T) pose", targets };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(ybotTargets(process.argv[2]), null, 1));
