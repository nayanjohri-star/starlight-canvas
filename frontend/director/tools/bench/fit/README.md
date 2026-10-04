# F0-F5 cumulative fitting bench (#432)

```sh
node tools/bench/fit-bench.mjs \
  --input /path/to/evidence/gt \
  --extract /path/to/evidence/exp1/extract \
  --poses /path/to/evidence/prep/gt-motions \
  --out /path/to/evidence/exp2/fit \
  --variant shaded --host yun@ubuntu-baremetal \
  --motions walk,run,turn,sit,standup,jump,pickup,stepup

# Native YOLO/ViTPose on the grey mannequin. F0 exists in T2; if F1
# yolo-vitpose+fmm is absent, fit-bench extracts it serially with --host.
node tools/bench/fit-bench.mjs \
  --input /path/to/evidence/gt --extract /path/to/evidence/exp1/extract \
  --poses /path/to/evidence/prep/gt-motions --out /path/to/evidence/exp2/fit-skin \
  --variant skin --base-condition yolo-vitpose --host yun@ubuntu-baremetal

# Evaluation ONLY. This program's output is never consumed by fitting.
node tools/bench/fit-sanity.mjs /path/to/evidence/exp2/fit /path/to/evidence/prep/gt-motions
```

Each `<out>/<motion>/F0..F5/motion.npz` is a normal cskel27 archive:
`local_rot_mats`, `root_positions`, `posed_joints`, `fps`, with production's
optional `bone_scale` / `person_scale`. `result.json` records provenance,
registration, configuration, contact diagnostics and deviations. Camera evidence
is saved to `<out>/<motion>/incam.npz`, with its run log and cache manifest.
A different variant or base condition needs a different output root. Existing
mismatched results are rejected, not silently overwritten. `--base-condition`
defaults to `prod` (the existing F0/F1 motion bytes are unchanged); it accepts a
T2 base condition without `+fmm`. F0 is copied from that condition and F1 from
the same condition with `+fmm`. T2 already supports `yolo-vitpose+fmm` for direct
runs. If only F1 is missing, the CLI invokes T2 for that one motion/variant/
condition after the idle-GPU check. It never substitutes F0 for missing F1.

## Information boundary

**No fitting stage reads or measures GT intermediate motion.** The allowed
inputs are extracted video motion, known camera, known character body, the
user's two endpoint poses and scene geometry. `readEndpoints` decodes a source
archive but exposes only its first/last rotation matrices and roots. It never
examines intermediate arrays, joint trajectories or GT body measurements. A
test poisons all other source data and exercises the real CLI successfully.
`fit-sanity.mjs` is a separate read-only evaluator and is the only code here
that consumes the complete reference trajectory.

| Stage | New information | Operation |
|---|---|---|
| F0 | None | Byte-identical T2 `<base-condition>/motion.npz` (default `prod`). |
| F1 | Known focal | Byte-identical T2 `<base-condition>+fmm/motion.npz`. |
| F2 | Known static OpenCV camera extrinsics | Register the first F1 pelvis/orientation to the predicted camera-space pelvis/orientation, then apply the same rigid transform to every frame. |
| F3 | Known character bone factors | Regenerate FK from F2 rotations with canonical offsets times the character's factors. Defaults to all ones, equivalent to `boneScale:1`. |
| F4 | User's A and B poses only | Slerp local rotations toward A/B; smoothstep endpoint root-offset ramps. Default 0.5 s, capped at half the clip. |
| F5 | Floor Y=0 and optional axis-aligned boxes | Low/slow stance detection, rigid support locking, floor and skeletal bone/box penetration resolution. |

## F2: why one static registration

The new `cclay_bench_extract_incam.py` imports the box's **unchanged**
`cclay_gvhmr_extract.py` and runs its `main()` under the same imported
`FastRuntime` and `trajectory_job` wrappers as the production worker. It passes
`--static-cam`, known `--f-mm`, production detector/keypoint flags, and
production smoothing sigma. It does not copy the model or preprocessing
pipeline and does not edit anything in the GVHMR checkout. For a direct T2
condition such as `yolo-vitpose`, the camera launcher uses the same YOLO and
ViTPose flags and **does not** enable `FastRuntime` or `trajectory_job`. The
bench-only `--bench-direct` switch is removed before calling the runner. This
keeps camera evidence matched to F1 rather than quietly using palette evidence
for a YOLO fit. The condition is included in cache signatures and result metadata.

The launcher adds the raw in-camera SMPL-X parameters and recomputes the
camera pelvis with the same SMPL-X -> SMPL mesh regressor as the runner.
**SMPL model `transl` is not its mesh-regressed pelvis**, so substituting it
would introduce a shape-dependent translation error. It smooths camera pelvis
and root orientation with the runner's own `smooth_motion_params`.

All transforms multiply column vectors. Added NPZ members:

| Member | Shape | Meaning |
|---|---|---|
| `incam_raw_global_orient`, `incam_raw_transl` | T,3 | Raw camera-space SMPL-X model parameters. |
| `incam_raw_body_pose`, `incam_raw_betas` | T,63 / T,10 | Raw model articulation and shape. |
| `incam_global_orient`, `incam_pelvis` | T,3 | Smoothed camera orientation and mesh-regressed pelvis. |
| `ayfz_to_camera` | T,4,4 | Per-frame relation between output ayfz pelvis/orientation and the camera prediction. |
| `ay_to_ayfz` | 4,4 | Runner's exact pre-smoothing normalization, including floor and heading. |
| `ay_global_orient`, `ay_transl` | T,3 | Raw predicted gravity-aligned model parameters. |
| `K_fullimg` | T,3,3 | Intrinsics actually used by GVHMR. |

The per-frame `ayfz_to_camera` is diagnostic. Camera-space depth and the
integrated global trajectory can disagree even with a static camera. Applying
the entire time-varying relation would replace F1's trajectory with noisy
monocular camera translation. Instead F2 preserves production's trajectory
(including stabilization/contact anchoring and any descent/floor correction)
and only fixes its initial reference frame:

```
R_f1_to_cam = R_incam[0] * transpose(R_f1[0])
R = transpose(R_world_to_cam) * R_f1_to_cam
p_world = transpose(R_world_to_cam) * (p_incam[0] - t_world_to_cam)
t = p_world - R * p_f1[0]
p_F2[f] = R * p_F1[f] + t
```

Only the Hips local rotation is multiplied by `R`; child local rotations are
unchanged. All positional channels get the same SE(3). No GT roots, floor
alignment, heading search, scale search or Procrustes fit enters F2. Camera
JSON must be static and a proper rigid OpenCV transform. Its `worldToCamera`
(y down, z forward), not the Three/OpenGL matrix, is inverted. Camera evidence
intrinsics must agree with the known focal.

## Deliberate conversion deviations

- F0/F1 are untouched production archives: `smplToCskel27Motion`,
  `stabilizeMotion`, and `guardTrajectoryFloor` have already run in T2.
- F2 is cumulative on **that F1**, not a fresh conversion of the additional
  inference. The new inference supplies camera evidence only. Its first
  pelvis replaces production's arbitrary initial floor datum; re-grounding
  here would undo camera placement. Static registration uses one frame and
  inherits that frame's monocular depth/orientation uncertainty.
- F3 keeps F2's root in metres and `personScale=1`; it does not scale the
  camera translation to compensate for changed body proportions. It rebuilds
  positions by FK, avoiding production's independently smoothed joint arrays
  when those disagree with constant bone lengths. There is no second
  stabilization, foot anchoring or percentile-floor pass.
- Character factors default to canonical cskel27 (all ones), not a fresh
  measurement of the rendered y-bot mesh. `--body body.json` accepts the known
  character's 27 positive per-bone factors. This follows the issue's
  `boneScale:1` option and leaves playback's own rig mapping intact.
- F4 preserves F3 bone lengths and uses source NPZ first/last poses exactly as
  requested. The last source frame is pinned even when rate conversion puts
  the last rendered sample slightly before it (180@30 vs 144@24).
- F5 is a **skeletal**, not skinned-mesh, constraint pass. One support point at
  a time is locked by rigid root translation, preserving rotations and bone
  vectors. Eligible feet/toes are within 4 cm of a known surface and move at
  <=0.18 m/s for >=0.08 s. A hand can support on a known box face; no box means
  no invented hand contact. Smoothstep bridges carry offsets between runs.
  Simultaneous two-foot or hand/foot contacts are not a multi-effector IK solve.
- Box collision tests include open-interior bone segments, not just joints.
  On collision a conservative root shift clears the whole skeleton along a
  separating axis, preserving lengths. No skin radius, self-collision or
  collision-free swept trajectory between frames is claimed. Boxes can force
  substantial displacement. Conflicting projections fail rather than silently
  emit penetrations. Floor/scene safety wins over incompatible locks and A/B
  pins; `sceneOverrides` and `maxLockResidualM` disclose this.

Scene format (`--scene`):

```json
{"boxes":[{"min":[-0.5,0,-0.5],"max":[0.5,1,0.5]}]}
```

## GPU ownership and caches

Wait until other T2 sweeps have finished. The CLI refuses any other GVHMR
Python process, including an idle persistent worker, and checks `nvidia-smi`
compute memory before upload and again immediately before inference. This is
a safety check, not a lock respected by independently launched jobs; callers
must coordinate those launches. No other process is killed. The bench runs
serially and uses only `/tmp/cclay-fit-*` on the box; the run directory is
removed in success/failure paths, and cleanup failure is an error. Abrupt
process termination or a broken SSH connection can require manual cleanup.

Local camera caches bind the video, focal/flags and deployed code hashes. The
box runner SHA is recorded. The runner is externally managed: if it changes,
use `--force-incam`. `--incam-root` supplies already extracted
`<root>/<motion>/incam.npz` without touching the GPU (also the CPU integration
test path).

## Verification and sanity metric

```sh
node test/verify-fit-bench.mjs
npm run build                  # dist is required by an existing suite
node tools/run-tests.mjs
```

Tests cover camera inverse and proper-rotation validation, rigid trajectory
registration, body/FK preservation, endpoint slerp and antipodes, short clips,
falloff boundaries, floor and stance locking, segment/box crossings, bone
length preservation, archive round trips, byte-identical F0/F1, and the real
CLI with poisoned intermediate GT data. No timing waits or external GPU are
needed by tests.

`fit-sanity.mjs` compares output cskel27 `posed_joints` with source NPZ
`posed_joints` at matching seconds (linear interpolation of reference
positions). Root-relative error averages joints 1..26; root error is Hips.
There is **no alignment**. It writes per-motion/per-stage and aggregate tables
in millimetres. These are not official rendered-rig errors: Studio playback
applies rig scale and bind offsets, F2 is scene metres, and the requested F4
source endpoints are native cskel27. Official grading by #431 remains separate.
