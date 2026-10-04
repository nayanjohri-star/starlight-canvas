#!/usr/bin/env python3
"""Dump one frame of an ARDY motion npz as a JSON document on stdout.

Runs under the ARDY box python (``~/ardy/.venv/bin/python``); it needs numpy
but no torch. Usage::

    python dump-npz.py <motion.npz> <frame>

Emitted document (schema "ardy.frame.v1"):

    {
      "schema": "ardy.frame.v1",
      "source_npz": "<basename of the npz>",
      "frame": <requested frame index>,
      "frames_total": <frame count of the motion>,
      "members": {"<member name>": {"shape": [...], "dtype": "..."}, ...},
      "local_rot_mats": [ 27 x [[3],[3],[3]] row-major ],
      "posed_joints":   [ 27 x [x, y, z] ]
    }

Member names and axis order match the ARDY archives exactly as consumed by
CozyClay (blender-addon/cclay): ``local_rot_mats[frame, joint]`` is the
per-joint LOCAL rotation matrix in cskel27 order (Hips = joint 0), and
``posed_joints[frame, joint]`` the joint center position. ``foot_contacts``
is optional and reported only when present. ``members`` lists every array in
the archive (sorted), including carried members like ``fps``, so a consumer
can see the exact contents without re-opening the npz.

Before emitting, every one of the 27 rotation matrices of the requested frame
is checked for finite entries, orthonormal rows/columns, and determinant +1,
with the same tolerance CozyClay's motion_retarget uses
(ROTATION_MATRIX_TOLERANCE = 1e-3 on squared norms, pairwise dots, and
determinant). On the first violation the matrix index and the failing
quantity are printed to stderr, the exit status is 1, and NO JSON is emitted:
a garbage rotation must not silently reach a downstream consumer.
"""

import json
import math
import sys

import numpy as np

SCHEMA = "ardy.frame.v1"
JOINTS = 27
# Mirror of CozyClay motion_retarget.ROTATION_MATRIX_TOLERANCE: applies to
# squared row/column norms, pairwise dot products, and determinant, in
# float64. float32 ARDY serialization noise stays far below 1e-3.
TOLERANCE = 1e-3


def _fail(message):
    """Report a fatal error on stderr and exit 1 without emitting JSON."""
    print(f"dump-npz: {message}", file=sys.stderr)
    sys.exit(1)


def _check_rotation(matrix, frame, joint):
    """Return a list of violation strings for one 3x3 matrix, or [] if clean."""
    violations = []
    rows = [[float(matrix[i][j]) for j in range(3)] for i in range(3)]
    columns = [[rows[i][j] for i in range(3)] for j in range(3)]
    prefix = f"frame {frame} joint {joint}"
    for label, vectors in (("row", rows), ("column", columns)):
        for index, vector in enumerate(vectors):
            squared_norm = sum(c * c for c in vector)
            if not math.isfinite(squared_norm):
                violations.append(
                    f"{prefix} {label} {index} has non-finite entries"
                )
            elif abs(squared_norm - 1.0) > TOLERANCE:
                violations.append(
                    f"{prefix} {label} {index} squared norm {squared_norm:.6f} "
                    f"differs from 1.0 by more than {TOLERANCE}"
                )
        for first, second in ((0, 1), (0, 2), (1, 2)):
            dot = sum(
                vectors[first][i] * vectors[second][i] for i in range(3)
            )
            if not math.isfinite(dot):
                violations.append(
                    f"{prefix} {label} {first}/{second} dot is non-finite"
                )
            elif abs(dot) > TOLERANCE:
                violations.append(
                    f"{prefix} {label} {first}/{second} dot {dot:.6f} "
                    f"exceeds {TOLERANCE} in magnitude"
                )
    determinant = (
        rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
        - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
        + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0])
    )
    if not math.isfinite(determinant):
        violations.append(f"{prefix} determinant is non-finite")
    elif abs(determinant - 1.0) > TOLERANCE:
        violations.append(
            f"{prefix} determinant {determinant:.6f} differs from 1.0 "
            f"by more than {TOLERANCE}"
        )
    return violations


def main(argv):
    if len(argv) != 3:
        _fail(f"usage: {argv[0]} <motion.npz> <frame>")
    npz_path, frame_text = argv[1], argv[2]
    try:
        frame = int(frame_text)
    except ValueError:
        _fail(f"frame must be an integer, got {frame_text!r}")
    if frame < 0:
        _fail(f"frame must be >= 0, got {frame}")

    try:
        data = np.load(npz_path, allow_pickle=False)
    except Exception as exc:
        _fail(f"cannot load {npz_path}: {exc}")

    try:
        if "local_rot_mats" not in data.files:
            _fail(f"{npz_path} has no 'local_rot_mats' member")
        if "posed_joints" not in data.files:
            _fail(f"{npz_path} has no 'posed_joints' member")
        rotations = data["local_rot_mats"]
        joints = data["posed_joints"]
        if rotations.shape[1:] != (JOINTS, 3, 3):
            _fail(
                f"local_rot_mats must have shape (F, {JOINTS}, 3, 3), "
                f"got {rotations.shape}"
            )
        if joints.shape[1:] != (JOINTS, 3):
            _fail(
                f"posed_joints must have shape (F, {JOINTS}, 3), "
                f"got {joints.shape}"
            )
        if joints.shape[0] != rotations.shape[0]:
            _fail(
                "local_rot_mats and posed_joints frame counts differ "
                f"({rotations.shape[0]} vs {joints.shape[0]})"
            )
        frames_total = int(rotations.shape[0])
        if frames_total < 1:
            _fail(f"motion has no frames ({frames_total})")
        if frame >= frames_total:
            _fail(
                f"frame {frame} out of range: motion has {frames_total} frames"
            )

        # Validate every rotation matrix of the requested frame BEFORE any
        # JSON is written; a violation aborts with a stderr report and a
        # non-zero exit status instead of emitting garbage.
        violations = []
        for joint in range(JOINTS):
            violations.extend(_check_rotation(rotations[frame][joint], frame, joint))
        for joint in range(JOINTS):
            for axis in range(3):
                if not math.isfinite(float(joints[frame][joint][axis])):
                    violations.append(
                        f"frame {frame} joint {joint} axis {axis} "
                        "position is not finite"
                    )
        if violations:
            for violation in violations[:20]:
                print(f"dump-npz: VIOLATION {violation}", file=sys.stderr)
            if len(violations) > 20:
                print(
                    f"dump-npz: ... and {len(violations) - 20} more",
                    file=sys.stderr,
                )
            _fail(
                f"refusing to emit {npz_path} frame {frame}: "
                f"{len(violations)} rotation/position check(s) failed"
            )

        members = {}
        for name in sorted(data.files):
            member = data[name]
            members[name] = {
                "shape": [int(size) for size in member.shape],
                "dtype": str(member.dtype),
            }

        document = {
            "schema": SCHEMA,
            "source_npz": npz_path.rsplit("/", 1)[-1],
            "frame": frame,
            "frames_total": frames_total,
            "members": members,
            "local_rot_mats": [
                [[float(value) for value in row] for row in rotations[frame][joint]]
                for joint in range(JOINTS)
            ],
            "posed_joints": [
                [float(value) for value in joints[frame][joint]]
                for joint in range(JOINTS)
            ],
        }
        print(json.dumps(document, indent=2))
    finally:
        data.close()


if __name__ == "__main__":
    main(sys.argv)
