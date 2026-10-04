import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { parseBvh } from '../tools/ardy/bvh-cskel27.mjs';
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from './ardy/cskel27.js';
import { canonicalCskel27Reference } from './ardy/to-cskel27.js';
import { deriveBoneOffsets, forwardKinematics, matMul, matTranspose, quatToMat } from './ardy/convert.js';
import { decodeMotionNpz } from './ardy/npz.js';
import { retimeMotion } from './ardy/retime.js';
import { createMotionEdit } from './ardy/motion-edit.js';
import { POSE_BONES } from './poses.js';

export const ANIMATION_IMPORT_FORMATS = Object.freeze(['bvh', 'fbx', 'npz']);
const reference = canonicalCskel27Reference(), offsets = deriveBoneOffsets(reference.posed_joints, reference.local_rot_mats);
const required = [...POSE_BONES.map(entry => entry.bone.replace(/^mixamorig/, '')), 'LeftToeBase', 'RightToeBase'];
const targetSource = CSKEL27_JOINTS.map(name => name === 'Spine' ? 'Hips' : name === 'Spine1' ? 'Spine' : name === 'Spine2' ? 'Spine1' : name === 'Spine3' ? 'Spine2' : name);
const normalizeName = name => String(name).replace(/^.*mixamorig[:_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
export class AnimationImportError extends Error {
	constructor(code, message, details = {}) { super(message); this.name = 'AnimationImportError'; this.code = code; Object.assign(this, details); }
}
const invalid = (message, details) => new AnimationImportError('invalid-animation', message, details);
function checkClock(frames, fps) {
	if (!Number.isSafeInteger(frames) || frames < 1 || ![24, 30].includes(fps) || frames > fps * 30) throw invalid('Animation requires integer frames at 24/30 fps, at most 30 seconds');
}
function axis(up) {
	if (!['Y', 'Z'].includes(up)) throw invalid('sourceUp must explicitly name Y or Z');
	return up === 'Y' ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
}
const rowMatrix = q => quatToMat([q.w, q.x, q.y, q.z]);
function mapping(bones, jointMap = {}) {
	const names = new Map();
	for (const bone of bones) { const name = normalizeName(bone.name); if (names.has(name)) throw invalid(`Ambiguous skeleton joint ${bone.name}`); names.set(name, bone); }
	for (const name of Object.keys(jointMap)) if (!required.includes(name) && !CSKEL27_JOINTS.includes(name)) throw invalid(`Unknown target joint ${name}`);
	const find = name => names.get(normalizeName(jointMap[name] ?? name));
	const missing = required.filter(name => !find(name));
	if (missing.length) throw new AnimationImportError('missing-joints', `Skeleton is missing joints: ${missing.join(', ')}`, { missing });
	const derived = [];
	const source = targetSource.map(name => {
		let bone = find(name);
		if (!bone && /Hand(End|Thumb1)$/.test(name)) { bone = find(name.startsWith('Left') ? 'LeftHand' : 'RightHand'); derived.push(name); }
		return bone;
	});
	return { source, root: find('Hips'), derived, matched: Object.fromEntries(required.map(name => [name, find(name).name])) };
}

/** Retarget rotation deltas onto the existing canonical 27-joint motion format.
 * Source proportions remain on the source; root travel is metres relative to
 * frame zero. No smoothing, floor detection, model, or service is involved. */
export function skeletonAnimationTake({ bones, sample, frames, fps, sourceUp = 'Y', unitScale = .01, jointMap = {} }) {
	checkClock(frames, fps);
	if (!(unitScale > 0) || !Number.isFinite(unitScale)) throw invalid('unitScale must be finite metres per source unit');
	const map = mapping(bones, jointMap), convert = axis(sourceUp), inverse = convert.clone().invert();
	const bind = map.source.map(bone => bone.getWorldQuaternion(new THREE.Quaternion()).invert());
	const take = { frames, fps, personScale: 1, rotMats: new Float32Array(frames * 243), rootPos: new Float32Array(frames * 3), posedJoints: new Float32Array(frames * 81), editSegments: createMotionEdit(frames) };
	let origin;
	for (let frame = 0; frame < frames; frame++) {
		sample(frame);
		const globals = map.source.map((bone, index) => {
			const delta = bone.getWorldQuaternion(new THREE.Quaternion()).multiply(bind[index]);
			return rowMatrix(convert.clone().multiply(delta).multiply(inverse));
		});
		const locals = globals.map((rotation, index) => CSKEL27_PARENTS[index] == null ? rotation : matMul(matTranspose(globals[CSKEL27_PARENTS[index]]), rotation));
		const root = map.root.getWorldPosition(new THREE.Vector3()).applyQuaternion(convert).multiplyScalar(unitScale);
		origin ??= root.clone(); root.sub(origin); root.y += reference.posed_joints[0][1];
		if (![root.x, root.y, root.z].every(Number.isFinite)) throw invalid('Animation contains a non-finite root');
		const positions = forwardKinematics(locals, offsets, root.toArray());
		take.rootPos.set(root.toArray(), frame * 3);
		for (let joint = 0; joint < 27; joint++) { take.rotMats.set(locals[joint].flat(), (frame * 27 + joint) * 9); take.posedJoints.set(positions[joint], (frame * 27 + joint) * 3); }
	}
	return { take, diagnostics: { matched: map.matched, derived: map.derived, sourceUp, units: 'metres', rootOrigin: origin.toArray(), retarget: 'rotation deltas, canonical proportions, relative root' } };
}

function strictBvh(text) {
	if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) throw invalid('BVH text is missing or exceeds 16 MiB');
	const header = /MOTION\s+Frames:\s+(\d+)\s+Frame\s+Time:\s+([^\s]+)/.exec(text);
	if (!header) throw invalid('BVH motion header is malformed');
	const frames = +header[1], time = +header[2];
	if (!Number.isSafeInteger(frames) || frames < 1 || !(time > 0) || !Number.isFinite(time) || time < 1 / 240 || frames * time > 30.00001) throw invalid('BVH frame clock is invalid or exceeds 30 seconds');
	let balance = 0; for (const token of text.slice(0, header.index).match(/[{}]/g) ?? []) { balance += token === '{' ? 1 : -1; if (balance < 0) throw invalid('BVH hierarchy braces are malformed'); } if (balance) throw invalid('BVH hierarchy is truncated');
	for (const match of text.slice(0, header.index).matchAll(/CHANNELS\s+([^\s]+)/g)) if (!Number.isSafeInteger(+match[1]) || +match[1] < 0 || +match[1] > 6) throw invalid('BVH channel count is unsupported');
	let parsed; try { parsed = parseBvh(text); } catch (error) { throw invalid(`BVH parse failed: ${error.message}`); }
	if (!parsed.joints.length || parsed.joints.length > 512 || parsed.joints[0].parent !== -1) throw invalid('BVH skeleton is invalid');
	for (const [index, joint] of parsed.joints.entries()) {
		if ((index > 0 && (joint.parent < 0 || joint.parent >= index)) || new Set(joint.channels).size !== joint.channels.length || joint.channels.some(channel => !/^[XYZ](rotation|position)$/.test(channel)) || (index > 0 && joint.channels.some(channel => channel.endsWith('position')))) throw invalid(`BVH joint ${joint.name} has unsupported channels or hierarchy`);
	}
	const values = text.slice(header.index + header[0].length).trim().split(/\s+/);
	if (values.length !== parsed.frames * parsed.channelTotal || values.some(value => !Number.isFinite(Number(value)))) throw invalid('BVH motion values are truncated, non-finite, or contain trailing data');
	return parsed;
}

export function importBvhAnimation(text, { fps = 24, sourceUp = 'Y', unitScale = .01, jointMap = {} } = {}) {
	const bvh = strictBvh(text), bones = bvh.joints.map(joint => { const bone = new THREE.Bone(); bone.name = joint.name; bone.position.fromArray(joint.offset); return bone; });
	for (let index = 1; index < bones.length; index++) bones[bvh.joints[index].parent].add(bones[index]); bones[0].updateMatrixWorld(true);
	const frames = Math.round(bvh.frames * bvh.frameTimeS * fps), axes = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
	return skeletonAnimationTake({ bones, frames, fps, sourceUp, unitScale, jointMap, sample(frame) {
		const source = Math.min(bvh.frames - 1, frame / fps / bvh.frameTimeS), lo = Math.floor(source), hi = Math.min(bvh.frames - 1, lo + 1), weight = source - lo; let at = 0;
		for (let index = 0; index < bones.length; index++) {
			const joint = bvh.joints[index], bone = bones[index]; bone.position.fromArray(joint.offset); bone.quaternion.identity();
			for (const channel of joint.channels) {
				const a = bvh.values[lo * bvh.channelTotal + at], b = bvh.values[hi * bvh.channelTotal + at++];
				const value = channel.endsWith('rotation') ? a + (((b - a + 180) % 360 + 360) % 360 - 180) * weight : a + (b - a) * weight;
				if (channel.endsWith('rotation')) bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axes[channel[0]], value * Math.PI / 180));
				else bone.position[channel[0].toLowerCase()] += value;
			}
		} bones[0].updateMatrixWorld(true);
	} });
}

/** The FBX path accepts an actual animated, named compatible skeleton. */
export function animationClipTake(group, clip, options = {}) {
	if (!clip || !Number.isFinite(clip.duration) || clip.duration <= 0) throw invalid('FBX contains no non-empty animation clip');
	const bones = []; group.traverse(node => { if (node.isBone) bones.push(node); });
	const frames = Math.max(1, Math.round(clip.duration * options.fps));
	const rootNames = new Set(['hips', normalizeName(options.jointMap?.Hips ?? 'Hips')]);
	for (const track of clip.tracks) {
		if (!track.times.length || ![...track.values, ...track.times].every(Number.isFinite)) throw invalid(`FBX track ${track.name} has invalid numbers`);
		if (track.name.endsWith('.scale')) throw invalid(`Animated scale is unsupported: ${track.name}`);
		if (track.name.endsWith('.position') && !rootNames.has(normalizeName(track.name.slice(0, -9)))) {
			const initial = track.values.slice(0, 3); if (track.values.some((value, index) => Math.abs(value - initial[index % 3]) > 1e-6)) throw invalid(`Non-root translation is unsupported: ${track.name}`);
		}
	}
	const mixer = new THREE.AnimationMixer(group), action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
	try {
		// Snapshot the untouched bind before the animation action starts.
		return skeletonAnimationTake({ ...options, bones, frames, sample(frame) { if (frame === 0) action.play(); mixer.setTime(frame / options.fps); group.updateMatrixWorld(true); } });
	} finally { mixer.stopAllAction(); mixer.uncacheRoot(group); }
}

export async function importAnimation({ format, source, encoding = 'base64', fps, sourceUp = 'Y', unitScale = .01, jointMap = {}, clipIndex = 0 }) {
	if (!ANIMATION_IMPORT_FORMATS.includes(format)) throw invalid(`Unsupported animation format ${format}`);
	if (![24, 30].includes(fps)) throw invalid('Import target fps must be 24 or 30');
	if (format === 'bvh') {
		const text = encoding === 'text' ? source : new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(source, encoding));
		return importBvhAnimation(text, { fps, sourceUp, unitScale, jointMap });
	}
	const bytes = bytesOf(source, encoding);
	if (format === 'npz') {
		if (sourceUp !== 'Y' || unitScale !== 1) throw invalid('NPZ must use its canonical Y-up metre skeleton; convert other skeleton conventions before NPZ import');
		const decoded = await decodeMotionNpz(bytes); if (decoded.frames / decoded.fps > 30) throw invalid('NPZ animation exceeds 30 seconds');
		const take = retimeMotion(decoded, fps); return { take: { ...take, editSegments: createMotionEdit(take.frames) }, diagnostics: { sourceUp: 'Y', sourceFps: decoded.fps, units: 'metres', retarget: 'validated canonical NPZ' } };
	}
	let group; const urls = new Set(), manager = new THREE.LoadingManager();
	manager.setURLModifier(url => { if (url.startsWith('blob:')) urls.add(url); return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQsAAAAASUVORK5CYII='; });
	try {
		group = new FBXLoader(manager).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''); group.updateMatrixWorld(true);
		if (!Number.isInteger(clipIndex) || clipIndex < 0 || !group.animations[clipIndex]) throw invalid(`FBX animation clip ${clipIndex} is missing`, { availableClips: group.animations.map(clip => clip.name) });
		// This Three loader applies a wrapper rotation to declared Z-up FBX.
		// Retarget from its already corrected world space rather than converting twice.
		const loaderAxisCorrection = sourceUp === 'Z' && Math.abs(group.rotation.x + Math.PI / 2) < 1e-8 && Math.abs(group.rotation.y) < 1e-8 && Math.abs(group.rotation.z) < 1e-8;
		const result = animationClipTake(group, group.animations[clipIndex], { fps, sourceUp: loaderAxisCorrection ? 'Y' : sourceUp, unitScale, jointMap });
		return { ...result, diagnostics: { ...result.diagnostics, sourceUp, loaderAxisCorrection } };
	} finally {
		const geometry = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
		group?.traverse(node => { if (node.geometry) geometry.add(node.geometry); if (node.skeleton) skeletons.add(node.skeleton); for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) { materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value); } });
		for (const value of [...geometry, ...materials, ...textures, ...skeletons]) value.dispose();
		for (const url of urls) URL.revokeObjectURL(url);
	}
}
function bytesOf(source, encoding) {
	if (source instanceof Uint8Array) return source;
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (encoding !== 'base64' || typeof source !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(source) || source.length % 4 || source.length > 256 * 1024 * 1024) throw invalid('Animation source must be bounded base64 bytes');
	const text = atob(source), bytes = Uint8Array.from(text, char => char.charCodeAt(0)); if (!bytes.length) throw invalid('Animation source is empty'); return bytes;
}

/** Explicit spatial metadata conversion. Mesh vertices and model rotation
 * both change basis; cameras retain their optical local frame. */
export function convertAnimationSpatialBundle({ camera = null, path = null, model = null }, sourceUp, unitScale = 1) {
	const rotation = axis(sourceUp), inverse = rotation.clone().invert();
	if (!(unitScale > 0) || !Number.isFinite(unitScale)) throw invalid('Invalid spatial unit scale');
	const vector = (value, scale = unitScale) => { if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw invalid('Spatial vector must contain three finite numbers'); return new THREE.Vector3(...value).applyQuaternion(rotation).multiplyScalar(scale).toArray(); };
	const quaternion = value => { if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite) || Math.hypot(...value) < 1e-12) throw invalid('Invalid spatial quaternion'); return new THREE.Quaternion(...value).normalize(); };
	const mesh = (values, scale) => { if (!(Array.isArray(values) || values instanceof Float32Array) || values.length % 3) throw invalid('Invalid mesh vertex or normal array'); const result = new Float32Array(values.length); for (let at = 0; at < values.length; at += 3) result.set(vector(Array.from(values.slice(at, at + 3)), scale), at); return result; };
	return { sourceUp: 'Y', units: 'metres',
		camera: camera ? { ...camera, position: vector(camera.position), lookAt: vector(camera.lookAt), up: vector(camera.up ?? (sourceUp === 'Y' ? [0, 1, 0] : [0, 0, 1]), 1), ...(camera.quaternion ? { quaternion: rotation.clone().multiply(quaternion(camera.quaternion)).toArray() } : {}) } : null,
		path: path ? path.map(point => ({ ...point, position: vector(point.position) })) : null,
		model: model ? { ...model, position: vector(model.position ?? [0, 0, 0]), quaternion: rotation.clone().multiply(quaternion(model.quaternion ?? [0, 0, 0, 1])).multiply(inverse).toArray(), positions: mesh(model.positions, unitScale), ...(model.normals ? { normals: mesh(model.normals, 1) } : {}) } : null,
	};
}
