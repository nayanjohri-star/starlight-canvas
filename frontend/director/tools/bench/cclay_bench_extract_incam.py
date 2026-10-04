#!/usr/bin/env python3
"""Issue #432: add camera evidence around the UNMODIFIED production runner.

python cclay_bench_extract_incam.py <runner.py> <video> <out.npz>
    --static-cam --f-mm 35 --out-root /tmp/cclay-fit-.../cache
    --detector palette --keypoints hybrid --smooth-sigma 3

Import-only reuse: runner.main, FastRuntime and trajectory_job. The two repo
worker modules are deployed alongside this file, never into the GVHMR tree.
No GT poses/joints are inputs. The output contains the runner's members plus:
  incam_raw_{global_orient,transl,body_pose,betas}: SMPL-X model parameters
  incam_global_orient / incam_pelvis: production-smoothed camera-space root
  ayfz_to_camera[T,4,4]: per-frame pelvis/orientation relation, column vectors
  ay_to_ayfz[4,4]: exact runner normalization including floor/heading offset
  K_fullimg[T,3,3], ay_global_orient, ay_transl: raw prediction diagnostics

SMPL model transl is NOT its regressed pelvis. We evaluate the same SMPL-X ->
SMPL mesh regressor as production to get camera pelvis, then smooth with the
runner's own function. ayfz_to_camera is framewise, not a claim that noisy
monocular camera and integrated world trajectories agree on one static SE(3).
The JS fit uses one initial registration to preserve F1's trajectory.
"""
import importlib.util
from pathlib import Path
import sys


def main():
    runner_path = Path(sys.argv[1]).resolve()
    arguments = sys.argv[2:]
    direct = "--bench-direct" in arguments
    if direct:
        arguments.remove("--bench-direct")
    if "--static-cam" not in arguments or "--f-mm" not in arguments:
        raise ValueError("bench camera evidence requires --static-cam and --f-mm")
    sys.path.insert(0, str(runner_path.parent))
    spec = importlib.util.spec_from_file_location("cozyclay_fit_runner", runner_path)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    import numpy as np
    import torch

    capture = {}
    detach = runner.detach_to_cpu
    normalize = runner.compute_T_ayfz2ay

    def save_prediction(value):
        result = detach(value)
        capture["prediction"] = result
        return result

    def save_normalization(joints, *args, **kwargs):
        result = normalize(joints, *args, **kwargs)
        capture["heading"] = result.detach().cpu()
        return result

    runner.detach_to_cpu = save_prediction
    runner.compute_T_ayfz2ay = save_normalization
    sys.argv = [str(runner_path), *arguments]
    video, output = Path(arguments[0]), Path(arguments[1])
    root = Path(arguments[arguments.index("--out-root") + 1])
    sigma = float(arguments[arguments.index("--smooth-sigma") + 1]) if "--smooth-sigma" in arguments else 1.2
    # Match the T2 condition's execution path as well as its detector flags.
    # YOLO/direct must NOT gain production's trajectory correction or palette
    # fast path merely because this launcher also captures camera evidence.
    if direct:
        runner.main()
    else:
        from gvhmr_fastpath import FastRuntime
        from gvhmr_trajectory import trajectory_job
        runtime = FastRuntime(runner, enabled=True)
        with runtime.job(), trajectory_job(runner, video, root):
            runner.main()
    pred = capture["prediction"]
    cp, gp = pred["smpl_params_incam"], pred["smpl_params_global"]
    with np.load(output) as archive:
        arrays = {key: archive[key] for key in archive.files}

    # Re-evaluate regressed pelvis in BOTH frames. The SMPL parameter transl
    # omits the shaped rest-pelvis offset; using it directly shifts placement.
    with torch.no_grad():
        model = runner.make_smplx("supermotion").cuda()
        mapping = torch.load("hmr4d/utils/body_model/smplx2smpl_sparse.pt").cuda()
        regressor = torch.load("hmr4d/utils/body_model/smpl_neutral_J_regressor.pt").cuda()

        def pelvis(params):
            mesh = model(**runner.to_cuda(params)).vertices
            verts = torch.stack([torch.matmul(mapping, v) for v in mesh])
            return torch.einsum("v,tvc->tc", regressor[0], verts).cpu()

        camera_pelvis = pelvis(cp)
        world_pelvis = pelvis(gp)
        del model, mapping, regressor
        runner._release_gpu()
        # The prediction packs 21 axis-angle vectors into 63 scalars; the
        # runner smoother requires a final axis of 3, as in its own main().
        orient, _, camera_pelvis = runner.smooth_motion_params(
            cp["global_orient"], cp["body_pose"].reshape(-1, 21, 3), camera_pelvis, sigma=sigma)
        # Reconstruct normalization translation from production's unsmoothed
        # mesh-regressed pelvis. Its first root is saved in legacy positions.
        heading = capture["heading"][0]
        rotation = heading[:3, :3]
        norm = heading.clone()
        norm[:3, 3] = torch.from_numpy(arrays["positions"][0, 0]) - rotation @ world_pelvis[0]
        camera_r = runner.axis_angle_to_matrix(orient)
        ayfz_r = runner.axis_angle_to_matrix(torch.from_numpy(arrays["smpl_global_orient"]))
        r = camera_r @ ayfz_r.transpose(-1, -2)
        relation = torch.eye(4).repeat(len(orient), 1, 1)
        relation[:, :3, :3] = r
        relation[:, :3, 3] = camera_pelvis - (r @ torch.from_numpy(arrays["smpl_transl"])[..., None])[..., 0]

    c32 = lambda value: np.ascontiguousarray(np.asarray(value, dtype=np.float32))
    arrays.update({"incam_raw_" + key: c32(value) for key, value in cp.items()})
    arrays.update(incam_global_orient=c32(orient), incam_pelvis=c32(camera_pelvis),
                  ayfz_to_camera=c32(relation), ay_to_ayfz=c32(norm),
                  ay_global_orient=c32(gp["global_orient"]), ay_transl=c32(gp["transl"]),
                  K_fullimg=c32(pred["K_fullimg"]))
    if not all(np.isfinite(value).all() for value in arrays.values()):
        raise ValueError("nonfinite camera evidence")
    np.savez(output, **arrays)
    print(f"[fit] wrote camera parameters and transforms: {output}", flush=True)


if __name__ == "__main__":
    main()
