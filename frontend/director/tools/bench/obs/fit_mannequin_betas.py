#!/usr/bin/env python3
"""Fit the ten SuperMotion SMPL-X shape coefficients to the y-bot rest rig.

The production playback path does not deform cskel27 to every authored rig
bone. It measures the rig's leg height, divides by the canonical cskel27 toe
height, and applies that one factor to the neutral cskel27 offsets. This
script uses those same scaled neutral offsets as the shape targets. The
public cskel27-rest.json supplies the bind-joint inventory/rest contract; its
entries are rotations, while the neutral positions used by playback are the
canonical CSKEL27_NEUTRAL coordinates below.

Run this from the GVHMR checkout (or pass --gvhmr-root):
  CUDA_VISIBLE_DEVICES="" .venv/bin/python /path/to/fit_mannequin_betas.py --device cpu --output /tmp/cclay-betas-out.json

The generated JSON is intentionally independent of a video or ground-truth
motion. Only the neutral rig measurements and the SMPL-X body model are used.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import torch

# cskel27-neutral.js, copied as numerical data so this runner has no JS
# runtime dependency on the GPU box. Coordinates are metres, hips-origin,
# exactly as used by src/ardy/playback.js.
CSKEL27_NEUTRAL = torch.tensor([
    [0.0, 0.0, 0.0],
    [0.0, 0.0709891, -0.0473261],
    [0.0, 0.1642033, -0.0637623],
    [0.0, 0.2584953, -0.0720118],
    [0.0, 0.3531475, -0.0720119],
    [0.0, 0.6016096, -0.0365176],
    [0.0, 0.7297793, -0.0139179],
    [-0.0319949, 0.5259196, -0.0186873],
    [-0.1909029, 0.5259195, -0.0186873],
    [-0.4863389, 0.5259194, -0.0186873],
    [-0.7189909, 0.5259193, -0.0186873],
    [-0.7886024, 0.5259193, -0.0186873],
    [-0.7468355, 0.5073563, 0.0277204],
    [0.0319949, 0.5259196, -0.0186873],
    [0.1909029, 0.5259196, -0.0186873],
    [0.4863389, 0.5259196, -0.0186873],
    [0.7189909, 0.5259196, -0.0186873],
    [0.7886024, 0.5259196, -0.0186873],
    [0.7468355, 0.5073565, 0.0277204],
    [-0.0949182, -0.0277289, 0.0],
    [-0.0949182, -0.4398469, 0.0],
    [-0.0949182, -0.8959379, 0.0],
    [-0.0949182, -0.9544128, 0.1606583],
    [0.0949182, -0.0277289, 0.0],
    [0.0949182, -0.4398469, 0.0],
    [0.0949182, -0.8959379, 0.0],
    [0.0949182, -0.9544128, 0.1606583],
], dtype=torch.float32)

# The values are measured from public/models/y-bot-tpose.fbx in armature
# metres: hips y 0.9979193878, lowest toe y 0.0328365048. The playback
# code uses the same lowest-toe convention and canonical height 0.9544128.
YBOT_LEG_HEIGHT_M = 0.9650828829792554
CANONICAL_LEG_HEIGHT_M = 0.9544128

# SMPL-24 regressed-joint indices, matching the OBS contract and
# tools/ardy/smpl-cskel27.mjs.
SEGMENTS = {
    "thigh_left": ((23, 24), (1, 4)),
    "thigh_right": ((19, 20), (2, 5)),
    "shin_left": ((24, 25), (4, 7)),
    "shin_right": ((20, 21), (5, 8)),
    "foot_left": ((25, 26), (7, 10)),
    "foot_right": ((21, 22), (8, 11)),
    "pelvis_width": ((23, 19), (1, 2)),
    "spine_length": ((0, 4), (0, 9)),
    # Playback's Shoulder/Arm scale spans cskel Spine3 -> Arm, because the
    # rig's collar and upper-arm chain are authored as one visible shoulder
    # reach. The corresponding SMPL source is spine3 -> shoulder.
    "upper_arm_left": ((4, 14), (9, 16)),
    "upper_arm_right": ((4, 8), (9, 17)),
    "forearm_left": ((14, 15), (16, 18)),
    "forearm_right": ((8, 9), (17, 19)),
    "shoulder_width": ((14, 8), (16, 17)),
    "total_height": (None, None),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--gvhmr-root", type=Path, default=Path.cwd())
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    parser.add_argument("--adam-steps", type=int, default=5000)
    parser.add_argument("--adam-lr", type=float, default=0.005)
    parser.add_argument("--beta-limit", type=float, default=3.0)
    parser.add_argument("--smooth-max-weight", type=float, default=0.0)
    parser.add_argument("--smooth-max-temperature", type=float, default=0.002)
    parser.add_argument("--minimax-steps", type=int, default=350)
    parser.add_argument("--prior", type=float, default=1e-5)
    # Segment lengths of the rendered rig (tools/bench/obs/ybot-targets.mjs).
    # Segments absent from the file are left out of the fit.
    parser.add_argument("--targets-json", type=Path)
    return parser.parse_args()


def load_model(root: Path, device: torch.device):
    root = root.resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    os.chdir(root)
    from cclay_gvhmr_extract import make_smplx  # pylint: disable=import-outside-toplevel

    model = make_smplx("supermotion").to(device).eval()
    sparse = torch.load(root / "hmr4d/utils/body_model/smplx2smpl_sparse.pt", map_location=device).to(device)
    regressor = torch.load(root / "hmr4d/utils/body_model/smpl_neutral_J_regressor.pt", map_location=device).to(device)
    return model, sparse, regressor


def length(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    return torch.linalg.vector_norm(a - b)


def targets(device: torch.device) -> tuple[dict[str, float], float]:
    neutral = CSKEL27_NEUTRAL.to(device)
    scale = YBOT_LEG_HEIGHT_M / CANONICAL_LEG_HEIGHT_M
    values: dict[str, float] = {}
    for name, spec in SEGMENTS.items():
        if name == "total_height":
            values[name] = float((neutral[:, 1].max() - neutral[:, 1].min()) * scale)
            continue
        cskel_pair, _ = spec
        values[name] = float(length(neutral[cskel_pair[0]], neutral[cskel_pair[1]]) * scale)
    return values, scale


def rest_joints(model, sparse, regressor, betas: torch.Tensor) -> torch.Tensor:
    output = model(
        **{
            "betas": betas,
            "body_pose": torch.zeros((1, 63), device=betas.device),
            "global_orient": torch.zeros((1, 3), device=betas.device),
            "transl": torch.zeros((1, 3), device=betas.device),
        }
    )
    smpl_vertices = torch.stack([torch.matmul(sparse, vertices) for vertices in output.vertices])
    return torch.einsum("jv,tvc->tjc", regressor, smpl_vertices)[0]


def measured_lengths(joints: torch.Tensor) -> dict[str, torch.Tensor]:
    result: dict[str, torch.Tensor] = {}
    for name, spec in SEGMENTS.items():
        if name == "total_height":
            result[name] = joints[:, 1].max() - joints[:, 1].min()
            continue
        _, smpl_pair = spec
        result[name] = length(joints[smpl_pair[0]], joints[smpl_pair[1]])
    return result


def fit(args: argparse.Namespace) -> dict:
    if args.device != "cpu":
        raise RuntimeError("mannequin beta fitting is CPU-only")
    device = torch.device("cpu")
    model, sparse, regressor = load_model(args.gvhmr_root, device)
    target, playback_scale = targets(device)
    target_source = "cskel27 neutral offsets scaled by playback leg-height rule"
    if args.targets_json is not None:
        global SEGMENTS  # pylint: disable=global-statement
        rig = json.loads(args.targets_json.read_text(encoding="utf-8"))
        target = {name: float(value) for name, value in rig["targets"].items() if name in SEGMENTS}
        SEGMENTS = {name: spec for name, spec in SEGMENTS.items() if name in target}
        target_source = f"rendered rig rest pose ({rig.get('model', args.targets_json.name)}), segments: {', '.join(SEGMENTS)}"
    target_tensor = torch.tensor([target[name] for name in SEGMENTS], device=device)

    if args.beta_limit <= 0:
        raise ValueError("--beta-limit must be positive")
    betas = torch.zeros((1, 10), device=device, requires_grad=True)
    if args.adam_lr <= 0 or args.smooth_max_weight < 0 or args.smooth_max_temperature <= 0:
        raise ValueError("optimizer parameters must be positive")
    optimizer = torch.optim.Adam([betas], lr=args.adam_lr)
    for _ in range(args.adam_steps):
        fitted = measured_lengths(rest_joints(model, sparse, regressor, betas))
        fitted_tensor = torch.stack([fitted[name] for name in SEGMENTS])
        residual = fitted_tensor - target_tensor
        smooth_max = args.smooth_max_temperature * torch.logsumexp(
            torch.abs(residual) / args.smooth_max_temperature, dim=0
        )
        loss = (
            torch.sum(residual**2)
            + args.smooth_max_weight * smooth_max
            + args.prior * torch.sum(betas**2)
        )
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        with torch.no_grad():
            betas.clamp_(-args.beta_limit, args.beta_limit)
    # Refine the projected-Adam point with a CPU-only minimax solve. SLSQP's
    # explicit bounds are the hard box constraint; t bounds every signed
    # residual, while the small quadratic term keeps the requested L2 prior.
    from scipy.optimize import minimize  # pylint: disable=import-outside-toplevel
    import numpy as np  # pylint: disable=import-outside-toplevel

    def residual_and_jacobian(beta_values):
        beta_tensor = torch.tensor(beta_values, dtype=torch.float32, device=device, requires_grad=True).reshape(10)

        def values(value):
            measured = measured_lengths(rest_joints(model, sparse, regressor, value[None]))
            return torch.stack([measured[name] for name in SEGMENTS])

        residual = values(beta_tensor) - target_tensor
        jacobian = torch.autograd.functional.jacobian(values, beta_tensor)
        return residual.detach().numpy(), jacobian.detach().numpy()

    def minimax_objective(variables):
        residual, jacobian = residual_and_jacobian(variables[:10])
        beta_values = variables[:10]
        value = variables[10] + 1e-3 * (
            float((residual * residual).sum()) + args.prior * float((beta_values * beta_values).sum())
        )
        gradient = np.zeros(11, dtype=float)
        gradient[:10] = 1e-3 * (2 * jacobian.T @ residual + 2 * args.prior * beta_values)
        gradient[10] = 1.0
        return value, gradient

    def minimax_constraints(variables):
        residual, _ = residual_and_jacobian(variables[:10])
        return np.concatenate((variables[10] - residual, variables[10] + residual))

    start_beta = betas.detach().cpu().numpy().astype(float).reshape(10)
    seeds = [start_beta]
    active_face_seed = start_beta.copy()
    active_face_seed[6:10] = [-args.beta_limit, -args.beta_limit, args.beta_limit, args.beta_limit]
    seeds.append(active_face_seed)
    seeds.append(np.array([
        2.50849517, 0.85280948, 0.30636654, 1.80294858, 1.24747668,
        0.64413053, -args.beta_limit, -args.beta_limit, args.beta_limit, args.beta_limit,
    ], dtype=float))
    best_candidate = betas.detach().clone()
    best_residual = torch.max(torch.abs(torch.stack([
        measured_lengths(rest_joints(model, sparse, regressor, best_candidate))[name] - target[name]
        for name in SEGMENTS
    ])))
    result = None
    for seed_beta in seeds:
        seed_residual, _ = residual_and_jacobian(seed_beta)
        start = np.r_[seed_beta, max(abs(seed_residual))]
        trial = minimize(
            lambda variables: minimax_objective(variables)[0],
            start,
            jac=lambda variables: minimax_objective(variables)[1],
            constraints={"type": "ineq", "fun": minimax_constraints},
            bounds=[(-args.beta_limit, args.beta_limit)] * 10 + [(0.0, 1.0)],
            method="SLSQP",
            options={"maxiter": args.minimax_steps, "ftol": 1e-10},
        )
        candidate = torch.tensor(trial.x[:10], dtype=torch.float32, device=device)
        with torch.no_grad():
            candidate.clamp_(-args.beta_limit, args.beta_limit)
            candidate_residual = torch.stack([
                measured_lengths(rest_joints(model, sparse, regressor, candidate.reshape(1, 10)))[name] - target[name]
                for name in SEGMENTS
            ])
            candidate_max = torch.max(torch.abs(candidate_residual))
            if torch.isfinite(candidate).all() and candidate_max < best_residual:
                best_candidate = candidate.clone()
                best_residual = candidate_max
                result = trial

    with torch.no_grad():
        betas = best_candidate.reshape(1, 10)
        fitted = measured_lengths(rest_joints(model, sparse, regressor, betas))

    beta_values = betas.detach().cpu().reshape(-1).tolist()
    rows = {}
    residuals = []
    for name in SEGMENTS:
        target_m = target[name]
        fitted_m = float(fitted[name].detach().cpu())
        residual_m = fitted_m - target_m
        residuals.append(residual_m)
        rows[name] = {
            "target_m": target_m,
            "fitted_m": fitted_m,
            "residual_m": residual_m,
            "abs_residual_m": abs(residual_m),
        }

    return {
        "schema": "obs.mannequin-betas.v1",
        "method": {
            "model": "smpl-x supermotion neutral",
            "optimizer": "projected Adam warm start + bounded SLSQP minimax",
            "adam_steps": args.adam_steps,
            "adam_lr": args.adam_lr,
            "minimax_steps": args.minimax_steps,
            "minimax_starts": 3,
            "minimax_success": bool(result.success) if result is not None else False,
            "minimax_status": int(result.status) if result is not None else -1,
            "beta_limit": args.beta_limit,
            "smooth_max_weight": args.smooth_max_weight,
            "smooth_max_temperature": args.smooth_max_temperature,
            "l2_prior": args.prior,
            "device": str(device),
            "source": target_source,
        },
        "betas": beta_values,
        "target_geometry": {
            "ybot_leg_height_m": YBOT_LEG_HEIGHT_M,
            "canonical_cskel27_leg_height_m": CANONICAL_LEG_HEIGHT_M,
            "playback_scale": playback_scale,
            "rest_contract": "public/ardy/cskel27-rest.json",
        },
        "residuals": rows,
        "summary": {
            "segment_count": len(rows),
            "max_abs_beta": max(abs(value) for value in beta_values),
            "max_abs_residual_m": max(abs(value) for value in residuals),
            "rms_residual_m": (sum(value * value for value in residuals) / len(residuals)) ** 0.5,
            "max_bone_length_residual_m": max(abs(value) for value in residuals),
        },
    }


def main() -> None:
    args = parse_args()
    result = fit(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], sort_keys=True), flush=True)
    print("betas=" + json.dumps(result["betas"]), flush=True)
    for name, row in result["residuals"].items():
        print(f"{name}: target={row['target_m']:.9f} fitted={row['fitted_m']:.9f} residual={row['residual_m']:+.9f}", flush=True)


if __name__ == "__main__":
    main()
