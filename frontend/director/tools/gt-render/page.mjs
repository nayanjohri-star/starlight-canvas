/**
 * Code that runs INSIDE the Studio page (#428). `installPageHelpers` is
 * serialised with Function.prototype.toString and evaluated in the page, so it
 * must not reference anything from this module's scope: every dependency
 * (the support reduction from camera-math.mjs, the joint table) is passed in.
 *
 * It only reads the Studio through the `window.__cozyclay` QA hook and the
 * Three objects that hook exposes. Besides scrub/part colours it makes two
 * transient writes, both undone before the call returns: hiding the rig for
 * the background plate, and swapping the rig's materials to unlit magenta for
 * the silhouette mask capture.
 */

/** The unlit colour the mask capture paints the character with. */
export const MASK_RGB = [255, 0, 255];

/** Rig bones written to joints.json, in cskel27 order where one exists. The
 * Mixamo spine has one segment fewer than cskel27, so Mixamo Spine/Spine1/
 * Spine2 are the cskel27 Spine1/Spine2/Spine3 joints (src/ardy/playback.js).
 * The Mixamo end sites (HeadTop_End, Toe_End) are left out: they sit outside
 * the skin, so they are not points on the drawn body. */
export const RIG_JOINTS = [
	["Hips", "Hips"], ["Spine", "Spine1"], ["Spine1", "Spine2"], ["Spine2", "Spine3"],
	["Neck", "Neck"], ["Head", "Head"],
	["RightShoulder", "RightShoulder"], ["RightArm", "RightArm"], ["RightForeArm", "RightForeArm"], ["RightHand", "RightHand"],
	["LeftShoulder", "LeftShoulder"], ["LeftArm", "LeftArm"], ["LeftForeArm", "LeftForeArm"], ["LeftHand", "LeftHand"],
	["RightUpLeg", "RightUpLeg"], ["RightLeg", "RightLeg"], ["RightFoot", "RightFoot"], ["RightToeBase", "RightToeBase"],
	["LeftUpLeg", "LeftUpLeg"], ["LeftLeg", "LeftLeg"], ["LeftFoot", "LeftFoot"], ["LeftToeBase", "LeftToeBase"],
].map(([bone, cskel27]) => ({ bone: `mixamorig${bone}`, cskel27 }));

export function installPageHelpers(supportValues, rigJoints, maskRgb, boxContactValues) {
	const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
	const hook = () => window.__cozyclay;
	let orientation = null;

	/** Every bone of the rig by name. Mixamo FBX nests an identity copy of
	 * each bone and every skinned mesh has its own skeleton, so a name has
	 * several Bone objects; the first one a skinned mesh deforms with comes
	 * first. End sites (HeadTop_End, Toe_End) deform nothing and only exist in
	 * the hierarchy. readJoints asserts that all copies coincide. */
	function skinBones(rig) {
		const skinned = [];
		rig.traverse((node) => {
			if (node.isSkinnedMesh) skinned.push(node);
		});
		if (!skinned.length) throw new Error("active rig has no skinned mesh");
		const byName = new Map();
		const add = (bone) => {
			const list = byName.get(bone.name) ?? [];
			if (!list.includes(bone)) list.push(bone);
			byName.set(bone.name, list);
		};
		for (const mesh of skinned) mesh.skeleton.bones.forEach(add);
		rig.traverse((node) => {
			if (node.isBone) add(node);
		});
		return byName;
	}

	function visibleMeshes(rig) {
		const meshes = [];
		rig.traverseVisible((node) => {
			if (node.isMesh && node.layers.isEnabled(0)) meshes.push(node);
		});
		return meshes;
	}

	/** Scrub to `frame` and wait until the Studio has applied it: the hook
	 * reports the frame, then two animation frames so the pose effect and a
	 * paint have run on it. Already on the frame (e.g. right after a rig
	 * rebuild) it steps away first, so the pose is always freshly applied. */
	async function moveTo(frame) {
		hook().scrub(frame);
		for (let i = 0; i < 600 && hook().tlFrame !== frame; i += 1) await raf();
	}

	async function settle(frame) {
		hook().pause();
		if (hook().tlFrame === frame && hook().frameCount > 1) await moveTo(frame === 0 ? 1 : 0);
		hook().scrub(frame);
		for (let i = 0; i < 600 && hook().tlFrame !== frame; i += 1) await raf();
		if (hook().tlFrame !== frame) throw new Error(`timeline did not reach frame ${frame} (at ${hook().tlFrame})`);
		await raf();
		await raf();
		const rig = hook().rigA;
		rig.updateMatrixWorld(true);
		return rig;
	}

	function readJoints(rig) {
		const bones = skinBones(rig);
		const out = [];
		const v = new rig.position.constructor();
		const other = new rig.position.constructor();
		for (const { bone } of rigJoints) {
			const copies = bones.get(bone);
			if (!copies) throw new Error(`rig has no bone ${bone}`);
			copies[0].getWorldPosition(v);
			for (const copy of copies.slice(1)) {
				const gap = copy.getWorldPosition(other).distanceTo(v);
				if (gap > 1e-6) throw new Error(`bone copies of ${bone} disagree by ${gap} m`);
			}
			out.push(v.x, v.y, v.z);
		}
		return out;
	}

	/** Every vertex the capture can draw of this rig (skinned on the CPU with
	 * the same bone matrices the GPU uses), in world metres. */
	function rigVertices(rig) {
		const meshes = visibleMeshes(rig);
		let total = 0;
		for (const mesh of meshes) total += mesh.geometry.attributes.position.count;
		const points = new Float64Array(total * 3);
		const v = new rig.position.constructor();
		let offset = 0;
		for (const mesh of meshes) {
			const count = mesh.geometry.attributes.position.count;
			for (let i = 0; i < count; i += 1) {
				if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v);
				else v.fromBufferAttribute(mesh.geometry.attributes.position, i);
				v.applyMatrix4(mesh.matrixWorld);
				points[offset++] = v.x;
				points[offset++] = v.y;
				points[offset++] = v.z;
			}
		}
		return points;
	}

	/** A clone of the shot camera set up exactly as captureFramingPng +
	 * createExportCapture set theirs, for an independent projection check. */
	function captureCamera(framing, output) {
		const cam = hook().shotCam.clone();
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		cam.rotation.order = "YXZ";
		cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg;
		cam.aspect = output.width / output.height;
		cam.updateProjectionMatrix();
		cam.updateMatrixWorld(true);
		return cam;
	}

	window.__gtRender = {
		state: () => {
			const c = hook();
			const rig = c?.rigA;
			let vertexColors = null;
			rig?.traverse((node) => {
				if (node.isSkinnedMesh && vertexColors === null) vertexColors = !!node.material?.vertexColors;
			});
			const cam = c?.shotCam;
			return {
				ready: !!(c && c.motion && rig && typeof c.captureFraming === "function"),
				motionUrl: c?.motion?.url ?? null,
				frameCount: c?.frameCount ?? null,
				fps: c?.motion?.fps ?? null,
				characterModel: c?.characterModel ?? null,
				characterScale: c?.characterScale ?? null,
				rigUuid: rig?.uuid ?? null,
				// Where playback put frame 0 of the take (scene metres) and the
				// Character group's yaw: the pivot of a scene-calibration yaw.
				motionAnchor: c?.motion ? { x: c.motion.anchorX ?? null, z: c.motion.anchorZ ?? null, rotationDeg: c.motion.rotationDeg ?? null } : null,
				vertexColors,
				shotCam: cam ? { zoom: cam.zoom, filmOffset: cam.filmOffset, view: cam.view, near: cam.near, far: cam.far } : null,
			};
		},
		placeBox: async (b, offset) => {
			const { id } = hook().sceneObject.place({ kind: "cube", x: b.x - offset.x, y: -offset.y, z: b.z - offset.z, rot: b.rot, name: "Bench contact cube" });
			let scene = hook().rigA;
			while (scene.parent) scene = scene.parent;
			const find = () => { let found; scene.traverse(n => { if (n.userData.sceneObjectId === id) found = n; }); return found; };
			const until = async predicate => {
				const end = performance.now() + 10000;
				while (!predicate()) { if (performance.now() > end) throw new Error("Studio cube placement did not settle"); await raf(); }
			};
			await until(find);
			hook().sceneObject.update({ id, scaleX: b.sx, scaleY: b.sy, scaleZ: b.sz });
			await until(() => { const n = find(); return n && Math.abs(n.scale.x - b.sx) < 1e-9 && Math.abs(n.scale.y - b.sy) < 1e-9 && Math.abs(n.scale.z - b.sz) < 1e-9; });
			const n = find(); n.updateWorldMatrix(true, true);
			return { id, position: n.position.toArray(), scale: n.scale.toArray(), yaw: n.rotation.y };
		},
		setOrientation: (R, kx, ky) => {
			orientation = { R, kx, ky };
		},
		/** Pre-pass sample: joints plus the five support values of every
		 * drawable vertex and joint of the frame, and with `box` the signed
		 * distance of the closest skinned vertex to that box. `vertices: false`
		 * skips the CPU skinning (joints only). */
		sample: async (frame, { vertices: withVertices = true, box = null, exportVertices = false } = {}) => {
			if (!orientation) throw new Error("setOrientation first");
			const rig = await settle(frame);
			const joints = readJoints(rig);
			if (!withVertices && !box && !exportVertices) return { joints, support: null, vertexCount: 0, contact: null };
			const vertices = rigVertices(rig);
			const contact = box ? boxContactValues(vertices, box) : null;
			const all = new Float64Array(vertices.length + joints.length);
			all.set(vertices, 0);
			all.set(joints, vertices.length);
			const support = supportValues(all, orientation.R, orientation.kx, orientation.ky);
			return { joints, support, vertexCount: vertices.length / 3, contact, ...(exportVertices ? { vertices: Array.from(vertices) } : {}) };
		},
		/** Render one timeline frame through the real export path and read the
		 * joints of the exact pose it drew. `withColour: false` skips the
		 * colour capture (mask-only renders). */
		capture: async (frame, framing, output, withMask, withColour = true) => {
			const rig = await settle(frame);
			const joints = readJoints(rig);
			const png = withColour ? hook().captureFraming(framing, output) : null;
			if (withColour && (typeof png !== "string" || !png.startsWith("data:image/png;base64,"))) throw new Error(`captureFraming returned no PNG for frame ${frame}`);
			let mask = null;
			if (withMask) {
				// Same pose, same camera, character drawn unlit in one colour no
				// lit scene pixel can take: the exact silhouette of this frame.
				// Three is not a page global, so the rig's own MeshStandardMaterial
				// class is reused: black + metalness 1 zeroes diffuse and specular
				// (F0 = colour), leaving only the emissive, untone-mapped, unfogged.
				const swapped = visibleMeshes(rig).map((mesh) => [mesh, mesh.material]);
				const standard = swapped.map(([, material]) => material).find((material) => material?.isMeshStandardMaterial);
				if (!standard) throw new Error("rig has no MeshStandardMaterial to build the mask material from");
				const flat = new standard.constructor({ color: 0x000000, metalness: 1, roughness: 1, envMapIntensity: 0, toneMapped: false, fog: false });
				flat.emissive.setRGB(maskRgb[0] / 255, maskRgb[1] / 255, maskRgb[2] / 255, "srgb");
				try {
					for (const [mesh] of swapped) mesh.material = flat;
					mask = hook().captureFraming(framing, output);
				} finally {
					for (const [mesh, material] of swapped) mesh.material = material;
					flat.dispose();
				}
				if (typeof mask !== "string" || !mask.startsWith("data:image/png;base64,")) throw new Error(`mask capture failed for frame ${frame}`);
				mask = mask.slice("data:image/png;base64,".length);
			}
			const cam = captureCamera(framing, output);
			const v = new rig.position.constructor();
			const threeUv = [];
			for (let i = 0; i < joints.length; i += 3) {
				v.set(joints[i], joints[i + 1], joints[i + 2]).project(cam);
				threeUv.push(((v.x + 1) / 2) * output.width, ((1 - v.y) / 2) * output.height);
			}
			return { png: png ? png.slice("data:image/png;base64,".length) : null, mask, joints, threeUv };
		},
		/** The same framing with the character hidden: the background plate. */
		plate: (framing, output) => {
			const rig = hook().rigA;
			const visible = rig.visible;
			rig.visible = false;
			try {
				const png = hook().captureFraming(framing, output);
				return png.slice("data:image/png;base64,".length);
			} finally {
				rig.visible = visible;
			}
		},
		/** Switch part colours and wait for the rebuilt rig to carry them. */
		setPartColours: async (enabled) => {
			hook().setPartColours(enabled, "shaded");
			for (let i = 0; i < 600; i += 1) {
				await raf();
				const state = window.__gtRender.state();
				if (state.ready && state.vertexColors === enabled) return state;
			}
			throw new Error(`part colours did not become ${enabled ? "shaded" : "off"}`);
		},
	};
	return true;
}
