#!/usr/bin/env python3
"""SMPL rest joints for one betas vector (box helper for tools/bench/obs-bench.mjs).

Run from ~/cclay-ingest/GVHMR with its venv:
    .venv/bin/python rest_joints.py '<json list of 10 betas>'

Reproduces cclay_gvhmr_extract.py main()'s ``smpl_rest_joints`` exactly:
SMPL-X ``make_smplx("supermotion")`` zero pose for ``betas`` -> smplx2smpl
sparse vertices -> neutral SMPL J-regressor, pelvis moved to the origin.
Also reports the rest mesh's lowest vertex height (pelvis-relative), which
gives the body's sole clearance under each foot joint. CPU only: the GPU is
reserved for serial GVHMR extraction, so CUDA is hidden before torch loads.
"""
import json
import os
import sys

os.environ["CUDA_VISIBLE_DEVICES"] = ""

import numpy as np
import torch

from hmr4d.utils.smplx_utils import make_smplx


def main():
    assert not torch.cuda.is_available(), "rest_joints.py must not see the GPU"
    betas = np.asarray(json.loads(sys.argv[1]), dtype=np.float32)
    if betas.shape != (10,) or not np.isfinite(betas).all():
        raise ValueError("expected 10 finite betas")
    smplx = make_smplx("supermotion")
    sparse = torch.load("hmr4d/utils/body_model/smplx2smpl_sparse.pt", map_location="cpu")
    regressor = torch.load("hmr4d/utils/body_model/smpl_neutral_J_regressor.pt", map_location="cpu")
    with torch.no_grad():
        rest = smplx(betas=torch.from_numpy(betas)[None], body_pose=torch.zeros(1, 63),
                     global_orient=torch.zeros(1, 3), transl=torch.zeros(1, 3))
        verts = torch.matmul(sparse, rest.vertices[0])
        joints = torch.einsum("jv,vi->ji", regressor, verts)
        pelvis = joints[0].clone()
        joints = joints - pelvis
        min_y = float((verts[:, 1] - pelvis[1]).min())
    print(json.dumps({
        "schema": "obs.rest-joints.v1",
        "betas": [float(v) for v in betas],
        "restJoints": joints.numpy().astype(np.float32).tolist(),
        "restMinVertexY": min_y,
        "model": "make_smplx('supermotion') zero pose -> smplx2smpl_sparse -> smpl_neutral_J_regressor; pelvis at origin",
    }))


if __name__ == "__main__":
    main()
