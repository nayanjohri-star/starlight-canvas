#!/usr/bin/env python3
"""driver.py — ProjFlow line-edit driver, shipped to the GPU box per run.

CozyClay ships THIS file to the box the same way tools/kimodo/generate.mjs
ships its constraint JSONs: nothing is installed on the box, the scout venv is
the only python, and a run leaves a mkdtemp behind that the wrapper deletes.

WHY A DRIVER AND NOT `demo/run.py`. Contract C7: the two ProjFlow samplers each
carry exactly half of a CozyClay line edit and neither CLI exposes the other
half.

  * `sample_projflow(A=(B,3,T,J) mask, y=values)` preserves source frames
    exactly (S1 measured 4.8e-7 m), but its targets are 3D WORLD points — it has
    no camera, so a drawn screen-space line cannot be expressed at all.
  * `sample_linear_constraints(operator A=(m, 3*T*J), measurement y=(m,))` takes
    a GENERAL dense operator, so a camera row is just another row — but
    `demo/run.py` only ever builds projection rows plus a frame-0 keyframe, so
    "keep the rest of the take" does not exist on that path.

`sample_linear_constraints` is the general one and the cheaper one (S1: ~2.7x
faster per step than the projflow inpainting sampler), and demo/run.py ALREADY
stacks two kinds of row into one operator (projection rows for the lifted joint
+ identity-ish keyframe rows at frame 0). So preserved frames are nothing more
exotic than more rows: one identity row per kept (frame, joint, axis) whose
measurement is the source coordinate. One operator, one pass, both halves.

WHY THE ROWS ARE EXACTLY LINEAR UNDER A PERSPECTIVE CAMERA (contract C6, as
amended after Phase 0). The paper's demo only accepts an orthographic camera and
the plan originally carried an orthographic approximation of CozyClay's shot
camera as a known risk. It is not needed. With

    X_cam = R @ x + t          (R world->camera, t in camera space)
    u = fx * X_cam[0]/X_cam[2] + cx
    v = fy * X_cam[1]/X_cam[2] + cy

the depth division is the only nonlinearity, and multiplying it out cancels it:

    (u - cx) * (R2.x + t2) = fx * (R0.x + t0)
  =>  [fx*R0 - (u-cx)*R2] . x  =  -[fx*t0 - (u-cx)*t2]
  and [fy*R1 - (v-cy)*R2] . x  =  -[fy*t1 - (v-cy)*t2]

Two rows per constrained frame, each with exactly THREE nonzero entries (the
x/y/z columns of the target joint at that frame). u and v are KNOWN — they are
what the artist drew — so nothing here depends on the unknown depth. This is
exact at every focal length, which is why gate GP1's "<1 px" now applies to the
close-up case too.

UNITS. `points2d` and the intrinsics must share ONE unit system; the algebra
above is unit-agnostic as long as they agree. CozyClay sends viewport-normalised
0..1 for both (fx/fy/cx/cy pre-divided by the viewport size), so the reprojection
errors reported in the metadata are in normalised viewport units.

THE COST OF A ROW, AND WHY PRESERVE ROWS ARE SUBSAMPLED. The caller precomputes
a Cholesky of `A A^T + lambda I`, which is m x m — the ROW count, not the column
count, is what has to stay bounded. Freezing a 196-frame take densely would be
196 * 22 * 3 = 12936 rows and a 12936^2 factorisation (670 MB fp32) for
information that is 90% redundant: adjacent frames of a real take are nearly the
same pose. The subsampling policy is documented at `build_preserve_rows`.

OUTPUT. `<out>.npy` (T,22,3) float32 world metres @ 20 fps, HumanML3D 22-joint
order, plus `<out>.meta.json`. POSITIONS ONLY — ACMDM's "Raw" family generates
absolute coordinates and has no rotation channel. Converting to cskel27 (which
must LIFT rotations) is a separate module and deliberately not done here; see
the seam comment in generate.mjs.

TWO RUN MODES, ONE SAMPLER (contract C11). `--source/--line/--out` is the
ONE-SHOT mode above: load the model, edit once, exit. It is the contract of
record and nothing below changes a number it produces. `--serve` is the
RESIDENT mode: load the model ONCE and then answer requests forever on
stdin/stdout, because the measured cost of an edit is 3.9 s of model load
against 1.3 s of sampling and paying the load per drag is what makes the detail
loop feel like a batch job. Both modes call exactly the same `Engine` and
`run_line_edit`, so a warm edit and a cold edit differ in nothing but when the
weights were read (`sample_with_linear_constraints` calls
`torch.manual_seed(seed)` itself, so a seeded request is bit-identical either
way).

THE SERVE PROTOCOL. NDJSON, one request object per stdin line, one response
object per stdout line, arrays as base64 little-endian float32 blobs beside an
explicit shape (a 196-frame source is ~52 KB raw / 69 KB encoded — small enough
that a pipe is the whole transport and there is no port, no tunnel, no file):

  ready (unsolicited, once, after the model is loaded):
    {"type":"ready","protocol":1,"device":"cuda:0","loadSeconds":3.9}
  request:
    {"id":"7","type":"lineEdit","line":{...C6...},
     "source":{"shape":[T,22,3],"data":"<base64 float32>"},
     "steps":100,"ridge":1e-6,"preserveStride":2,"preserveMargin":20,
     "seamPin":2,"seed":0,"cfg":3.0,"preview":false}
    {"id":"8","type":"ping"}      {"id":"9","type":"shutdown"}
  response:
    {"id":"7","ok":true,"result":{"shape":[T,22,3],"data":"<base64>",
                                  "meta":{...the one-shot meta, verbatim...}}}
    {"id":"7","ok":false,"error":{"message":"...","type":"ValueError"}}

STDOUT IS THE PROTOCOL AND NOTHING ELSE. torch, CLIP and the repo's own loaders
all print to stdout, and one stray progress line would desynchronise the stream
for the rest of the session. So `--serve` DUPLICATES fd 1 to a private handle
and then points fd 1 at fd 2 before importing anything: every `print`, every
tqdm bar, every C-level write from a native extension lands on stderr (where
the wrapper forwards it as status), and the only writer to the real stdout is
`_write_message`. A request whose JSON cannot even be parsed is answered with
`"id": null`, which the wrapper reads as a protocol failure — it must, because
an unparseable line means the two sides no longer agree about framing.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

# Bumped when a request or response field changes meaning. The wrapper ships
# THIS file to the box per session, so the two sides cannot drift by more than
# one deploy — the number exists so that a stale resident left over from an
# earlier build is refused loudly instead of answering with the old shape.
PROTOCOL_VERSION = 1


# --- the hml22 skeleton ------------------------------------------------------
#
# HumanML3D / T2M 22-joint order, from `utils.motion_process.t2m_kinematic_chain`
# and SMPL_JOINT_NAMES[0:22]. S2's mapping table is the citation; this is the
# subset the driver actually needs.
HML22_PARENT = (
    -1,  # 0  pelvis
    0,   # 1  left_hip
    0,   # 2  right_hip
    0,   # 3  spine1
    1,   # 4  left_knee
    2,   # 5  right_knee
    3,   # 6  spine2
    4,   # 7  left_ankle
    5,   # 8  right_ankle
    6,   # 9  spine3
    7,   # 10 left_foot   (TOE BASE, not the foot — S2's naming trap)
    8,   # 11 right_foot  (toe base)
    9,   # 12 neck
    9,   # 13 left_collar    (the CLAVICLE — cskel27 LeftShoulder)
    9,   # 14 right_collar
    12,  # 15 head
    13,  # 16 left_shoulder  (the UPPER-ARM ROOT — cskel27 LeftArm)
    14,  # 17 right_shoulder
    16,  # 18 left_elbow
    17,  # 19 right_elbow
    18,  # 20 left_wrist
    19,  # 21 right_wrist
)

NUM_JOINTS = 22

# The joints where independent limbs branch: the pelvis and the spine3 junction
# that carries the neck and both clavicles. An edit frees its limb UP TO its
# anchor and no further, so the body cannot drift while one arm is redrawn.
LIMB_ANCHORS = frozenset({0, 9})

# CozyClay IK track id -> hml22 joint index.
#
# THE JS SIDE IS THE AUTHORING SOURCE (generate.mjs exports the same table and
# writes the resolved `jointId` into line.json); this copy is a GUARD, re-checked
# below, so a stale wrapper shipping the wrong joint fails loudly on the box
# instead of silently editing the wrong limb.
#
# Derived from S2's mapping table by composing the two hops it documents:
# track -> cskel27 target (the pose studio's own table, ik.js) -> hml22 source.
# Two of those hops look like typos and are not:
#   * `leftElbow` is cskel27 LeftForeArm, whose hml22 source is left_elbow (18).
#     A mid-joint track therefore constrains its OWN joint, not its chain's
#     effector: the artist dragged the elbow handle and drew the ELBOW's path,
#     and pinning joint 20 instead would move the wrist along the drawn line and
#     leave the elbow wherever the model liked.
#   * `spine` is cskel27 Spine1, whose hml22 source is spine2 (6) — cskel27 has
#     three spine links between the anchors where hml22 has two.
TRACK_TO_JOINT = {
    # IK effectors
    "leftHand": 20,   # cskel27 LeftHand  <- left_wrist
    "rightHand": 21,  # cskel27 RightHand <- right_wrist
    "leftFoot": 7,    # cskel27 LeftFoot  <- left_ANKLE (10 is the toe base)
    "rightFoot": 8,   # cskel27 RightFoot <- right_ankle
    # mid-chain handles
    "leftElbow": 18,  # cskel27 LeftForeArm  <- left_elbow
    "rightElbow": 19,
    "leftKnee": 4,    # cskel27 LeftLeg <- left_knee
    "rightKnee": 5,
    # FK handles
    "hips": 0,        # cskel27 Hips <- pelvis
    "spine": 6,       # cskel27 Spine1 <- spine2
    "neck": 12,
    "head": 15,
    "leftShoulder": 13,   # cskel27 LeftShoulder is the CLAVICLE <- left_collar
    "rightShoulder": 14,
}

# `chest` is cskel27 Spine2, and Spine2 is one of S2's five FILLED joints: hml22
# has no source for it at all (three cskel27 spine links between Hips and Spine3
# against hml22's two). There is no joint to constrain, so a chest line edit is
# refused by name rather than silently retargeted onto a neighbouring spine
# joint, which would put the drawn line on a curve the artist did not draw.
UNMAPPABLE_TRACKS = {
    "chest": "cskel27 Spine2 has no hml22 source joint (S2: a FILLED joint)",
}


def limb_chain(joint: int) -> frozenset:
    """Joints the edit is allowed to move: `joint`, its descendants, and its
    ancestors up to (not including) the nearest limb anchor.

    For joint 20 (left wrist) this is {13, 16, 18, 20} — the whole left arm from
    the clavicle out. For joint 0 (pelvis) it is the whole body, which is right:
    a hips line edit drags the figure.
    """
    out = {int(joint)}
    # descendants
    changed = True
    while changed:
        changed = False
        for child, parent in enumerate(HML22_PARENT):
            if parent in out and child not in out:
                out.add(child)
                changed = True
    # ancestors, up to the anchor
    node = HML22_PARENT[int(joint)]
    while node is not None and node >= 0 and node not in LIMB_ANCHORS:
        out.add(node)
        node = HML22_PARENT[node]
    return frozenset(out)


def resample_polyline(points, count):
    """Resample an (P,2) polyline to `count` points, arc-index-linearly.

    Deliberately the SAME convention as the repo's own
    `demo/lift/trajectory_io._resample_xy`: uniform parameter over the point
    INDEX (not arc length), linear interpolation. Matching it means a polyline
    that the demo would place at frame t lands on frame t here too, so S1's
    measured 2.4e-7 reprojection number transfers.
    """
    pts = np.asarray(points, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 2:
        raise ValueError(f"points2d must be (P,2), got {pts.shape}")
    if pts.shape[0] < 2:
        raise ValueError("points2d needs at least 2 points")
    if pts.shape[0] == int(count):
        return pts
    t_src = np.linspace(0.0, 1.0, num=pts.shape[0], dtype=np.float32)
    t_dst = np.linspace(0.0, 1.0, num=int(count), dtype=np.float32)
    out = np.empty((int(count), 2), dtype=np.float32)
    out[:, 0] = np.interp(t_dst, t_src, pts[:, 0])
    out[:, 1] = np.interp(t_dst, t_src, pts[:, 1])
    return out.astype(np.float32)


def column_index(axis: int, frame: int, joint: int, *, num_frames: int, num_joints: int) -> int:
    """Column of x[axis, frame, joint] in the flattened (3, L, J) operand.

    Copied from `demo/lift/projection_operator.column_index` rather than
    imported so this file states the layout it depends on; the two are asserted
    equal at startup (see `_assert_column_layout`).
    """
    return (axis * num_frames + frame) * num_joints + joint


def _assert_column_layout(num_frames: int) -> None:
    from demo.lift.projection_operator import column_index as repo_column_index

    for axis, frame, joint in ((0, 0, 0), (1, 3, 7), (2, num_frames - 1, NUM_JOINTS - 1)):
        mine = column_index(axis, frame, joint, num_frames=num_frames, num_joints=NUM_JOINTS)
        theirs = repo_column_index(axis, frame, joint, num_frames=num_frames, num_joints=NUM_JOINTS)
        if mine != theirs:
            raise RuntimeError(
                "column layout drifted from demo/lift/projection_operator.column_index "
                f"({mine} != {theirs}); every row this driver builds would be scrambled"
            )


# --- constraint construction -------------------------------------------------

def build_line_rows(line, *, frames, joint_id):
    """Per-frame affine perspective rows for the drawn polyline.

    Returns (rows, values, frame_indices, uv) where `rows` is a list of
    (col, coefficient) triples-per-row. See the module docstring for the algebra.
    """
    cam = line["camera"]
    fx = float(cam["fx"])
    fy = float(cam["fy"])
    cx = float(cam["cx"])
    cy = float(cam["cy"])
    R = np.asarray(cam["R"], dtype=np.float64)
    t = np.asarray(cam["t"], dtype=np.float64).reshape(3)
    if R.shape != (3, 3):
        raise ValueError(f"camera.R must be 3x3, got {R.shape}")
    if fx == 0.0 or fy == 0.0:
        raise ValueError("camera.fx and camera.fy must be non-zero")

    start = int(line["frameRange"]["start"])
    end = int(line["frameRange"]["end"])
    if not (0 <= start <= end < frames):
        raise ValueError(
            f"frameRange {start}..{end} is outside the source motion's 0..{frames - 1}"
        )
    span = end - start + 1
    uv = resample_polyline(line["points2d"], span)

    R0, R1, R2 = R[0], R[1], R[2]
    rows = []
    values = []
    frame_indices = list(range(start, end + 1))
    for k, frame in enumerate(frame_indices):
        u = float(uv[k, 0])
        v = float(uv[k, 1])
        cols = [
            column_index(axis, frame, joint_id, num_frames=frames, num_joints=NUM_JOINTS)
            for axis in range(3)
        ]
        # u row
        coef_u = fx * R0 - (u - cx) * R2
        rows.append(list(zip(cols, coef_u.tolist())))
        values.append(-(fx * t[0] - (u - cx) * t[2]))
        # v row
        coef_v = fy * R1 - (v - cy) * R2
        rows.append(list(zip(cols, coef_v.tolist())))
        values.append(-(fy * t[1] - (v - cy) * t[2]))
    return rows, values, frame_indices, uv


def build_pin_rows(line, *, frames, joint_id):
    """Hard 3D keyframe rows for `pins3d` — the OTHER shape of a line edit.

    A pin says "this joint is exactly HERE at this generation frame", so it is
    three identity rows (x, y, z) with the pinned coordinates as the
    measurement. That is the sparsest possible constraint and it is precisely
    what the paper measures: ProjFlow's spatial-control table is 1, 2, 5, 49 and
    196 keyframes, with 0.0000 trajectory/location/average error at every
    density, and the flow prior — not any interpolation of ours — is what fills
    the frames between. So there is deliberately NOTHING between the pins here:
    no pseudo-observations, no interpolated guides. The paper's soft
    machinery (Sec 4.3.1) exists to rescue the *inpainting* task where hard
    observations are sparse across a whole clip; here the preserve rows outside
    the range and the seam pin at its edges already bracket the gap, and the
    free span between two pins is a couple of seconds at most.

    Same row format as build_line_rows so the two are interchangeable to the
    caller: (rows, values, frame_indices). A line's rows are TWO per frame and
    depend on the camera; a pin's are THREE and depend on nothing, which is why
    a pinned edit needs no lens and survives an orbit.

    Frames arrive already on the generation clock (line-edit-job.mjs scales
    them with the same rounding rule it uses for frameRange), so the only
    checking here is that they are inside the clip.
    """
    pins = line["pins3d"]
    if not isinstance(pins, list) or not pins:
        raise ValueError("pins3d must be a non-empty list of {frame, position}")
    rows = []
    values = []
    frame_indices = []
    targets = []
    for index, pin in enumerate(pins):
        frame = int(pin["frame"])
        if not (0 <= frame < frames):
            raise ValueError(
                f"pins3d[{index}].frame {frame} is outside the source motion's 0..{frames - 1}"
            )
        position = [float(v) for v in pin["position"]]
        if len(position) != 3:
            raise ValueError(f"pins3d[{index}].position must be [x, y, z], got {pin['position']}")
        for axis in range(3):
            col = column_index(axis, frame, joint_id, num_frames=frames, num_joints=NUM_JOINTS)
            rows.append([(col, 1.0)])
            values.append(position[axis])
        frame_indices.append(frame)
        targets.append(position)
    return rows, values, frame_indices, np.asarray(targets, dtype=np.float64)


def build_preserve_rows(source, *, edit_start, edit_end, chain, stride, margin, seam_pin=2, hold_body=False, owned=()):
    """Identity rows pinning the SOURCE take outside the edited range.

    SUBSAMPLING POLICY — stated in full because it is the one place this driver
    trades exactness for a tractable Cholesky (`A A^T + lambda I` is m x m):

    1. FRAME STRIDE. Only every `stride`-th frame outside the edit range carries
       rows (default 2 => half the rows). Adjacent frames of a real take are
       nearly the same pose, so a pinned frame constrains its neighbour almost
       as hard as pinning it directly would; the flow prior supplies the rest.
       The stride is phase-locked to frame 0 (`range(0, T, stride)`) so two runs
       over the same take pin the same frames.

    2. THE SEAM IS ALWAYS PINNED. The frames immediately either side of the edit
       range are added regardless of stride. That is where a pop would show
       (gate GP2 measures the blend seams, not the preserved interior), so it is
       the one place a missed frame is expensive.

    3. CHAIN EXCLUSION INSIDE A MARGIN. Within `margin` frames of the edit range
       the EDITED LIMB's joints (`chain`) carry no rows, while the rest of the
       body still does. The limb has to travel from where the source take left
       it to the drawn line; pinning it hard right up to the boundary would ask
       for an instantaneous jump and the sampler would split the difference,
       missing the line at its start. Outside the margin every joint is pinned.

    4. SEAM PIN — the edit's OWN first and last `seam_pin` frames carry FULL
       rows, chain included, even though they are inside the edited range.

       This is the fix for a seam pop that rules 1-3 cannot reach, and it is
       licensed by a property the APP now guarantees rather than by anything
       here. src/line-edit.js hands over a curve whose first and last points are
       the joint's own projected trajectory, byte-identical: a drag pins them
       (PINNED_CURVE_ENDS) and a drawn stroke eases into them (seamEaseWeight is
       exactly 0 at both window edges). So at those two frames the drawn line
       and the source take ALREADY agree in 2D, and pinning the full 3D pose
       there adds no contradiction — it removes the freedom in DEPTH and in the
       other 21 joints that was producing the pop.

       Without it those frames are unconstrained except for the line's two
       affine rows, and the nearest hard evidence is a whole frame away on the
       far side of the boundary: the paper's Plain Masking case (sparse hard
       observations, no soft guides), which its own ablation reports as the
       worst configuration.

       MEASURED, backfall take, a 102-frame leftFoot reroute (app frames
       20..122, 20-step preview, seed 4242, cold path). Seam figures are the
       spliced take's frame-to-frame jump at the boundary as a multiple of the
       SOURCE take's own worst frame delta (0.2153 m), so 1.0x means "no more
       violent than the take already is":

         seam_pin  head   tail   worst jump  in-window edit (max / mean)
         0         2.46x  6.64x  6.64x       2.934 / 1.786 m
         1         0.33x  1.70x  4.51x       2.740 / 1.684 m
         2         0.24x  1.06x  3.96x       2.612 / 1.611 m   <- default
         3         0.21x  1.04x  3.00x       2.491 / 1.548 m
         4         0.20x  1.03x  3.03x       2.367 / 1.492 m

       TWO is the default because it is where the seam stops being visible
       (1.06x = the take's own worst frame already) while the edit keeps 89% of
       its magnitude; past 2 the pin buys almost no seam and starts eating the
       edit, since every pinned frame is a frame the drawn line does not own.
       Two also matches the app's PINNED_CURVE_ENDS exactly: those are the
       frames src/line-edit.js already holds on the source trail in 2D, so this
       pins in 3D precisely what the app pinned in 2D. `seam_pin=0` restores the
       pre-2026-08-29 behaviour byte for byte.

    Order of the emitted rows is (frame, joint, axis), ascending, so a run is
    reproducible and `preservedFrames` in the metadata reads in time order.
    """
    frames = int(source.shape[0])
    lo = max(0, int(edit_start) - int(margin))
    hi = min(frames - 1, int(edit_end) + int(margin))

    candidates = set(range(0, frames, max(1, int(stride))))
    for seam in (int(edit_start) - 1, int(edit_end) + 1):
        if 0 <= seam < frames:
            candidates.add(seam)
    kept_frames = sorted(f for f in candidates if f < int(edit_start) or f > int(edit_end))

    # 5. HOLD THE BODY (pins only). Inside the range the non-edited joints keep
    #    their subsampled rows; only the pinned limb's chain is freed.
    #
    #    WHY IT IS ONLY FOR PINS, and why it is not optional for them. A drawn
    #    line replaces a passage of movement, so the body genuinely has to
    #    re-time itself around the new path and freeing the range is the point.
    #    A PIN says the opposite thing — "the take is right, this joint is
    #    wrong at this instant" — and freeing 1.5 s of whole body to deliver it
    #    was measured as exactly the wrong trade: on the backfall take a 5 cm
    #    ask and a 40 cm ask both moved the head ~28 cm and both missed by
    #    ~25 cm, because the pin was a small perturbation on a window the model
    #    had otherwise re-imagined (in-window whole-body drift 1.19 m in every
    #    case, identical to three decimal places).
    #
    #    This is also the paper's own shape for sparse observations. Its
    #    inpainting formulation surrounds sparse hard keyframes with guidance
    #    everywhere else rather than leaving the gap free, and its ablation
    #    reports Plain Masking — hard keyframes alone — as the worst
    #    configuration. Here the guidance is not interpolated pseudo-
    #    observations with a fitted variance: it is the SOURCE TAKE, which is
    #    both hard and correct, so it goes in at Sigma = 0 like every other
    #    preserve row and needs none of the time-varying machinery.
    hold = bool(hold_body)
    if hold:
        inside = sorted(
            f for f in set(range(0, frames, max(1, int(stride))))
            if int(edit_start) <= f <= int(edit_end)
        )
        kept_frames = sorted(set(kept_frames) | set(inside))

    # The seam pin's own frames, taken from INSIDE the range. Capped at half the
    # range so a two-frame edit cannot pin itself into a no-op.
    pin_span = max(0, int(seam_pin))
    span = int(edit_end) - int(edit_start) + 1
    pin_span = min(pin_span, span // 2)
    seam_frames = []
    for offset in range(pin_span):
        seam_frames.append(int(edit_start) + offset)
        seam_frames.append(int(edit_end) - offset)
    seam_frames = sorted(set(f for f in seam_frames if 0 <= f < frames))
    kept_frames = sorted(set(kept_frames) | set(seam_frames))

    # Cells the EDIT's own rows already own. A seam-pin frame that happens to
    # carry a 3D pin would otherwise get an identity row to the source AND a pin
    # row to the target for the same coordinate: two contradictory measurements
    # that the ridge quietly averages into a third answer nobody asked for. The
    # edit always wins — it is the thing the artist authored.
    owned_cells = {(int(f), int(j)) for f, j in owned}

    rows = []
    values = []
    pinned = []  # (frame, joint) pairs, for the self-check below
    for frame in kept_frames:
        in_margin = lo <= frame <= hi
        for joint in range(NUM_JOINTS):
            if (frame, joint) in owned_cells:
                continue
            # A seam frame is pinned WHOLE — the chain exclusion is about giving
            # the limb room to travel, and at the seam it has nowhere to travel
            # to: the line already puts it where the source does.
            if in_margin and joint in chain and frame not in seam_frames:
                continue
            for axis in range(3):
                col = column_index(axis, frame, joint, num_frames=frames, num_joints=NUM_JOINTS)
                rows.append([(col, 1.0)])
                values.append(float(source[frame, joint, axis]))
            pinned.append((frame, joint))
    return rows, values, kept_frames, pinned


def densify(rows, values, *, frames):
    """Materialise the sparse row list into the dense (m, 3*T*J) operator the
    sampler wants. Every row has at most 3 nonzeros, but
    `sample_linear_constraints` takes a dense tensor, so this is where the
    memory goes: m * 3*T*J * 4 bytes."""
    m = len(rows)
    n = 3 * int(frames) * NUM_JOINTS
    A = np.zeros((m, n), dtype=np.float32)
    for index, row in enumerate(rows):
        for col, coefficient in row:
            A[index, col] = coefficient
    return A, np.asarray(values, dtype=np.float32)


def project(points_world, cam):
    """Perspective-project (N,3) world points with the request's camera, in the
    same units the request used. The self-check reprojection number is computed
    with THIS, independently of the rows, so a sign error in the row algebra
    shows up as a large error rather than cancelling itself out."""
    R = np.asarray(cam["R"], dtype=np.float64)
    t = np.asarray(cam["t"], dtype=np.float64).reshape(1, 3)
    cam_pts = points_world.astype(np.float64) @ R.T + t
    z = cam_pts[:, 2]
    u = float(cam["fx"]) * cam_pts[:, 0] / z + float(cam["cx"])
    v = float(cam["fy"]) * cam_pts[:, 1] / z + float(cam["cy"])
    return np.stack([u, v], axis=1)


# --- request validation ------------------------------------------------------

def resolve_joint(line):
    track = line.get("track")
    if not isinstance(track, str) or not track:
        raise ValueError("line.track is required and must be a non-empty string")
    if track in UNMAPPABLE_TRACKS:
        raise ValueError(f"track {track!r} cannot be line-edited: {UNMAPPABLE_TRACKS[track]}")
    if track not in TRACK_TO_JOINT:
        known = ", ".join(sorted(TRACK_TO_JOINT))
        raise ValueError(f"unknown track {track!r}; known line-edit tracks: {known}")
    expected = TRACK_TO_JOINT[track]
    declared = line.get("jointId")
    if declared is not None and int(declared) != expected:
        # See TRACK_TO_JOINT's header: the JS side resolves the joint and this is
        # the guard against a wrapper that has drifted from the driver.
        raise ValueError(
            f"line.jointId {declared} disagrees with track {track!r} -> joint {expected}; "
            "the wrapper and the driver disagree about the skeleton"
        )
    return expected


# --- the loaded model, and the one edit both run modes perform ---------------

def open_repo(repo_path):
    """Put the ProjFlow clone on sys.path AND make it the cwd, then return it.

    Both are required and for different reasons: the repo's modules are imported
    by package path (`demo.common.*`), and its model loader resolves checkpoint
    paths relative to the process's cwd. Called once per process — the serve
    loop must not chdir per request, or a relative path in a request would mean
    something different depending on what ran before it.
    """
    repo = Path(repo_path).expanduser().resolve()
    if not (repo / "demo").is_dir():
        raise SystemExit(f"--repo {repo} does not look like a ProjFlow clone (no demo/)")
    sys.path.insert(0, str(repo))
    os.chdir(str(repo))
    return repo


class Engine:
    """The loaded checkpoint plus the handful of repo functions an edit needs.

    THE WHOLE POINT of contract C11 is that this object outlives a request. S1
    measured the load at 3.9 s against 1.3 s of sampling, so a resident Engine
    is the difference between an 8 s round trip and a 2 s one. Nothing about a
    request mutates it: the operator, the Cholesky and the sample are all built
    per call in `run_line_edit`, and the sampler seeds torch itself, so request
    N+1 cannot inherit anything from request N except the weights.

    The repo imports happen HERE rather than at module scope because they are
    only importable after `open_repo`, and because `import torch` is most of the
    load time — a caller that only wants the argument parser should not pay it.
    """

    def __init__(self, repo, *, model_id, model_name, device):
        import torch  # after open_repo, so the venv's torch is the one that loads
        from demo.common.model_loader import load_acmdm_from_config, resolve_device
        from demo.common.motion_stats import load_22x3_stats, denormalize_world
        from demo.common.normal_equations import precompute_normal_cholesky
        from demo.common.sampling import sample_with_linear_constraints
        from demo.lift.projection_operator import convert_linear_measurement_to_normalized_space

        started = time.time()
        self.torch = torch
        self.repo = repo
        self.device = resolve_device(str(device))
        self.loaded = load_acmdm_from_config(
            {"id": model_id, "name": model_name, "dataset": "t2m"},
            repo_root=repo,
            device=self.device,
        )
        self.mean_np, self.std_np = load_22x3_stats("t2m", repo)
        self.load_seconds = time.time() - started
        self.to_normalized = convert_linear_measurement_to_normalized_space
        self.precompute_normal_cholesky = precompute_normal_cholesky
        self.sample = sample_with_linear_constraints
        self.denormalize_world = denormalize_world


def run_line_edit(
    engine,
    source,
    line,
    *,
    steps,
    ridge,
    preserve_stride,
    preserve_margin,
    seed,
    cfg,
    seam_pin=2,
    preview=False,
    reset_peak=False,
):
    """One line edit against a loaded Engine. Returns (out_world, meta).

    Every number the one-shot mode ever wrote lives in the returned meta, and
    the serve mode returns the same dict verbatim, so a warm result and a cold
    result are indistinguishable to the wrapper.
    """
    torch = engine.torch
    source = np.asarray(source, dtype=np.float32)
    if source.ndim != 3 or source.shape[1] != NUM_JOINTS or source.shape[2] != 3:
        raise ValueError(f"source must be (T,22,3); got {source.shape}")
    frames = int(source.shape[0])
    _assert_column_layout(frames)

    joint_id = resolve_joint(line)
    prompt = str(line.get("prompt") or "")

    # --- fuse the operator ---------------------------------------------------
    # ONE EDIT IS ONE GESTURE (contract C6 v2): either a drawn line (two affine
    # rows per frame, camera-dependent) or 3D pins (three identity rows per pin,
    # camera-free). The wrapper validates the exclusivity; here the presence of
    # pins3d simply selects the row builder, and everything downstream — the
    # preserve rows, the seam pin, the solve, the splice — is identical.
    pinned_edit = line.get("pins3d") is not None
    if pinned_edit:
        line_rows, line_values, line_frames, uv = build_pin_rows(line, frames=frames, joint_id=joint_id)
    else:
        line_rows, line_values, line_frames, uv = build_line_rows(line, frames=frames, joint_id=joint_id)
    chain = limb_chain(joint_id)
    keep_rows, keep_values, kept_frames, pinned = build_preserve_rows(
        source,
        edit_start=int(line["frameRange"]["start"]),
        edit_end=int(line["frameRange"]["end"]),
        chain=chain,
        stride=int(preserve_stride),
        margin=int(preserve_margin),
        seam_pin=int(seam_pin),
        # A pins edit holds the rest of the body through the range; a drawn line
        # frees it, because a stroke replaces a passage of movement and a pin
        # corrects an instant of one. See build_preserve_rows rule 5.
        hold_body=pinned_edit,
        owned=[(f, joint_id) for f in line_frames],
    )
    A_world_np, y_world_np = densify(line_rows + keep_rows, line_values + keep_values, frames=frames)
    m = int(A_world_np.shape[0])

    device = engine.device
    A_world = torch.from_numpy(A_world_np).to(device=device)
    y_world = torch.from_numpy(y_world_np).to(device=device)
    # THE normalisation convention, taken from the repo so there is one spelling
    # of it: x_world = x_norm*std + mean  =>  A' = A diag(std), y' = y - A mean.
    # It is applied to the line rows and the preserve rows TOGETHER, which is the
    # whole point of fusing them into one operator.
    A_norm, y_norm = engine.to_normalized(
        operator_world=A_world,
        measurement_world=y_world,
        mean=torch.from_numpy(np.asarray(engine.mean_np, dtype=np.float32)).to(device=device),
        std=torch.from_numpy(np.asarray(engine.std_np, dtype=np.float32)).to(device=device),
        num_frames=frames,
        num_joints=NUM_JOINTS,
    )

    factor = engine.precompute_normal_cholesky(A_norm, ridge_lambda=float(ridge))

    # An empty prompt with cfg != 1 duplicates the batch to guide toward nothing;
    # on a line edit the constraints carry the intent, so guidance is switched off
    # rather than paid for. A prompt that IS given keeps the demos' cfg.
    cfg_scale = float(cfg) if prompt else 1.0

    if device.type == "cuda":
        # Only the resident asks for this: it makes `vramPeakAllocMiB` the peak of
        # THIS request (the weights stay resident, so they stay in the baseline)
        # instead of a session high-water mark that only ever grows. The one-shot
        # process is its own reset and must keep reporting the load peak it always
        # has.
        if reset_peak:
            torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
    started = time.time()
    result = engine.sample(
        engine.loaded.model,
        prompt=prompt,
        operator=A_norm,
        measurement=y_norm.view(1, -1),
        normal_cholesky=factor.normal_cholesky.to(device=device),
        frames=frames,
        num_joints=NUM_JOINTS,
        num_samples=1,
        seed=int(seed),
        steps=int(steps),
        cfg=cfg_scale,
        device=device,
    )
    if device.type == "cuda":
        torch.cuda.synchronize()
    sampling_seconds = time.time() - started

    out_norm = result.samples_norm[0].permute(1, 2, 0).detach().cpu().numpy()  # (T,J,3)
    out_world = engine.denormalize_world(out_norm, engine.mean_np, engine.std_np).astype(np.float32)

    # --- self-check ----------------------------------------------------------
    # Both numbers are computed from the RESULT, not from the sampler's
    # internals, and the reprojection uses `project()` rather than the rows, so a
    # sign error cannot hide inside its own operator.
    if pinned:
        pin_f = np.asarray([f for f, _ in pinned])
        pin_j = np.asarray([j for _, j in pinned])
        preserved_err = np.abs(out_world[pin_f, pin_j] - source[pin_f, pin_j])
        preserved_max = float(preserved_err.max())
        preserved_mean = float(preserved_err.mean())
    else:
        preserved_max = preserved_mean = 0.0
    if pinned_edit:
        # A pin's own self-check is in METRES, not viewport units: it was
        # authored in world space and there is no lens to project it through.
        # Reported under the same key so the wrapper and the gates read one
        # number whichever gesture produced it; `lineErrUnits` says which.
        line_err = np.abs(out_world[line_frames, joint_id] - uv)
        err_units = "m"
    else:
        reproj = project(out_world[line_frames, joint_id], line["camera"])
        line_err = np.abs(reproj - uv.astype(np.float64))
        err_units = "uv"
    edit_lo = int(line["frameRange"]["start"])
    edit_hi = int(line["frameRange"]["end"])
    edited = np.abs(out_world[edit_lo:edit_hi + 1] - source[edit_lo:edit_hi + 1])

    meta = {
        "m": m,
        "steps": int(steps),
        "ridge": float(ridge),
        "sampling_seconds": round(sampling_seconds, 4),
        "frames": frames,
        "fps": 20,
        "joints": NUM_JOINTS,
        "track": line["track"],
        "jointId": joint_id,
        "prompt": prompt,
        "cfg": cfg_scale,
        "seed": int(seed),
        "preview": bool(preview),
        "gesture": "pins" if pinned_edit else "line",
        "pins": [int(f) for f in line_frames] if pinned_edit else None,
        "rows": {
            "line": len(line_rows),
            "preserve": len(keep_rows),
            "operatorCols": 3 * frames * NUM_JOINTS,
        },
        "preserve": {
            "stride": int(preserve_stride),
            "margin": int(preserve_margin),
            "seamPin": int(seam_pin),
            "holdBody": bool(pinned_edit),
            "frames": [int(f) for f in kept_frames],
            "pinnedJointFrames": len(pinned),
            "freeChain": sorted(int(j) for j in chain),
        },
        "editRange": [int(line["frameRange"]["start"]), int(line["frameRange"]["end"])],
        "checks": {
            # Success criterion (i): pinned source frames come back unchanged.
            "preservedMaxAbsDiffM": preserved_max,
            "preservedMeanAbsDiffM": preserved_mean,
            # Success criterion (ii): the drawn line is followed, in the request's
            # own 2D units.
            "lineMaxReprojErr": float(line_err.max()),
            "lineMeanReprojErr": float(line_err.mean()),
            "lineErrUnits": err_units,
            # Proof the edit is not a no-op: the range genuinely moved.
            "editedMaxAbsDiffM": float(edited.max()),
        },
        "device": str(device),
        "checkpoint": str(engine.loaded.checkpoint_path),
    }
    if device.type == "cuda":
        meta["vramPeakAllocMiB"] = round(torch.cuda.max_memory_allocated() / 2 ** 20, 1)
    return out_world, meta


# --- the resident service ----------------------------------------------------

def decode_array(blob):
    """A {"shape": [...], "data": "<base64 little-endian float32>"} payload -> ndarray.

    The shape is carried explicitly rather than inferred from the byte count
    because a (T,22,3) and a (3,22,T) blob are the same length, and the sampler
    would happily edit the transpose.
    """
    if not isinstance(blob, dict):
        raise ValueError("source must be an object with `shape` and base64 `data`")
    shape = [int(dim) for dim in blob.get("shape") or []]
    if not shape or any(dim < 0 for dim in shape):
        raise ValueError(f"source.shape must be positive integers, got {blob.get('shape')!r}")
    raw = base64.b64decode(blob.get("data") or "", validate=True)
    count = int(np.prod(shape))
    if len(raw) != count * 4:
        raise ValueError(f"source.data is {len(raw)} bytes; shape {shape} needs {count * 4}")
    return np.frombuffer(raw, dtype="<f4").reshape(shape).astype(np.float32)


def encode_array(array):
    """The inverse. C order and float32 are stated in the payload, not assumed:
    the JS side reads the shape back and refuses a result it did not expect."""
    contiguous = np.ascontiguousarray(array, dtype="<f4")
    return {
        "shape": [int(dim) for dim in contiguous.shape],
        "dtype": "float32",
        "data": base64.b64encode(contiguous.tobytes(order="C")).decode("ascii"),
    }


def serve(args) -> int:
    """Load the model once, then answer one NDJSON request per stdin line.

    The loop is deliberately SEQUENTIAL — one request in flight, no threads. A
    single 3070 samples one edit at a time anyway, and the wrapper queues on its
    side, so concurrency here would buy nothing and cost the guarantee that a
    response line always belongs to the request that preceded it.

    EOF ON STDIN IS THE SHUTDOWN SIGNAL. When the wrapper's ssh child dies (or
    is killed on process exit) sshd closes this end and `readline` returns "",
    which ends the loop and drops the checkpoint. That is why the resident needs
    no supervisor on the box and leaves nothing behind.
    """
    # Claim the real stdout BEFORE anything can print to it, and point fd 1 at
    # stderr so that model loading, tqdm and any native extension write where the
    # wrapper treats output as status. See the module docstring.
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    protocol_out = os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")

    def emit(message):
        protocol_out.write(json.dumps(message, separators=(",", ":")) + "\n")
        protocol_out.flush()

    repo = open_repo(args.repo)
    engine = Engine(repo, model_id=args.model_id, model_name=args.model_name, device=args.device)
    emit({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "device": str(engine.device),
        "loadSeconds": round(engine.load_seconds, 3),
        "repo": str(repo),
        "pid": os.getpid(),
    })
    print(f"projflow-serve: ready in {engine.load_seconds:.2f}s on {engine.device}", file=sys.stderr, flush=True)

    served = 0
    while True:
        text = sys.stdin.readline()
        if text == "":
            break
        text = text.strip()
        if not text:
            continue
        try:
            request = json.loads(text)
            if not isinstance(request, dict):
                raise ValueError("a request must be a JSON object")
        except Exception as error:
            # No id means no way to pair this with anything. Answering with a null
            # id is the honest move: the wrapper reads it as a protocol failure,
            # falls back to the cold path and restarts this process.
            emit({"id": None, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}})
            continue

        request_id = request.get("id")
        kind = request.get("type") or "lineEdit"
        try:
            if kind == "ping":
                result = {
                    "pong": True,
                    "protocol": PROTOCOL_VERSION,
                    "device": str(engine.device),
                    "served": served,
                    "loadSeconds": round(engine.load_seconds, 3),
                }
            elif kind == "shutdown":
                emit({"id": request_id, "ok": True, "result": {"bye": True}})
                break
            elif kind == "lineEdit":
                source = decode_array(request.get("source"))
                line = request.get("line")
                if not isinstance(line, dict):
                    raise ValueError("line must be a C6 line-edit object")
                preview = bool(request.get("preview"))
                steps = 20 if preview else int(request.get("steps", 100))
                out_world, meta = run_line_edit(
                    engine,
                    source,
                    line,
                    steps=steps,
                    ridge=float(request.get("ridge", 1e-6)),
                    preserve_stride=int(request.get("preserveStride", 2)),
                    preserve_margin=int(request.get("preserveMargin", 20)),
                    seam_pin=int(request.get("seamPin", 2)),
                    seed=int(request.get("seed", 0)),
                    cfg=float(request.get("cfg", 3.0)),
                    preview=preview,
                    reset_peak=True,
                )
                served += 1
                result = dict(encode_array(out_world))
                result["meta"] = meta
            else:
                raise ValueError(f"unknown request type {kind!r}")
        except Exception as error:  # noqa: BLE001 — a bad request must not end the session
            # The traceback goes to stderr (where the wrapper forwards it as
            # status) and the message goes back on the wire. The loop survives:
            # one malformed line edit is not a reason to pay another model load.
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
            emit({"id": request_id, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}})
            continue
        emit({"id": request_id, "ok": True, "result": result})

    print(f"projflow-serve: stdin closed after {served} edits; exiting", file=sys.stderr, flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser("ProjFlow line-edit driver")
    ap.add_argument("--serve", action="store_true",
                    help="resident mode: load the model once and answer NDJSON requests on stdin/stdout")
    ap.add_argument("--source", help="source motion .npy, (T,22,3) float32 world metres")
    ap.add_argument("--line", help="line-edit request .json (contract C6)")
    ap.add_argument("--out", help="output .npy; metadata goes to <out stem>.meta.json")
    ap.add_argument("--steps", type=int, default=100, help="ODE steps (S1: ~7.3 ms/step at 100 frames)")
    ap.add_argument("--ridge", type=float, default=1e-6,
                    help="ridge_lambda. S1: THIS is the exactness knob, not steps — 1e-3 lands at "
                         "2.6e-5 while 1e-6 gives 2.4e-7 at half the steps")
    ap.add_argument("--preview", action="store_true",
                    help="20 steps instead of --steps (S1 measured 0.145 s for a 100-frame preview)")
    ap.add_argument("--preserve-stride", type=int, default=2, help="pin every Nth frame outside the edit range")
    ap.add_argument("--preserve-margin", type=int, default=20,
                    help="frames either side of the edit range where the edited limb is left free (20 = 1 s)")
    ap.add_argument("--seam-pin", type=int, default=2,
                    help="pin the edit range's own outermost N frames to the source, whole body "
                         "(0 = off; the app guarantees the curve's ends sit on the source trail)")
    ap.add_argument("--seed", type=int, default=0, help="matches demo/run.py's default")
    ap.add_argument("--cfg", type=float, default=3.0, help="classifier-free guidance scale")
    ap.add_argument("--repo", default=os.environ.get("CCLAY_PROJFLOW_REPO", "/home/yun/projflow-scout/repo"))
    ap.add_argument("--model-id", default="ACMDM-Raw-Flow-S-PatchSize22")
    ap.add_argument("--model-name", default="ACMDM_Raw_Flow_S_PatchSize22")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    if args.serve:
        # The resident takes its whole request on the wire, so the one-shot file
        # flags are meaningless here and passing them is a caller bug worth
        # naming rather than ignoring.
        for flag in ("source", "line", "out"):
            if getattr(args, flag):
                raise SystemExit(f"--serve takes its requests on stdin; --{flag} does not apply")
        return serve(args)

    for flag in ("source", "line", "out"):
        if not getattr(args, flag):
            raise SystemExit(f"--{flag} is required (or use --serve)")

    # Resolve every caller-supplied path BEFORE the chdir below, or a relative
    # --source silently resolves against the ProjFlow clone instead of the
    # caller's cwd. generate.mjs always passes absolute paths; a human running
    # this by hand should not have to.
    args.source = str(Path(args.source).expanduser().resolve())
    args.line = str(Path(args.line).expanduser().resolve())
    args.out = str(Path(args.out).expanduser().absolute())

    repo = open_repo(args.repo)

    source = np.load(args.source).astype(np.float32)
    if source.ndim != 3 or source.shape[1] != NUM_JOINTS or source.shape[2] != 3:
        raise SystemExit(f"--source must be (T,22,3); got {source.shape}")

    with open(args.line, "r", encoding="utf-8") as handle:
        line = json.load(handle)

    steps = 20 if args.preview else int(args.steps)
    engine = Engine(repo, model_id=args.model_id, model_name=args.model_name, device=args.device)
    out_world, meta = run_line_edit(
        engine,
        source,
        line,
        steps=steps,
        ridge=float(args.ridge),
        preserve_stride=int(args.preserve_stride),
        preserve_margin=int(args.preserve_margin),
        seam_pin=int(args.seam_pin),
        seed=int(args.seed),
        cfg=float(args.cfg),
        preview=bool(args.preview),
    )

    out_path = Path(args.out).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(str(out_path), out_world)

    # `<stem>.meta.json` beside the motion: --out foo.npy => foo.meta.json. The
    # wrapper builds the same name on the JS side, so this spelling is a contract.
    stem = str(out_path)[:-4] if str(out_path).endswith(".npy") else str(out_path)
    meta_path = Path(stem + ".meta.json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)

    # The wrapper greps this line, the same way bridge.mjs greps Kimodo's.
    print(
        f"projflow-line-edit: done - {out_path} "
        f"(m={meta['m']} steps={meta['steps']} sample={meta['sampling_seconds']:.3f}s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
