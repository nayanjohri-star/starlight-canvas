#!/usr/bin/env python3
"""Extract the OBS NPZ contract from one GVHMR forward pass.

Units and frames: image coordinates are pixels; translations and joints are
metres. ``incam_*`` uses OpenCV camera coordinates (+X right, +Y down, +Z
forward). ``global_*`` uses GVHMR gravity-view ``ay`` coordinates (+Y up).
Joints are the first 22 SMPL joints obtained by SMPL-X FK/regression using the
runner's ``make_smplx('supermotion')`` body model. K is float64 and is copied
exactly from --K-json.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np


def load_runner(path):
    path = Path(path).resolve()
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("cclay_obs_runner", path)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    return runner


def fk22(runner, params, model, sparse, regressor):
    import torch
    # Pipeline params are batched (1, T, ...); SMPL-X expects (T, ...), the
    # same per-frame layout the runner feeds it via pred["smpl_params_global"].
    flat = {key: (value[0] if value.dim() >= 2 and value.shape[0] == 1 else value) for key, value in params.items()}
    with torch.no_grad():
        body = model(**runner.to_cuda(flat))
        verts = torch.stack([torch.matmul(sparse, v) for v in body.vertices])
        joints = torch.einsum("jv,tvi->tji", regressor, verts)
        return joints[:, :22]


def parameterized_pp(outputs, endecoder, cp_thr, clamp):
    """Exact pp_static_joint_cam, exposing its two correction limits."""
    import torch
    from hmr4d.utils.geo_transform import apply_T_on_points, transform_mat
    from hmr4d.utils.net_utils import gaussian_smooth
    from pytorch3d.transforms import axis_angle_to_matrix

    incam = outputs["pred_smpl_params_incam"].copy()
    global_params = outputs["pred_smpl_params_global"]
    logits = outputs["static_conf_logits"].clone()[:, :-1]
    joint_ids = [7, 10, 8, 11, 20, 21]
    batch, length = incam["transl"].shape[:2]
    assert batch == 1

    pred_w = endecoder.fk_v2(**global_params)
    incam["transl"] = gaussian_smooth(incam["transl"], sigma=5, dim=-2)
    pred_c = endecoder.fk_v2(**incam)
    r_gv = axis_angle_to_matrix(global_params["global_orient"][:, 0])
    r_c = axis_angle_to_matrix(incam["global_orient"][:, 0])
    r_c2w = r_gv @ r_c.mT
    t_c2w = pred_w[:, 0, 0] - torch.einsum("bij,bj->bi", r_c2w, pred_c[:, 0, 0])
    t_c2w = transform_mat(r_c2w, t_c2w)
    pred_c_in_w = apply_T_on_points(pred_c, t_c2w[:, None])

    post_transl = global_params["transl"].clone()
    post_joints = pred_w.clone()
    threshold = torch.as_tensor([cp_thr] * 3, device=post_joints.device, dtype=post_joints.dtype)
    for i in range(1, length):
        diff = post_joints[:, i, 0] - pred_c_in_w[:, i, 0]
        diff = diff * ~((diff > -threshold) * (diff < threshold))
        diff = torch.clamp(diff, -clamp, clamp)
        post_transl[:, i:] -= diff
        post_joints[:, i:] -= diff[:, None, None]

    static = logits.sigmoid() > 0.8
    count = static.sum(-1, keepdim=True).clamp_min(1)
    disp = (post_joints[:, 1:, joint_ids] - post_joints[:, :-1, joint_ids])
    disp = (disp * static[..., None]).sum(-2) / count
    disp[:, :, 1] = 0
    for i in range(1, length):
        post_transl[:, i:] -= disp[:, [i - 1]]
        post_joints[:, i:] -= disp[:, [i - 1], None]
    ground_y = post_joints[..., 1].flatten(-2).min(dim=-1)[0]
    post_transl[..., 1] -= ground_y
    return post_transl


def as_np(value, dtype=np.float32):
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.ascontiguousarray(value, dtype=dtype)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runner")
    ap.add_argument("video")
    ap.add_argument("output")
    ap.add_argument("--out-root", default="outputs/cclay-obs")
    ap.add_argument("--K-json", required=True)
    ap.add_argument("--detector", choices=("palette", "yolo"), default="palette")
    ap.add_argument("--keypoints", choices=("vitpose", "hybrid"), default="vitpose")
    ap.add_argument("--betas-json")
    ap.add_argument("--pp-thr", type=float, default=0.0)
    ap.add_argument("--pp-clamp", type=float, default=1.0)
    ap.add_argument("--check-pp", action="store_true")
    args = ap.parse_args()

    runner = load_runner(args.runner)
    import torch
    from hmr4d.model.gvhmr.utils.postprocess import pp_static_joint_cam, process_ik
    from hmr4d.utils.geo.hmr_cam import normalize_kp2d

    with open(args.K_json, encoding="utf-8") as stream:
        K = np.asarray(json.load(stream), dtype=np.float64)
    if K.shape != (3, 3):
        raise ValueError("--K-json must contain a 3x3 array")

    video = Path(args.video)
    length, width, height = runner.get_video_lwh(str(video))
    cfg = runner.build_cfg(video, True, None, Path(args.out_root))
    data = runner.preprocess(cfg, video, args.detector, args.keypoints)
    data["K_fullimg"] = torch.as_tensor(K, dtype=data["K_fullimg"].dtype,
                                         device=data["K_fullimg"].device).repeat(length, 1, 1)
    model = runner.hydra.utils.instantiate(cfg.model, _recursive_=False)
    model.load_pretrained_model(cfg.ckpt_path)
    model = model.eval().cuda()
    batch = {
        "length": data["length"][None],
        "obs": normalize_kp2d(data["kp2d"], data["bbx_xys"])[None],
        "bbx_xys": data["bbx_xys"][None], "K_fullimg": data["K_fullimg"][None],
        "cam_angvel": data["cam_angvel"][None], "f_imgseq": data["f_imgseq"][None],
    }
    batch = {key: value.cuda() for key, value in batch.items()}
    with torch.no_grad():
        raw = model.pipeline.forward(batch, train=False, postproc=False, static_cam=True)

    pred = {key: {name: value.clone() for name, value in raw[key].items()}
            for key in ("pred_smpl_params_incam", "pred_smpl_params_global")}
    pred["static_conf_logits"] = raw["static_conf_logits"].clone()
    if args.betas_json:
        with open(args.betas_json, encoding="utf-8") as stream:
            loaded = json.load(stream)
        # Accept a bare list or tools/bench/obs/mannequin-betas.json ({"betas": [...], ...}).
        betas_used = np.asarray(loaded["betas"] if isinstance(loaded, dict) else loaded, dtype=np.float32)
        if betas_used.shape != (10,):
            raise ValueError("--betas-json must contain 10 floats")
        betas = torch.as_tensor(betas_used, device=pred["pred_smpl_params_incam"]["betas"].device,
                                dtype=pred["pred_smpl_params_incam"]["betas"].dtype)
        for params in (pred["pred_smpl_params_incam"], pred["pred_smpl_params_global"]):
            params["betas"] = betas[None, None].expand_as(params["betas"])
    else:
        betas_used = as_np(pred["pred_smpl_params_incam"]["betas"][0].mean(0))

    default_transl = pp_static_joint_cam(pred, model.pipeline.endecoder)
    relaxed_transl = parameterized_pp(pred, model.pipeline.endecoder, args.pp_thr, args.pp_clamp)
    if args.check_pp:
        exact = parameterized_pp(pred, model.pipeline.endecoder, 0.25, 0.02)
        pp_diff = float((exact - default_transl).abs().max().item())
        print(f"pp_default vs GVHMR postproc max abs diff: {pp_diff:.9g}", flush=True)
        if pp_diff > 1e-5:
            raise AssertionError(f"pp_default mismatch: {pp_diff}")

    variants = {}
    for name, transl in (("pp_default", default_transl), ("pp_relaxed", relaxed_transl)):
        params = {key: value.clone() for key, value in pred["pred_smpl_params_global"].items()}
        params["transl"] = transl
        ik_input = {"pred_smpl_params_global": params,
                    "pred_smpl_params_incam": pred["pred_smpl_params_incam"],
                    "static_conf_logits": pred["static_conf_logits"]}
        params["body_pose"] = process_ik(ik_input, model.pipeline.endecoder)
        variants[name] = params

    smplx = runner.make_smplx("supermotion").cuda()
    sparse = torch.load("hmr4d/utils/body_model/smplx2smpl_sparse.pt").cuda()
    regressor = torch.load("hmr4d/utils/body_model/smpl_neutral_J_regressor.pt").cuda()
    incam = pred["pred_smpl_params_incam"]
    incam_joints = fk22(runner, incam, smplx, sparse, regressor)
    output = {
        "fps": np.int32(runner.video_fps(video)), "K": K,
        "bbx_xys": as_np(data["bbx_xys"]), "kp2d": as_np(data["kp2d"]),
        "static_conf_logits": as_np(pred["static_conf_logits"][0]),
        "betas_pred": as_np(raw["pred_smpl_params_incam"]["betas"][0]),
        "betas_used": as_np(betas_used),
        "incam_global_orient": as_np(incam["global_orient"][0]),
        "incam_body_pose": as_np(incam["body_pose"][0].reshape(length, 21, 3)),
        "incam_transl": as_np(incam["transl"][0]), "incam_joints": as_np(incam_joints),
        "incam_pelvis": as_np(incam_joints[:, 0]),
    }
    for name, params in variants.items():
        joints = fk22(runner, params, smplx, sparse, regressor)
        output.update({f"global_{name}_global_orient": as_np(params["global_orient"][0]),
                       f"global_{name}_body_pose": as_np(params["body_pose"][0].reshape(length, 21, 3)),
                       f"global_{name}_transl": as_np(params["transl"][0]),
                       f"global_{name}_joints": as_np(joints)})
    if not all(np.isfinite(value).all() for value in output.values()):
        raise ValueError("nonfinite OBS output")
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    np.savez(args.output, **output)
    print(f"wrote OBS NPZ: {args.output} fields={len(output)}", flush=True)


if __name__ == "__main__":
    main()
