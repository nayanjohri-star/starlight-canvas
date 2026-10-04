#!/usr/bin/env python3
"""Context-aware sparse motion editing for CozyClay.

The source motion stays authoritative. ARDY receives real pre-edit history,
sparse per-joint constraints inside the editable interval, the existing root
trajectory as a separate channel, and dense future context. Only the editable
interval is committed back into the full source motion.
"""

import argparse
import json
import os


TRACK_JOINTS = {
    "leftHand": "LeftHand",
    "rightHand": "RightHand",
    "leftFoot": "LeftFoot",
    "rightFoot": "RightFoot",
    "leftElbow": "LeftForeArm",
    "rightElbow": "RightForeArm",
    "leftKnee": "LeftLeg",
    "rightKnee": "RightLeg",
    "spine": "Spine",
    "chest": "Spine1",
    "neck": "Neck",
    "head": "Head",
    "leftShoulder": "LeftShoulder",
    "rightShoulder": "RightShoulder",
}

TRACK_COMMIT_CHAINS = {
    "leftHand": ["LeftArm", "LeftForeArm", "LeftHand"],
    "rightHand": ["RightArm", "RightForeArm", "RightHand"],
    "leftFoot": ["LeftUpLeg", "LeftLeg", "LeftFoot"],
    "rightFoot": ["RightUpLeg", "RightLeg", "RightFoot"],
    "leftElbow": ["LeftForeArm"],
    "rightElbow": ["RightForeArm"],
    "leftKnee": ["LeftLeg"],
    "rightKnee": ["RightLeg"],
    "hips": ["Hips"],
    "spine": ["Spine"],
    "chest": ["Spine1"],
    "neck": ["Neck"],
    "head": ["Head"],
    "leftShoulder": ["LeftShoulder"],
    "rightShoulder": ["RightShoulder"],
}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Context-aware sparse ARDY motion edit")
    parser.add_argument("--source", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--context-before", type=int, default=40)
    parser.add_argument("--context-after", type=int, default=20)
    parser.add_argument("--seed", type=int)
    return parser.parse_args(argv)


class SparseJointConstraint:
    """Constraint only the named joints; deliberately does not touch root."""

    name = "cozyclay-sparse-joint"

    def __init__(self, skeleton, frame_indices, positions, rotations, joint_names):
        import torch

        self.skeleton = skeleton
        self.frame_indices = frame_indices
        self.global_joints_positions = positions
        self.global_joints_rots = rotations
        self.joint_names = joint_names
        self.rot_indices = torch.tensor(
            [skeleton.bone_index[name] for name in joint_names],
        )
        self.pos_indices = torch.tensor(
            sorted({skeleton.root_idx, *self.rot_indices.tolist()}),
        )

    def update_constraints(self, data_dict, index_dict):
        import torch

        crop_frames = torch.arange(len(self.frame_indices))
        real = torch.cartesian_prod(self.frame_indices, self.pos_indices)
        crop = torch.cartesian_prod(crop_frames, self.pos_indices)
        data_dict["global_joints_positions"].append(
            self.global_joints_positions[crop[:, 0], crop[:, 1]]
        )
        index_dict["global_joints_positions"].append(real)
        real = torch.cartesian_prod(self.frame_indices, self.rot_indices)
        crop = torch.cartesian_prod(crop_frames, self.rot_indices)
        data_dict["global_joints_rots"].append(
            self.global_joints_rots[crop[:, 0], crop[:, 1]]
        )
        index_dict["global_joints_rots"].append(real)


class RootTrackConstraint:
    """Root X/Y/Z and heading are a separate channel from body constraints."""

    name = "cozyclay-root-track"

    def __init__(self, skeleton, frame_indices, positions, headings):
        self.skeleton = skeleton
        self.frame_indices = frame_indices
        self.positions = positions
        self.headings = headings

    def update_constraints(self, data_dict, index_dict):
        data_dict["root_2d"].append(self.positions[:, [0, 2]])
        index_dict["root_2d"].append(self.frame_indices)
        data_dict["root_y_pos"].append(self.positions[:, 1])
        index_dict["root_y_pos"].append(self.frame_indices)
        data_dict["global_root_heading"].append(self.headings)
        index_dict["global_root_heading"].append(self.frame_indices)


def load_pose(path, skeleton, device):
    import numpy as np
    import torch

    with np.load(path, allow_pickle=False) as data:
        local = torch.from_numpy(np.asarray(data["local_rot_mats"])).float().to(device)
        posed = torch.from_numpy(np.asarray(data["posed_joints"])).float().to(device)
    root = posed[:1, skeleton.root_idx]
    rotations, positions, _ = skeleton.fk(local[:1], root)
    return positions[0], rotations[0], local[0]


def heading_from_positions(positions, skeleton):
    import torch
    from ardy.motion_rep.tools import compute_heading_angle

    angle = compute_heading_angle(positions[None], skeleton)[0]
    return torch.stack([torch.cos(angle), torch.sin(angle)], dim=-1)


def cclay_pick_device():
    """cuda > mps > cpu, overridable with CCLAY_ARDY_DEVICE (cpu|mps|cuda[:N]).

    The env override is how the local runner forces CPU (--cpu) without
    relying on CUDA_VISIBLE_DEVICES, which cannot hide an Apple GPU.
    """
    import torch

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
    import torch

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


def main(argv=None, preloaded_model=None):
    args = parse_args(argv)
    import numpy as np
    import torch
    from ardy.constraints import FullBodyConstraintSet
    from ardy.geometry import axis_angle_to_matrix, matrix_to_axis_angle
    from ardy.model import DEFAULT_MODEL, load_model
    from ardy.model.loading import get_env_var
    from ardy.model.registry import resolve_model_name
    from ardy.motion_rep.tools import length_to_mask
    from ardy.tools import seed_everything, to_numpy

    device = cclay_pick_device()
    cclay_mps_compat(device)
    checkpoints_dir = get_env_var("CHECKPOINTS_DIR", None)
    resolved_model = resolve_model_name(DEFAULT_MODEL, checkpoints_dir=checkpoints_dir)
    model = (
        preloaded_model
        if preloaded_model is not None
        else load_model(resolved_model, device=device, checkpoints_dir=checkpoints_dir)
    )
    model.eval()
    skeleton = model.skeleton
    fps = int(model.motion_rep.fps)

    with open(args.manifest, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    manifest_dir = os.path.dirname(os.path.abspath(args.manifest))
    start = int(manifest["start_frame"])
    end = int(manifest["end_frame"])
    edits = manifest["edits"]

    with np.load(args.source, allow_pickle=False) as data:
        source_arrays = {key: np.asarray(data[key]).copy() for key in data.files}
    source_local = np.asarray(source_arrays["local_rot_mats"], dtype=np.float32)
    source_root = np.asarray(source_arrays["root_positions"], dtype=np.float32)
    total_frames = source_local.shape[0]
    if not 0 <= start < end <= total_frames:
        raise ValueError(f"edit range {start}..{end} is outside source motion 0..{total_frames}")

    history_start = max(0, start - args.context_before)
    future_end = min(total_frames, end + args.context_after)
    history_frames = start - history_start
    edit_frames = end - start
    generation_frames = future_end - start
    model_frames = history_frames + generation_frames

    local_tensor = torch.from_numpy(source_local).float().to(device)
    root_tensor = torch.from_numpy(source_root).float().to(device)
    history = None
    if start > history_start:
        history = model.motion_rep(
            local_tensor[None, history_start:start],
            root_tensor[None, history_start:start],
            to_normalize=True,
        )

    gen_source_local = local_tensor[start:future_end]
    gen_source_root = root_tensor[start:future_end]
    source_global_rots, source_positions, _ = skeleton.fk(
        gen_source_local,
        gen_source_root,
    )

    constraints = []
    exact_keys = []
    root_positions = gen_source_root.clone()
    root_headings = heading_from_positions(source_positions, skeleton).clone()
    root_edit_anchors = []
    for edit in edits:
        local_frame = int(edit["frame"]) - start
        if not 0 <= local_frame < edit_frames:
            raise ValueError(f"edit frame {edit['frame']} is outside {start}..{end}")
        pose_path = edit["pose_path"]
        if not os.path.isabs(pose_path):
            pose_path = os.path.join(manifest_dir, pose_path)
        positions, rotations, local_rotations = load_pose(pose_path, skeleton, device)
        # ARDY's global-position representation requires a pelvis observation
        # alongside every sparse body point. Use the unchanged source pelvis;
        # this is an anchor, not permission for a hand/foot edit to move root.
        positions[skeleton.root_idx] = source_positions[local_frame, skeleton.root_idx]
        body_joints = sorted({
            TRACK_JOINTS[track]
            for track in edit["tracks"]
            if track in TRACK_JOINTS
        })
        if body_joints:
            constraints.append(
                SparseJointConstraint(
                    skeleton,
                    torch.tensor([history_frames + local_frame]),
                    positions[None],
                    rotations[None],
                    body_joints,
                )
            )
        if "hips" in edit["tracks"]:
            authored_root = torch.tensor(
                edit.get("root", positions[skeleton.root_idx].tolist()),
                device=device,
                dtype=torch.float32,
            )
            root_edit_anchors.append(
                (local_frame, authored_root, heading_from_positions(positions, skeleton))
            )
        exact_keys.append({
            "frame": local_frame,
            "tracks": edit["tracks"],
            "local_rotations": local_rotations,
            "root_position": torch.tensor(
                edit.get("root", positions[skeleton.root_idx].tolist()),
                device=device,
                dtype=torch.float32,
            ),
        })

    # Root stays on the source trajectory unless the user explicitly edits
    # hips. Hips edits become smooth offset anchors; body edits never move root.
    if root_edit_anchors:
        anchors = [(0, torch.zeros(3, device=device), torch.zeros(2, device=device))]
        for frame, position, heading in root_edit_anchors:
            anchors.append(
                (
                    frame,
                    position - gen_source_root[frame],
                    heading - root_headings[frame],
                )
            )
        anchors.append(
            (
                edit_frames - 1,
                torch.zeros(3, device=device),
                torch.zeros(2, device=device),
            )
        )
        anchors.sort(key=lambda item: item[0])
        for left, right in zip(anchors, anchors[1:]):
            f0, p0, h0 = left
            f1, p1, h1 = right
            span = max(1, f1 - f0)
            for frame in range(f0, f1 + 1):
                alpha = (frame - f0) / span
                root_positions[frame] += torch.lerp(p0, p1, alpha)
                root_headings[frame] += torch.lerp(h0, h1, alpha)

    all_generation_frames = torch.arange(history_frames, model_frames)
    constraints.append(
        RootTrackConstraint(
            skeleton,
            all_generation_frames,
            root_positions,
            root_headings,
        )
    )

    # Future context is observed, not regenerated. It closes the edit against
    # the following source motion while history conditions the left side.
    if future_end > end:
        future_indices = torch.arange(
            history_frames + edit_frames,
            model_frames,
        )
        constraints.append(
            FullBodyConstraintSet(
                skeleton,
                future_indices,
                source_positions[edit_frames:],
                source_global_rots[edit_frames:],
            )
        )

    lengths = torch.tensor([model_frames], device=device)
    observed_motion, motion_mask = model.motion_rep.create_conditions_from_constraints_batched(
        constraints,
        lengths,
        to_normalize=True,
        device=device,
    )
    if args.seed is not None:
        seed_everything(args.seed)
    with torch.no_grad():
        motion = model(
            [args.prompt],
            model_frames,
            num_denoising_steps=int(model.diffusion.num_base_steps),
            pad_mask=length_to_mask(lengths),
            first_heading_angle=(
                None
                if history is not None
                else torch.atan2(root_headings[:1, 1], root_headings[:1, 0])
            ),
            motion_mask=motion_mask,
            observed_motion=observed_motion,
            cfg_weight=2.0,
            progress_bar=cclay_progress,
            init_history_sequence=history,
        )
        generated_motion = motion[:, history_frames:history_frames + generation_frames]
        sampled = to_numpy(model.motion_rep.inverse(generated_motion, is_normalized=True))

    has_root_edits = any("hips" in edit["tracks"] for edit in edits)
    has_foot_edits = any(
        track in {"leftFoot", "rightFoot", "leftKnee", "rightKnee"}
        for edit in edits
        for track in edit["tracks"]
    )
    sampled = {
        key: (np.asarray(value)[0] if np.asarray(value).ndim > 0 and np.asarray(value).shape[0] == 1 else np.asarray(value))
        for key, value in sampled.items()
    }
    # ARDY owns the in-between frames, but authored keys are exact animation
    # frames rather than soft diffusion suggestions. Commit only the joints in
    # each edited chain, and commit root position only for explicit hips edits.
    committed_local = torch.from_numpy(sampled["local_rot_mats"]).float().to(device)
    committed_root = torch.from_numpy(sampled["root_positions"]).float().to(device)
    if has_root_edits:
        committed_root[:edit_frames] = root_positions[:edit_frames]
    for key in exact_keys:
        frame = key["frame"]
        joint_names = {
            joint_name
            for track in key["tracks"]
            for joint_name in TRACK_COMMIT_CHAINS.get(track, [])
        }
        for joint_name in joint_names:
            joint = skeleton.bone_index[joint_name]
            generated_at_key = committed_local[frame, joint].clone()
            correction = key["local_rotations"][joint] @ generated_at_key.transpose(-1, -2)
            correction_axis_angle = matrix_to_axis_angle(correction)
            radius = 6
            for tween_frame in range(
                max(0, frame - radius),
                min(edit_frames, frame + radius + 1),
            ):
                weight = 1.0 - abs(tween_frame - frame) / (radius + 1)
                tween_correction = axis_angle_to_matrix(correction_axis_angle * weight)
                committed_local[tween_frame, joint] = (
                    tween_correction @ committed_local[tween_frame, joint]
                )
            committed_local[frame, joint] = key["local_rotations"][joint]
        if "hips" in key["tracks"]:
            committed_root[frame] = key["root_position"]
    committed_global_rots, committed_positions, _ = skeleton.fk(
        committed_local,
        committed_root,
    )
    commit_verified = True
    for key in exact_keys:
        frame = key["frame"]
        for track in key["tracks"]:
            for joint_name in TRACK_COMMIT_CHAINS.get(track, []):
                joint = skeleton.bone_index[joint_name]
                commit_verified = commit_verified and torch.allclose(
                    committed_local[frame, joint],
                    key["local_rotations"][joint],
                    atol=1e-6,
                    rtol=0,
                )
        if "hips" in key["tracks"]:
            commit_verified = commit_verified and torch.allclose(
                committed_root[frame],
                key["root_position"],
                atol=1e-6,
                rtol=0,
            )
    if not commit_verified:
        raise RuntimeError("authored IK key commit verification failed")
    sampled["local_rot_mats"] = to_numpy(committed_local)
    sampled["root_positions"] = to_numpy(committed_root)
    sampled["posed_joints"] = to_numpy(committed_positions)
    if "global_rot_mats" in sampled:
        sampled["global_rot_mats"] = to_numpy(committed_global_rots)

    if not has_root_edits and "root_positions" in sampled:
        generated_root = sampled["root_positions"][:edit_frames].copy()
        source_edit_root = source_root[start:end]
        if "posed_joints" in sampled:
            sampled["posed_joints"][:edit_frames] += (
                source_edit_root - generated_root
            )[:, None, :]
        sampled["root_positions"][:edit_frames] = source_edit_root

    for key, value in sampled.items():
        if not has_foot_edits and "contact" in key:
            continue
        if key in source_arrays and value.ndim > 0 and source_arrays[key].shape[0] == total_frames:
            source_arrays[key][start:end] = value[:edit_frames]
    source_arrays["fps"] = np.asarray(fps)
    source_arrays["text"] = np.asarray(args.prompt)
    output = args.output if args.output.endswith(".npz") else f"{args.output}.npz"
    os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
    np.savez(output, **source_arrays)
    print(json.dumps({
        "frames": total_frames,
        "fps": fps,
        "edit_range": [start, end],
        "history_range": [history_start, start],
        "future_range": [end, future_end],
        "sparse_constraints": sum(
            len([track for track in edit["tracks"] if track in TRACK_JOINTS])
            for edit in edits
        ),
        "root_edits": sum("hips" in edit["tracks"] for edit in edits),
        "committed_keys": [start + key["frame"] for key in exact_keys],
        "commit_verified": commit_verified,
    }))


if __name__ == "__main__":
    main()
