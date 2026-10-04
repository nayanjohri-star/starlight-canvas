import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProceduralRig, disposeProceduralRig, proceduralRestDocument, PROCEDURAL_RIG_SOURCE } from '../src/procedural-rig.js';
import { readFileSync } from 'node:fs';
import { POSE_BONES, DEFAULT_POSE, applyPose, capturePose, mirrorPose, restoreBindPositions } from '../src/poses.js';
import { resolveIkRig, createIkState, solveIk, ikPlantFeet, ikSolvePlantedFeet, ikBakeKeyframe, ikEvaluate, ikTouch, findBone } from '../src/ardy/ik.js';
import { buildArdyPose } from '../src/ardy/export.js';
import { applyPartColours } from '../src/part-colours.js';

const rigs = ['y-bot-tpose', 'x-bot-tpose'].map(createProceduralRig);
for (const rig of rigs) { rig.scale.setScalar(0.01); rig.updateMatrixWorld(true); }
assert.equal(PROCEDURAL_RIG_SOURCE.license, 'AGPL-3.0-or-later');
assert.notEqual(rigs[0].uuid, rigs[1].uuid);
assert.notEqual(rigs[0].getObjectByName('Starlight_Surface').geometry, rigs[1].getObjectByName('Starlight_Surface').geometry);
assert.notEqual(rigs[0].getObjectByName('Starlight_Surface').skeleton, rigs[1].getObjectByName('Starlight_Surface').skeleton);
assert.ok(rigs[0].getObjectByName('Starlight_Surface').geometry.attributes.position.array.some((value, i) => value !== rigs[1].getObjectByName('Starlight_Surface').geometry.attributes.position.array[i]), 'variants have different original shapes');
assert.deepEqual(JSON.parse(readFileSync(new URL('../public/ardy/cskel27-rest.json', import.meta.url))), proceduralRestDocument());
for (const rig of rigs) {
	const surface = rig.getObjectByName('Starlight_Surface'), neck = findBone(rig, 'Neck');
	const neckIndex = surface.skeleton.bones.indexOf(neck);
	assert.ok([...surface.geometry.attributes.skinIndex.array].some((index, offset) =>
		offset % 4 === 0 && index === neckIndex && surface.geometry.attributes.position.getY(offset / 4) < 160),
		'the neck has overlapping skin below its pivot, closing the torso-to-neck gap');
	assert.equal(applyPose(rig, Object.fromEntries(POSE_BONES.map(bone => [bone.id, [0, 0, 0]]))).applied, 20);
	const solver = resolveIkRig(rig); assert.equal(solver.chains.size, 4); assert.ok(solver.fkJoints.size >= 7);
	const planted = createIkState(); ikPlantFeet(solver.chains, planted);
	findBone(rig, 'Hips').position.y -= 9; rig.updateMatrixWorld(true); ikSolvePlantedFeet(solver.chains, planted);
	for (const id of ['leftFoot', 'rightFoot']) assert.ok(solver.chains.get(id).bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(planted.plants.get(id)) < 0.0001, `${id} remains planted after a 9 cm hips drop`);
	restoreBindPositions(rig); applyPose(rig, DEFAULT_POSE.bones);
	assert.ok(findBone(rig, 'LeftHand').getWorldPosition(new THREE.Vector3()).y < 1.2, 'default arms hang beside the body');
	const hand = solver.chains.get('leftHand'), target = hand.bones[2].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.1, 0.15, 0.08));
	solveIk(hand, target); assert.ok(hand.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(target) < 0.01);
	const state = createIkState(); ikTouch(state, 'leftHand'); ikBakeKeyframe(solver.chains, state, 12, solver.fkJoints);
	const before = hand.bones[1].quaternion.clone(); applyPose(rig, DEFAULT_POSE.bones); ikEvaluate(solver.chains, state, 12, solver.fkJoints);
	assert.ok(before.angleTo(hand.bones[1].quaternion) < 1e-7, 'IK key reproduces the solved limb');
	const pose = { bones: capturePose(rig), rootY: 0.03 };
	const mirrored = mirrorPose(pose); const twice = mirrorPose(mirrored);
	assert.deepEqual(twice, pose); assert.deepEqual(mirrored.bones.rArm, [pose.bones.lArm[0], -pose.bones.lArm[1], -pose.bones.lArm[2]]);
	const leftBefore = findBone(rig, 'LeftHand').getWorldPosition(new THREE.Vector3());
	applyPose(rig, mirrored.bones);
	const rightAfter = findBone(rig, 'RightHand').getWorldPosition(new THREE.Vector3());
	assert.ok(rightAfter.distanceTo(leftBefore.clone().multiply(new THREE.Vector3(-1, 1, 1))) < 1e-5, 'mirrored hand reaches the reflected world position');
	const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100); camera.position.set(0, 1.6, 4);
	const exported = buildArdyPose({ rig, camRef: { current: camera }, look: { current: { yaw: 0, pitch: 0 } }, fovDeg: 45, slate: 'Original rig', rigName: rig.name });
	assert.equal(Object.keys(exported.bones).length, 20);
	const palette = applyPartColours(rig); assert.ok(palette);
}
const unchanged = capturePose(rigs[1]); applyPose(rigs[0], { lArm: [0.7, 0.1, 0.2] }); assert.deepEqual(capturePose(rigs[1]), unchanged);
let geometries = 0, materials = 0;
rigs[0].traverse(node => { node.geometry?.addEventListener('dispose', () => geometries++); node.material?.addEventListener('dispose', () => materials++); });
disposeProceduralRig(rigs[0]); const first = { geometries, materials }; assert.ok(geometries >= 2 && materials >= 2);
disposeProceduralRig(rigs[0]); assert.deepEqual({ geometries, materials }, first, 'dispose is idempotent'); disposeProceduralRig(rigs[1]);
console.log('PASS original procedural skins: independent characters, 20 joints, IK keys, planted feet, mirror involution, ARDY export, part colours and disposal');
