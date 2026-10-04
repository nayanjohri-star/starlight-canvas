import { useEffect, useMemo } from "react";
import * as THREE from "three";

/**
 * The blocking set: an open stage floor.
 *
 * The set used to be a two-walled room corner, which kept AI blocking frames
 * enclosed but boxed the camera and capped how far a run or a chase could be
 * staged. The walls are gone: the stage is now a near-infinite open deck —
 * large enough that no ordinary blocking ever meets its edge — and enclosure,
 * when a shot needs it, comes from placed set pieces instead of the stage.
 *
 * Dimensions are metres. The floor is deliberately finite (a plane, not a
 * shader-infinite grid) so exports keep a clean horizon and the framing math
 * never meets an unbounded surface.
 */

// Bright enough to sit clearly above the grid lines: the deck reads as a lit
// surface with lines drawn ON it, not as a dark line-texture tiling to the fog.
//
// Lit, not unlit. An unlit deck renders one flat colour across its whole 500 m,
// which costs an exported blocking frame two depth cues at once: the falloff
// that says how far away the floor is, and the contact shading that says the
// subject is standing ON it rather than floating. The colour is lifted to
// compensate for the shading the lambert term now applies, so the deck keeps
// the same on-screen brightness it had while unlit.
const FLOOR = "#fffdf7";

export const STAGE_SIZE = 500;

/** Metres per grid tile; one heavy line per tile, minor lines every metre. */
const TILE_M = 10;

/**
 * The measuring grid, drawn INTO the deck rather than floating above it.
 *
 * A GridHelper is a separate object a couple of millimetres over a 500 m
 * plane, and at that separation it loses to the floor across almost the whole
 * frame — it survives only where the surface is grazed near the horizon, which
 * is exactly where it is useless. Baking the lines into the floor's own map
 * ends the contest: the marks ARE the surface, so they cannot z-fight with it,
 * cannot be sorted behind it, and shade and fog exactly as the deck does.
 */
function makeGridTexture() {
	const PX = 1024;
	const pxPerM = PX / TILE_M;
	const canvas = document.createElement("canvas");
	canvas.width = PX;
	canvas.height = PX;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, PX, PX);
	ctx.strokeStyle = "rgba(120, 110, 92, 0.34)";
	ctx.lineWidth = 2;
	for (let m = 1; m < TILE_M; m += 1) {
		const p = Math.round(m * pxPerM) + 0.5;
		ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, PX); ctx.stroke();
		ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(PX, p); ctx.stroke();
	}
	// The ten-metre lines carry the scale read, so they stay heavier.
	ctx.strokeStyle = "rgba(96, 86, 68, 0.6)";
	ctx.lineWidth = 5;
	ctx.strokeRect(0, 0, PX, PX);
	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.repeat.set(STAGE_SIZE / TILE_M, STAGE_SIZE / TILE_M);
	texture.anisotropy = 8;
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

export function Room() {
	const grid = useMemo(() => makeGridTexture(), []);
	const cleanExportMaterial = useMemo(() => new THREE.MeshLambertMaterial({ color: FLOOR }), []);
	useEffect(() => () => grid.dispose(), [grid]);
	useEffect(() => () => cleanExportMaterial.dispose(), [cleanExportMaterial]);
	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow userData={{ cleanExportMaterial }}>
				<planeGeometry args={[STAGE_SIZE, STAGE_SIZE]} />
				<meshLambertMaterial color={FLOOR} map={grid} />
			</mesh>
		</group>
	);
}

/** Key/fill/rim rig tuned so a clay figure keeps readable form from any angle.
 * The key is the USER'S light: `keyLight` carries its grabbable position and
 * the rig's master brightness — fill and rim ride the same dimmer so turning
 * the key down darkens the whole stage instead of flattening it. */
// Warm/cool slider → light colour. 0.5 is the tuned default (#fff8e8);
// 0 pulls toward cool daylight, 1 toward sunset amber.
export function keyLightColor(warmth = 0.5) {
	const w = Math.max(0, Math.min(1, warmth ?? 0.5));
	const base = new THREE.Color("#fff8e8");
	if (w < 0.5) return base.clone().lerp(new THREE.Color("#e8f0ff"), (0.5 - w) * 2).getStyle();
	if (w > 0.5) return base.clone().lerp(new THREE.Color("#ffc27a"), (w - 0.5) * 2).getStyle();
	return "#fff8e8";
}

/**
 * `neutral` is the grid-view rig (Blender's workbench studio light idea):
 * the clay hemisphere fakes a warm bounce off the ivory deck, and with the
 * deck gone that bounce reads as mud against the dark void. Neutral mode
 * swaps it for a white sky over a void-dark ground and lifts the ambient so
 * authored colours stay saturated without any pretend floor.
 */
export function StageLights({ keyLight = { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 }, neutral = false }) {
	const dim = keyLight.intensity / 1.12;
	return (
		<>
			<hemisphereLight
				args={neutral ? ["#ffffff", "#3a3d42", 0.9] : ["#fffdf6", "#d8d0c3", 0.9]}
				intensity={0.9 * Math.min(1, 0.35 + 0.65 * dim)}
			/>
			<ambientLight intensity={(neutral ? 0.34 : 0.18) * Math.min(1, 0.35 + 0.65 * dim)} />
			{/* Only the key casts: one soft, unambiguous contact shadow reads as
			    ground contact, while three overlapping shadows read as noise. The
			    map covers the blocking area rather than the whole 500 m deck — a
			    stage-wide frustum would spend its resolution on empty floor. */}
			<directionalLight
				color={keyLightColor(keyLight.warmth)}
				position={[keyLight.x, keyLight.y, keyLight.z]}
				intensity={keyLight.intensity}
				castShadow
				shadow-mapSize-width={2048}
				shadow-mapSize-height={2048}
				shadow-camera-left={-14}
				shadow-camera-right={14}
				shadow-camera-top={14}
				shadow-camera-bottom={-14}
				shadow-camera-near={0.5}
				// Verified edge case (research C5): the user-clamped light corner
				// (30,30,30) sits 52 m from the origin — far 40 used to clip every
				// shadow there. 60 covers the clamp envelope with headroom.
				shadow-camera-far={60}
				shadow-bias={-0.0006}
				shadow-normalBias={0.02}
			/>
			<directionalLight color="#dff6f7" position={[-6, 4, -4]} intensity={0.36 * dim} />
			<directionalLight color="#ffffff" position={[2, 3, 9]} intensity={0.22 * dim} />
		</>
	);
}
