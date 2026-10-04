# Cube-contact validation (#454)

Run from this checkout. Requires Node, ffmpeg/ffprobe, Chrome, and installed npm dependencies. Live extraction additionally requires the existing GVHMR installation over SSH. Never run two GPU extractions concurrently.

```sh
E=/Users/yun/ccFalToMocap/evidence/exp3
node tools/bench/exp3.mjs --root "$E" --stage gt
node tools/bench/exp3.mjs --root "$E" --stage gt-path --host yun@ubuntu-baremetal
node tools/bench/exp3.mjs --root "$E" --stage fal
node tools/bench/exp3.mjs --root "$E" --stage summary
```

Defaults are Vite 5194, CDP 9234, and `--variants shaded,skin`. `--motions sit` selects a scenario; `--variants skin` selects only the grey/YOLO path. `--stage all` runs all stages serially. Inputs: `gt-motions/{bump,handon,sit,stepup}.npz` and `gen-log*.json` containing the action prompts. A failed stage exits nonzero; it never substitutes a guessed motion or passes a failed extraction into fitting. Completed extraction/scoring artifacts can be reused; use a fresh evidence directory after changing inputs or derivation code (the driver is not a content-addressed cache).

## Renderer

```sh
node tools/gt-render/render.mjs --out /tmp/example --port 5194 --cdp-port 9234 \
  --azimuth 30 --elevation 5 --f-mm 35 --keep-frames \
  --scene-box '{"x":0,"z":1,"rot":0,"sx":0.5,"sy":0.4,"sz":0.5}' motion.npz
```

`scaleX/scaleY/scaleZ` aliases are accepted. Studio scale/position bounds are validated at the CLI boundary (sizes 0.1..100 m), and yaw is normalized. Sizes are metres; the library cube is 1 m on each axis. Base is on Y=0, footprint centred on X/Z, rotation is yaw degrees about +Y. The single QA-hook line exposes only the existing Studio place and update operations. A scene prop's committed scale is checked before capture; clamped unsupported values fail instead of recording inaccurate dimensions. `scene.json` is written at the motion root and beside each `camera.json`. Rotated boxes record centre/half-extents/yaw and corners; axis-aligned boxes also record min/max. The existing `--box` contact scorer and F5 accept **axis-aligned boxes only**; this experiment derives yaw-zero boxes.

The auto-camera includes both character support over the full clip and all box corners. Masks redraw only the character magenta: the neutral cube remains an occluder but is not included in the character mask. `score.mjs` now reads `scene.json` and places the same visible box in prediction/GT mask renders, including calibrated placements. Without a scene file its old behavior is unchanged.

`--export-vertices --no-video` exports `vertices.f32` (little-endian float32, frame/vertex/XYZ order) and `vertices.json` plus the usual joints/masks. Vertices are world-space CPU-skinned points, not native NPZ joint estimates. `<variant>/contact-sheet.png` shows up to four sampled poses with the eight cube corners/twelve edges projected using the saved camera. `contact-sheet.json` identifies frames.

## Derivation and interpretation

Every span is 0.5 s at the Studio's 24 fps. Sit chooses the lowest sustained hips after the first third; hand-on chooses the lowest sustained mean wrist height in the latter half that permits a skin-safe palm-height table in front of the body (the absolute lowest span can have hands beside the thighs); step-up uses the terminal raised foot; bump uses maximal skin reach along the dominant horizontal travel axis (not necessarily a torso impact). A finite grid of footprint translations around the intended contact is considered, with 0.5 m seat, 0.9 m table, 0.4 m step. For horizontal supports, the top equals the **lowest actual skin vertex within that footprint across the span**. Thus a witness touches exactly and no sampled skin penetrates in that span; vertices lower than the intended contact are never silently discarded. Anatomically poor candidates are reported as warnings, not asserted to be valid motion. A static box cannot force every frame of an imperfect motion to touch. `contact-baseline.json` reports maximum gap as well as minimum gap and penetration; its pass criterion checks every declared contact frame (gap <=3 cm, penetration <=2 cm).

`scenario.json` preserves witness, target height, span, box, prompt, method and uncertainties. Inspect the contact sheet; a small distance alone does not certify sitting, stepping, or palm support. Thin triangle intersections without an enclosed vertex are outside the existing skinned-vertex metric.

GT path runs T2 prod/prod+fmm on shaded and native yolo-vitpose/yolo-vitpose+fmm on skin, fits F0..F5 with the scenario box and matching `--base-condition`, and runs `score.mjs --box` for each step plus GT-as-pred. `gt-path/summary.md` has a variant column (48 rows). Fits, scores and GT-self checks are stored under `gt-path/{fit,score,gt-self}/<variant>/<scenario>/`. It uses RAW box contact (scene safety must not benefit from evaluation-only alignment), aligned root-relative MPJPE, aligned last-frame mean joint error, and aligned IoU. F4 uses only native NPZ endpoint poses, not intermediate GT; rig retargeting/anchoring means these pins are not exact rendered-rig endpoints. F5 is skeletal collision resolution, not skinned-contact optimization.

## fal

```sh
node tools/bench/fal-generate.mjs --scenario "$E/gt/sit" --out "$E/fal/clips" --variant skin --runs 3 --dry-run
```

Live key defaults to `~/ccFalToMocap/.fal-key`, or `--key <file>`. Missing key automatically produces dry-run request records and A/B stills; it never waits for the key. The key is not saved or logged. A and B are first/last decoded GT frames of `--variant shaded|skin` (default shaded), cube included. Clip names include scenario, variant and independent run number. The experiment driver plans 4 scenarios x 2 variants x 3 runs = 24 clips. Requests import the repo's `buildH3LockedPrompt` contract and use `minimax/h3-max-turbo/image-to-video`, 480P, 5 s, disabled prompt expansion. No undocumented seed field is sent: three independent requests, explicitly recorded. The queue polling has no overall deadline, logs every status, and bounds individual HTTP requests. Each clip saves request ID, request metadata, all queue responses, MP4, and provider-reported cost fields. Absent cost is unknown, not zero. Mock tests validate the client contract, not live provider availability.

`--stage fal` generates then extracts and fits available clips. It runs prod/prod+fmm for shaded and yolo-vitpose/yolo-vitpose+fmm for skin, supplying true F0/F1 baselines and detector-matched in-camera evidence. Video is normalized to the A-still's 832x480 and 24 fps without temporal stretching. A changed aspect ratio (>1%) fails; unchanged framing is an explicit unverified H3 assumption. F4 pins the original A/B GT poses to the fal clip endpoints; F5 receives the box. **No intermediate fal motion GT exists**, so no MPJPE/trajectory-GT claims are made. Each F step is evaluated for first/last world joint error against A/B, whole-clip skin distance/penetration (contact timing unknown), and same-camera unaligned mask IoU.

Palette segmentation is a coloured-pixel proxy: max(R,G,B)-min(R,G,B) >=35; HSV saturation >=0.25; value >=0.18, on decoded RGB bytes. Neutral cube/floor/shadows are excluded; saturated hallucinations are included and desaturated body pixels can be lost. It is not semantic segmentation. Threshold boundary tests are deterministic.

For skin clips, segmentation is **background difference**, not colour: compare each decoded RGB frame against the GT's `plate.png` (same fixed A-still camera, cube present, character hidden). A pixel is foreground if any channel changes by >=30/255. Moving shadows, lighting drift, compression and generated set changes can contaminate this proxy; no semantic or camera-drift correction is claimed. Shaded and skin IoUs use different proxies and should not be compared as identical measures.

`qa-pack/<scenario>-<variant>-<run>.mp4`: fal | F5 Studio render with cube | 50% blend, same camera/time. `qa-pack/ratings.csv` has empty human rating columns (`prompt_adherence_0_2,contact_natural_0_2,usable_without_fix_YN,notes`), and resumed runs preserve existing ratings. No pack video is fabricated when generation is pending.

## Validation

```sh
node test/verify-cube-contact.mjs
npm run build
node tools/run-tests.mjs
```

Pure tests cover support witness/nonpenetration, sustained spans, all scenario derivations, rotated box coordinates, independent Three camera projection, segmentation thresholds, request fields, and mocked queue completion/errors. No fixed sleeps or live network calls occur in these tests.
