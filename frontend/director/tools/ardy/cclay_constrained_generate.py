# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors
#
# cclay-owned script. Source of truth lives in the CozyClay repo at
# tools/ardy/cclay_constrained_generate.py. The local runner executes it in
# place; a box deployment may copy it to ~/ardy/scripts/. Do not edit a
# deployed copy.
"""One-shot constrained text-to-motion generation for the cclay ARDY pipeline.

One full ``model(...)`` sampling call over the whole clip, optionally
conditioned on:

* ``--pose-from <npz> <src-frame> <dst-frame>`` (repeatable): pins the FULL
*  BODY pose stored in an ARDY motion npz (``local_rot_mats`` +
*  ``posed_joints``) onto a clip frame — joint positions, authored joint
*  rotations, root X/Y/Z and heading. CozyClay pose npz files carry an
*  explicit rotation-index mask; ordinary motion npz files constrain all
*  rotations.
* ``--root-2d FRAME X Z HEADING`` (repeatable): sparse root waypoints on the
  X/Z ground plane via ``Root2DConstraintSet`` (HEADING in radians or the
  literal ``none``), the same contract as cclay_sequence_generate.py.

With no constraints at all this is plain text-to-motion (the local twin of
``scripts/generate.py``); a ``--base`` flag is accepted for grammar
compatibility with the remote script but ignored — constraint conditioning
here needs no unconstrained first pass.

The last stdout line is a single JSON object whose ``target_space`` field
marks it as a constrained-generation report (bridge.mjs keys on that):
    {"target_space": "skeleton_joint_center", "frames": int, "fps": int,
     "model": str,
     "poses": [{"dst_frame", "root_error_m", "shape_mean_error_m",
                "shape_max_error_m"}],
     "waypoints": [{"frame", "requested_xz", "achieved_xz",
                    "achieved_error_m", "heading_rad"}]}
"""

import argparse
import json
import os

import numpy as np
import torch

from ardy.model import DEFAULT_MODEL, load_model
from ardy.constraints import FullBodyConstraintSet
from ardy.model.loading import get_env_var
from ardy.model.registry import resolve_model_name
from ardy.motion_rep.tools import length_to_mask
from ardy.postprocess import post_process_motion
from ardy.skeleton import SOMASkeleton30
from ardy.tools import seed_everything, to_numpy


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="One-shot constrained text-to-motion generation (cclay)"
    )
    parser.add_argument("--prompt", type=str, required=True, help="Text prompt.")
    parser.add_argument("--duration", type=float, required=True, help="Clip length in seconds.")
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output npz path (.npz appended when missing; parent dirs created).",
    )
    parser.add_argument(
        "--pose-from",
        dest="pose_from",
        action="append",
        nargs=3,
        metavar=("NPZ", "SRC_FRAME", "DST_FRAME"),
        help="Repeatable: pin the full-body pose NPZ[SRC_FRAME] at clip frame DST_FRAME.",
    )
    parser.add_argument(
        "--root-2d",
        dest="root_2d",
        action="append",
        nargs=4,
        metavar=("FRAME", "X", "Z", "HEADING"),
        help="Repeatable: pin the root's ground position (meters) at a clip frame; HEADING radians or 'none'.",
    )
    parser.add_argument(
        "--base",
        type=str,
        default=None,
        help="Accepted for remote-grammar compatibility; unused locally.",
    )
    parser.add_argument("--seed", type=int, default=None, help="Seed for reproducible results.")
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help="Model nickname or full folder name (default: %(default)s).",
    )
    parser.add_argument(
        "--diffusion_steps",
        type=int,
        default=None,
        help="Denoising steps, at most the model's num_base_steps (the default).",
    )
    parser.add_argument(
        "--cfg_weight",
        type=float,
        nargs="+",
        default=[2.0, 2.0],
        help="CFG scale(s): one float (text) or two floats (text, constraint).",
    )
    parser.add_argument(
        "--no-postprocess",
        action="store_true",
        help="Don't apply motion post-processing (foot-skate reduction).",
    )
    parser.add_argument(
        "--history_frames",
        type=int,
        default=None,
        help=(
            "History crop budget per autoregressive step (multiple of the model's "
            "token size). Default: the longest history fitting the trained 10 s "
            "window together with the generation horizon."
        ),
    )
    parser.add_argument(
        "--root-margin",
        type=float,
        default=None,
        help="Root position correction margin for post-processing (default: ARDY's 0.04 m). Larger = looser pin grip, less foot skate.",
    )
    parser.add_argument(
        "--contact-threshold",
        type=float,
        default=None,
        help="Foot contact detection threshold for post-processing (default: ARDY's 0.5).",
    )
    parser.add_argument(
        "--checkpoints_dir",
        type=str,
        default=None,
        help="Local dir holding released model folders (falls back to CHECKPOINTS_DIR env).",
    )
    return parser.parse_args(argv)


def cclay_pick_device():
    """cuda > mps > cpu, overridable with CCLAY_ARDY_DEVICE (cpu|mps|cuda[:N]).

    The env override is how the local runner forces CPU (--cpu) without
    relying on CUDA_VISIBLE_DEVICES, which cannot hide an Apple GPU.
    """
    forced = os.environ.get("CCLAY_ARDY_DEVICE", "").strip().lower()
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda:0"
    mps_backend = getattr(torch.backends, "mps", None)
    if mps_backend is not None and mps_backend.is_available():
        return "mps"
    return "cpu"


def cclay_mps_compat(device):
    """Downcast float64 buffers to float32 at registration when running on MPS.

    The MPS backend has no float64. ARDY's skeleton loads neutral_joints from
    a float64 pickle and registers it as a buffer, which makes Ardy.__init__'s
    .to("mps") fail; float32 is plenty for joint positions in meters. No-op on
    cuda/cpu so remote-box behavior is untouched.
    """
    if not str(device).startswith("mps"):
        return
    original = torch.nn.Module.register_buffer
    if getattr(original, "_cclay_f32", False):
        return

    def register_buffer_f32(self, name, tensor, persistent=True):
        if tensor is not None and getattr(tensor, "dtype", None) == torch.float64:
            tensor = tensor.float()
        return original(self, name, tensor, persistent)

    register_buffer_f32._cclay_f32 = True
    torch.nn.Module.register_buffer = register_buffer_f32


def cclay_progress(iterable):
    """Print one line per sampling step so the bridge can stream progress.

    The model calls this where it would call tqdm; every line lands in the
    UI as a status event, which is the only liveness signal the operator has
    during a minutes-long generation.
    """
    total = len(iterable) if hasattr(iterable, "__len__") else None
    for index, item in enumerate(iterable):
        if total:
            print(f"sampling step {index + 1}/{total}", flush=True)
        else:
            print(f"sampling step {index + 1}", flush=True)
        yield item


def _default_history_frames(fps: float, gen_horizon_len: int, num_frames_per_token: int) -> int:
    """Longest history that, with the generation horizon, fits the trained 10 s window."""
    max_window_len = (int(10 * fps) // num_frames_per_token) * num_frames_per_token
    return ((max_window_len - gen_horizon_len) // num_frames_per_token) * num_frames_per_token


def _single_file_path(path: str, ext: str) -> str:
    if not path.endswith(ext):
        path = path.rstrip(os.sep) + ext
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


def save_motion_npz(path: str, motion_dict: dict, fps: float, text: str) -> None:
    arrays = {k: np.asarray(v) for k, v in motion_dict.items()}
    arrays["fps"] = np.asarray(fps)
    arrays["text"] = np.asarray(text)
    np.savez(path, **arrays)


def parse_root_waypoints(raw_waypoints, num_frames: int) -> list:
    """Same contract as cclay_sequence_generate.py, frames in clip-local range."""
    if not raw_waypoints:
        return []
    waypoints = []
    seen = set()
    for raw_frame, raw_x, raw_z, raw_heading in raw_waypoints:
        try:
            frame = int(raw_frame)
        except ValueError:
            raise ValueError(f"--root-2d frame must be an integer, got {raw_frame!r}.")
        if not 0 <= frame < num_frames:
            raise ValueError(f"--root-2d frame {frame} is outside the clip (0..{num_frames - 1}).")
        if frame in seen:
            raise ValueError(f"duplicate --root-2d for frame {frame}; one waypoint per frame.")
        seen.add(frame)
        try:
            x, z = float(raw_x), float(raw_z)
        except ValueError:
            raise ValueError(f"--root-2d X Z must be numbers, got {(raw_x, raw_z)!r}.")
        if str(raw_heading).lower() == "none":
            heading = None
        else:
            try:
                heading = float(raw_heading)
            except ValueError:
                raise ValueError(f"--root-2d HEADING must be a number or 'none', got {raw_heading!r}.")
        waypoints.append({"frame": frame, "xz": [x, z], "heading": heading})
    waypoints.sort(key=lambda entry: entry["frame"])
    if len({entry["heading"] is None for entry in waypoints}) > 1:
        raise ValueError(
            "--root-2d heading must be given for every waypoint or for none of them; "
            "ARDY conditions the whole waypoint set on one heading tensor."
        )
    return waypoints


def load_pose(path, skeleton, device):
    """Pose npz -> local rotations, positions, and rotation constraint indices.

    The npz stores per-joint LOCAL rotations; FullBodyConstraintSet wants
    GLOBAL rotations and posed positions, so the caller runs skeleton.fk on
    the selected frame — the same expansion cclay_motion_edit.py uses.
    """
    with np.load(path, allow_pickle=False) as data:
        local = torch.from_numpy(np.asarray(data["local_rot_mats"])).float().to(device)
        posed = torch.from_numpy(np.asarray(data["posed_joints"])).float().to(device)
        if "rotation_constraint_indices" in data:
            rotation_indices = torch.from_numpy(
                np.asarray(data["rotation_constraint_indices"], dtype=np.int64)
            )
        else:
            rotation_indices = torch.arange(local.shape[1], dtype=torch.long)
    return local, posed, rotation_indices


class CclayFullBodyConstraintSet(FullBodyConstraintSet):
    """Upstream full-body positions plus explicit global-rotation observations.

    ARDY's FullBodyConstraintSet accepts rotations but deliberately omits them
    from update_constraints. CozyClay poses need shoulder, elbow and wrist
    orientation as well as joint centers, so this subclass fills the motion
    representation's supported global_joints_rots channel for authored joints.
    """

    name = "cclay-fullbody-position-rotation"

    def __init__(self, *args, rotation_indices, **kwargs):
        super().__init__(*args, **kwargs)
        self.rotation_indices = rotation_indices.long().cpu()

    def update_constraints(self, data_dict, index_dict):
        super().update_constraints(data_dict, index_dict)
        indices = torch.cartesian_prod(self.frame_indices.cpu(), self.rotation_indices)
        device_indices = self.rotation_indices.to(self.global_joints_rots.device)
        data_dict["global_joints_rots"].append(
            self.global_joints_rots[:, device_indices].reshape(-1, 3, 3)
        )
        index_dict["global_joints_rots"].append(indices)


def measure_waypoints(waypoints: list, generated_joints, skeleton) -> list:
    report = []
    root_index = skeleton.root_idx
    for entry in waypoints:
        root = np.asarray(generated_joints[entry["frame"], root_index], dtype=np.float64)
        achieved = [float(root[0]), float(root[2])]
        error = float(np.linalg.norm(np.asarray(achieved) - np.asarray(entry["xz"])))
        report.append(
            {
                "frame": entry["frame"],
                "requested_xz": [round(value, 4) for value in entry["xz"]],
                "achieved_xz": [round(value, 4) for value in achieved],
                "achieved_error_m": round(error, 4),
                "heading_rad": entry["heading"],
            }
        )
    return report


def main(argv=None, preloaded_model=None):
    args = parse_args(argv)
    device = cclay_pick_device()
    cclay_mps_compat(device)
    print(f"Using device: {device}")

    prompt = args.prompt.strip()
    if not prompt:
        raise ValueError("--prompt must be non-empty.")
    if args.duration <= 0:
        raise ValueError(f"--duration must be > 0 seconds, got {args.duration}.")

    if len(args.cfg_weight) == 1:
        cfg_weight = float(args.cfg_weight[0])
    elif len(args.cfg_weight) == 2:
        cfg_weight = (float(args.cfg_weight[0]), float(args.cfg_weight[1]))
    else:
        raise ValueError("--cfg_weight expects one float (text) or two floats (text, constraint).")

    checkpoints_dir = args.checkpoints_dir or get_env_var("CHECKPOINTS_DIR")
    resolved_model = resolve_model_name(args.model, checkpoints_dir=checkpoints_dir)
    model = (
        preloaded_model
        if preloaded_model is not None
        else load_model(resolved_model, device=device, checkpoints_dir=checkpoints_dir)
    )
    model.eval()
    skeleton = model.skeleton
    fps = model.motion_rep.fps
    patch = model.num_frames_per_token

    num_frames = int(args.duration * fps)
    if num_frames < 3:
        raise ValueError(f"--duration {args.duration}s yields {num_frames} frames; the minimum is 3.")

    num_base_steps = int(model.diffusion.num_base_steps)
    diffusion_steps = args.diffusion_steps if args.diffusion_steps is not None else num_base_steps
    if not 1 <= diffusion_steps <= num_base_steps:
        raise ValueError(
            f"--diffusion_steps must be between 1 and {num_base_steps}; got {diffusion_steps}."
        )
    if args.history_frames is not None:
        if args.history_frames < patch or args.history_frames % patch != 0:
            raise ValueError(
                f"--history_frames must be a positive multiple of {patch} (this model's token size)."
            )
        history_frames = args.history_frames
    else:
        history_frames = _default_history_frames(fps, model.gen_horizon_len, patch)

    # --- constraints --------------------------------------------------------
    constraint_lst = []
    pose_targets = []  # for the report: (dst_frame, requested positions [J,3])
    for npz_path, raw_src, raw_dst in args.pose_from or []:
        try:
            src_frame, dst_frame = int(raw_src), int(raw_dst)
        except ValueError:
            raise ValueError(f"--pose-from frames must be integers, got {(raw_src, raw_dst)!r}.")
        if not 0 <= dst_frame < num_frames:
            raise ValueError(f"--pose-from dst-frame {dst_frame} is outside the clip (0..{num_frames - 1}).")
        local, posed, rotation_indices = load_pose(npz_path, skeleton, device)
        if not 0 <= src_frame < local.shape[0]:
            raise ValueError(
                f"--pose-from src-frame {src_frame} is outside {npz_path} (0..{local.shape[0] - 1})."
            )
        root = posed[src_frame : src_frame + 1, skeleton.root_idx]
        rotations, positions, _ = skeleton.fk(local[src_frame : src_frame + 1], root)
        constraint_lst.append(
            CclayFullBodyConstraintSet(
                skeleton,
                torch.tensor([dst_frame]),
                positions,
                rotations,
                rotation_indices=rotation_indices,
            )
        )
        pose_targets.append((dst_frame, positions[0].cpu().numpy()))
        print(f"FullBodyConstraintSet: {npz_path}[{src_frame}] pinned at clip frame {dst_frame}")

    waypoints = parse_root_waypoints(args.root_2d or [], num_frames)
    if waypoints:
        from ardy.constraints import Root2DConstraintSet

        headings = [entry["heading"] for entry in waypoints]
        constraint_lst.append(
            Root2DConstraintSet(
                skeleton,
                frame_indices=torch.tensor([entry["frame"] for entry in waypoints]),
                root_2d=torch.tensor(
                    [entry["xz"] for entry in waypoints], device=device, dtype=torch.float32
                ),
                global_root_heading=(
                    None
                    if headings[0] is None
                    else torch.tensor(headings, device=device, dtype=torch.float32)
                ),
            )
        )
        print(f"Root2DConstraintSet on clip frames {[entry['frame'] for entry in waypoints]}")

    observed_motion = None
    motion_mask = None
    lengths = torch.tensor([num_frames], device=device)
    if constraint_lst:
        observed_motion, motion_mask = model.motion_rep.create_conditions_from_constraints_batched(
            constraint_lst,
            lengths,
            to_normalize=True,
            device=device,
        )

    # --- sampling -----------------------------------------------------------
    if args.seed is not None:
        seed_everything(args.seed)
    print(f"Generating {num_frames} frames ({num_frames / fps:.2f}s at {fps} fps)")
    with torch.no_grad():
        motion = model(
            [prompt],
            num_frames,
            num_denoising_steps=diffusion_steps,
            pad_mask=length_to_mask(lengths),
            first_heading_angle=torch.zeros(1, device=device),
            motion_mask=motion_mask,
            observed_motion=observed_motion,
            cfg_weight=cfg_weight,
            progress_bar=cclay_progress,
            crop_history_length=history_frames,
        )
        output = model.motion_rep.inverse(motion, is_normalized=True)

    postprocess_kwargs = {}
    use_postprocess = "g1" not in resolved_model.lower() and not args.no_postprocess
    if use_postprocess:
        if args.root_margin is not None:
            postprocess_kwargs["root_margin"] = args.root_margin
        if args.contact_threshold is not None:
            postprocess_kwargs["contact_threshold"] = args.contact_threshold
        corrected = post_process_motion(
            output["local_rot_mats"],
            output["root_positions"],
            output["foot_contacts"],
            skeleton,
            constraint_lst=constraint_lst if constraint_lst else None,
            **postprocess_kwargs,
        )
        output.update(corrected)

    if isinstance(skeleton, SOMASkeleton30):
        output = skeleton.output_to_SOMASkeleton77(output)

    output = to_numpy(output)
    motion_dict = {
        k: (v[0] if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == 1 else v)
        for k, v in output.items()
    }

    npz_path = _single_file_path(args.output, ".npz")
    print(f"Saving the npz output to {npz_path}")
    save_motion_npz(npz_path, motion_dict, fps, prompt)

    # --- report (last stdout line, keyed on target_space by bridge.mjs) ------
    generated_joints = np.asarray(motion_dict["posed_joints"])
    root_index = skeleton.root_idx
    pose_reports = []

    # Quality metrics alongside the pose/waypoint accuracy: the operator can
    # judge a path by them, not just trust it. Continuity is the largest
    # one-frame root jump (chained seams show up here); surface contact
    # verifies that stance frames keep the foot planted instead of skating.
    def motion_continuity(root_positions):
        if len(root_positions) < 2:
            return None
        deltas = np.linalg.norm(np.diff(root_positions[:, [0, 2]], axis=0), axis=1)
        worst = int(deltas.argmax()) + 1 if len(deltas) else 0
        return {
            "mean_jump_m": round(float(deltas.mean()), 6),
            "max_jump_m": round(float(deltas.max()), 6),
            "max_jump_frame": worst,
        }

    def surface_contact_verified(contacts, posed, foot_indices):
        if contacts is None or not len(foot_indices):
            return None
        contacts_arr = np.asarray(contacts)
        if contacts_arr.ndim == 3:
            contacts_arr = contacts_arr[0]
        checked = 0
        held = 0
        for contact_idx, joint_idx in enumerate(foot_indices[: contacts_arr.shape[1]]):
            ys = posed[:, joint_idx, 1]
            for frame in range(1, len(posed)):
                if contacts_arr[frame, contact_idx] > 0.5 and contacts_arr[frame - 1, contact_idx] > 0.5:
                    checked += 1
                    if abs(ys[frame] - ys[frame - 1]) < 0.02:
                        held += 1
        return checked == 0 or (held / checked) >= 0.8

    root_positions = np.asarray(motion_dict["root_positions"])
    foot_indices = [idx for idx, name in enumerate(skeleton.bone_order_names) if "foot" in name.lower() or "toe" in name.lower()]
    continuity = motion_continuity(root_positions)
    contact_verified = surface_contact_verified(
        motion_dict.get("foot_contacts"), generated_joints, foot_indices
    )
    for dst_frame, requested in pose_targets:
        achieved = generated_joints[dst_frame]
        root_error = float(np.linalg.norm(achieved[root_index] - requested[root_index]))
        # Shape error compares body proportions with both roots removed, so a
        # root miss is not double-counted against every joint.
        requested_centered = requested - requested[root_index]
        achieved_centered = achieved - achieved[root_index]
        joint_errors = np.linalg.norm(achieved_centered - requested_centered, axis=-1)
        pose_reports.append(
            {
                "dst_frame": dst_frame,
                "root_error_m": round(root_error, 4),
                "shape_mean_error_m": round(float(joint_errors.mean()), 4),
                "shape_max_error_m": round(float(joint_errors.max()), 4),
            }
        )

    report = {
        "target_space": "skeleton_joint_center",
        "frames": int(generated_joints.shape[0]),
        "fps": int(fps),
        "model": resolved_model,
        "surface_contact_verified": contact_verified,
        "continuity": continuity,
        "postprocess": {
            "contact_threshold": postprocess_kwargs.get("contact_threshold", 0.5) if use_postprocess else None,
            "root_margin": postprocess_kwargs.get("root_margin", 0.04) if use_postprocess else None,
        },
        "poses": pose_reports,
        "waypoints": measure_waypoints(waypoints, generated_joints, skeleton),
    }
    print(json.dumps(report))


if __name__ == "__main__":
    main()
