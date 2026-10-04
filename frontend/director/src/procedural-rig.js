import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { primeBindPose } from "./poses.js";
import { CSKEL27_JOINTS } from "./ardy/cskel27.js";

// Original, parameter-built maquettes. No downloaded models, textures, or
// captured model coordinates are used. Bone names are an interoperability
// convention; all proportions and surfaces are authored here in centimetres.
export const PROCEDURAL_RIG_SOURCE = Object.freeze({
	title: "Starlight procedural maquettes",
	author: "Starlight contributors",
	license: "AGPL-3.0-or-later",
	units: "centimetres",
	up: "Y",
});

export function createProceduralRig(model = "y-bot-tpose") {
	const broad = model === "x-bot-tpose" || model === "starlight-b";
	const root = new THREE.Group();
	root.name = broad ? "Starlight_Maquette_B" : "Starlight_Maquette_A";
	root.userData.proceduralRig = true;
	root.userData.source = { ...PROCEDURAL_RIG_SOURCE };
	const bones = [];
	const bone = (name, parent, position, yaw = 0) => {
		const value = new THREE.Bone();
		value.name = `mixamorig${name}`;
		value.position.set(...position);
		value.rotation.y = yaw;
		parent.add(value); bones.push(value);
		return value;
	};
	const hips = bone("Hips", root, [0, 98, 0]);
	const spine = bone("Spine", hips, [0, 16, 0]);
	const chest = bone("Spine1", spine, [0, 14, 0]);
	const upper = bone("Spine2", chest, [0, 14, 0]);
	const neck = bone("Neck", upper, [0, 18, 0]);
	const head = bone("Head", neck, [0, 11, 0]);
	bone("HeadTop_End", head, [0, 21, 0]);
	const limbs = [];
	for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
		// A symmetric local frame makes +X pose deltas lower both arms.
		const shoulder = bone(`${side}Shoulder`, upper, [sign * 8, 8, 0], sign * Math.PI / 2);
		const arm = bone(`${side}Arm`, shoulder, [0, 0, broad ? 14 : 12]);
		const forearm = bone(`${side}ForeArm`, arm, [0, 0, 29]);
		const hand = bone(`${side}Hand`, forearm, [0, 0, 26]);
		bone(`${side}HandEnd`, hand, [0, 0, 11]);
		bone(`${side}HandThumb1`, hand, [3.5, 0, 4]);
		const thigh = bone(`${side}UpLeg`, hips, [sign * 9, 0, 0]);
		const shin = bone(`${side}Leg`, thigh, [0, -44, 0]);
		const foot = bone(`${side}Foot`, shin, [0, -44, 0]);
		const toe = bone(`${side}ToeBase`, foot, [0, -5, 17]);
		bone(`${side}Toe_End`, toe, [0, 0, 5]);
		limbs.push({ shoulder, arm, forearm, hand, thigh, shin, foot, toe });
	}
	root.updateMatrixWorld(true);
	const surfaces = [], joints = [];
	const skin = (geometry, owner, list = surfaces) => {
		geometry.applyMatrix4(owner.matrixWorld);
		const count = geometry.attributes.position.count, index = bones.indexOf(owner);
		const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
		for (let i = 0; i < count; i++) { indices[i * 4] = index; weights[i * 4] = 1; }
		geometry.setAttribute("skinIndex", new THREE.BufferAttribute(indices, 4));
		geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
		list.push(geometry);
	};
	const ellipsoid = (owner, size, position = [0, 0, 0], list = surfaces) => {
		const geometry = new THREE.SphereGeometry(1, 14, 10);
		geometry.scale(...size); geometry.translate(...position); skin(geometry, owner, list);
	};
	const segment = (owner, child, radius) => {
		const end = child.position.clone(), length = end.length();
		const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.1, length - radius * 2), 4, 10);
		geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize()));
		geometry.translate(end.x / 2, end.y / 2, end.z / 2); skin(geometry, owner);
	};
	ellipsoid(hips, [broad ? 18 : 15, 12, 11], [0, 4, 0]);
	ellipsoid(spine, [broad ? 17 : 14, 12, 10], [0, 6, 0]);
	ellipsoid(chest, [broad ? 22 : 17, 14, 11], [0, 7, 0]);
	segment(upper, neck, 5);
	ellipsoid(neck, [5, 5, 5]);
	segment(neck, head, 5);
	ellipsoid(head, broad ? [12, 15, 15] : [11, 17, 15], [0, 5, 0]);
	for (const limb of limbs) {
		segment(limb.shoulder, limb.arm, 5);
		segment(limb.arm, limb.forearm, broad ? 6 : 5);
		segment(limb.forearm, limb.hand, 4.4);
		ellipsoid(limb.hand, [3.4, 2.5, 6.7], [0, 0, 4.2]);
		segment(limb.thigh, limb.shin, broad ? 7.6 : 6.5);
		segment(limb.shin, limb.foot, 5.2);
		ellipsoid(limb.foot, [5.2, 5, 12], [0, -5, 7]);
		for (const joint of [limb.arm, limb.forearm, limb.hand, limb.shin]) ellipsoid(joint, [4.8, 4.8, 4.8], [0, 0, 0], joints);
	}
	const skeleton = new THREE.Skeleton(bones);
	for (const [name, geometries, colour] of [["Starlight_Surface", surfaces, "#e4ddd1"], ["Starlight_Joints", joints, "#9c9388"]]) {
		const geometry = mergeGeometries(geometries);
		for (const source of geometries) source.dispose();
		const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72 }));
		mesh.name = name; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
		root.add(mesh); mesh.bind(skeleton);
	}
	primeBindPose(root);
	return root;
}

export function disposeProceduralRig(root) {
	if (!root || root.userData.disposed) return;
	root.userData.disposed = true;
	const geometries = new Set(), materials = new Set(), skeletons = new Set();
	root.traverse(node => {
		if (node.geometry) geometries.add(node.geometry);
		for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) materials.add(material);
		if (node.skeleton) skeletons.add(node.skeleton);
	});
	for (const geometry of geometries) geometry.dispose();
	for (const material of materials) material.dispose();
	for (const skeleton of skeletons) skeleton.dispose();
}

export function proceduralRestDocument(model = 'x-bot-tpose') {
	const rig = createProceduralRig(model); rig.updateMatrixWorld(true);
	const joints = CSKEL27_JOINTS.map((name, index) => {
		const bone = rig.getObjectByName(`mixamorig${name}`);
		const matrix = bone ? new THREE.Matrix3().setFromMatrix4(bone.matrixWorld).elements : null;
		return { name, index, matched_bone: bone?.name ?? null, rest: matrix ? [[matrix[0], matrix[3], matrix[6]], [matrix[1], matrix[4], matrix[7]], [matrix[2], matrix[5], matrix[8]]] : null };
	});
	disposeProceduralRig(rig);
	return { schema: 'cskel27.rest.v1', rig: model, source: { ...PROCEDURAL_RIG_SOURCE }, joints, missing: joints.filter(joint => !joint.rest).map(joint => joint.name) };
}
