#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors
#
# cclay-owned script. Source of truth lives in the CozyClay repo at
# tools/ardy/cclay_worker.py.
"""Persistent local generation worker for the CozyClay ARDY bridge.

Loading the motion model and compiling its GPU kernels costs minutes on MPS,
while the sampling itself takes seconds. Spawning a fresh python per request
(the remote-box contract run-local.mjs mirrors) pays that cost every time, so
this worker pays it ONCE: it loads the model, runs a tiny no-text warmup to
force kernel compilation, and then serves generation jobs from the warm
process. run-local.mjs prefers the worker and silently falls back to a direct
spawn when it is not running, so the worker is an accelerator, never a
dependency.

Protocol (loopback TCP, one connection per job, one job at a time):

    client -> worker   one JSON line
                       {"mode": "ping"}
                       {"mode": "single"|"sequence"|"edit", "argv": [...]}
    worker -> client   the generator's stdout lines, verbatim, then
                       "worker: pong"  (ping)  or  "worker: exit <code>"

`argv` is exactly the CLI argument vector of the corresponding
cclay_*_generate/edit script; the worker calls that script's main() in
process with the cached model injected, so worker and direct-spawn runs share
one code path and cannot drift.

env:
    CCLAY_ARDY_WORKER_PORT  listen port (default 9552, loopback only)
    CHECKPOINTS_DIR / TEXT_ENCODER_URL / TEXT_ENCODERS_DIR as usual
"""

import importlib
import json
import os
import socket
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MODULES = {
    "single": "cclay_constrained_generate",
    "sequence": "cclay_sequence_generate",
    "edit": "cclay_motion_edit",
}


class _Tee:
    """Mirror generator stdout to the job's socket AND the worker console.

    A vanished client must not kill the job: the generation keeps running,
    the npz still lands on disk, and only the socket copy is dropped.
    """

    def __init__(self, sock_file):
        self._sock_file = sock_file

    def write(self, data):
        sys.__stdout__.write(data)
        try:
            self._sock_file.write(data)
            self._sock_file.flush()
        except OSError:
            pass

    def flush(self):
        sys.__stdout__.flush()


def requested_model_name(mode, argv, resolve_model_name, default_model, checkpoints_dir):
    """The model a job's argv asks for (edit has no --model flag)."""
    name = default_model
    if mode != "edit":
        for index, arg in enumerate(argv):
            if arg == "--model" and index + 1 < len(argv):
                name = argv[index + 1]
    return resolve_model_name(name, checkpoints_dir=checkpoints_dir)


def fix_text_encoder_device(model, device):
    """Move an in-process LLM2Vec encoder onto the generation device, fast.

    ARDY's load_text_encoder ends with `.to(device or "cuda"/"cpu")`, so on a
    Mac the fallback encoder lands on CPU even when TEXT_ENCODER_DEVICE says
    mps. On MPS the dtype matters as much as the device: bf16 matmuls are
    emulated (a single prompt costs ~30-50 s) while fp16 is native, so fp16
    is tried first and a canary encode guards against fp16 overflow — NaNs
    demote back to bf16. Only the real in-process encoder has a `.model`;
    the API client stub is left alone.
    """
    encoder = getattr(model, "text_encoder", None)
    if encoder is None or not hasattr(encoder, "model") or device == "cpu":
        return
    import torch

    for dtype in (torch.float16, torch.bfloat16):
        try:
            encoder.to(device=device, dtype=dtype)
            canary, _ = encoder(["a person walks forward"])
            if bool(torch.isfinite(canary.float()).all()):
                print(f"worker: text encoder on {device} as {dtype}", flush=True)
                return
            print(f"worker: text encoder {dtype} produced non-finite values; trying next dtype", flush=True)
        except Exception as exc:
            print(f"worker: text encoder {dtype} on {device} failed ({exc}); trying next dtype", flush=True)
    try:  # both GPU dtypes failed: back to the slow-but-correct CPU encoder
        encoder.to(device="cpu", dtype=torch.bfloat16)
        print("worker: text encoder stays on cpu", flush=True)
    except Exception as exc:
        print(f"worker: text encoder left as loaded ({exc})", flush=True)


class _CachingEncoder:
    """Per-prompt embedding cache in front of the in-process encoder.

    Authoring iterates on ONE prompt (new seed, new pose pin, new waypoints),
    so most requests re-encode text the worker has already seen. Embeddings
    are deterministic per (model, dtype) — exactly the cache key's tag — and
    a few KB each, so they live in memory and under ~/.cozyclay/embed-cache
    across worker restarts. Misses are timed on the console; hits are free.
    """

    def __init__(self, inner, cache_dir, tag):
        import os

        self._inner = inner
        self._dir = cache_dir
        self._tag = tag
        self._mem = {}
        os.makedirs(cache_dir, exist_ok=True)

    def _key(self, text):
        import hashlib

        return hashlib.sha256(f"{self._tag}\x00{text}".encode("utf-8")).hexdigest()

    def _encode_one(self, text):
        import os
        import time

        import numpy as np

        key = self._key(text)
        if key in self._mem:
            return self._mem[key]
        path = os.path.join(self._dir, f"{key}.npy")
        if os.path.isfile(path):
            try:
                embedding = np.load(path)
                self._mem[key] = embedding
                return embedding
            except Exception:
                pass  # unreadable cache entry: re-encode below
        started = time.time()
        tensor, _ = self._inner([text])
        embedding = tensor[0].detach().float().cpu().numpy()
        print(f"worker: text encode took {time.time() - started:.1f}s (cache miss)", flush=True)
        self._mem[key] = embedding
        try:
            np.save(path, embedding)
        except Exception:
            pass  # cache write failure must never fail the job
        return embedding

    def __call__(self, texts):
        import numpy as np
        import torch

        is_string = isinstance(texts, str)
        text_list = [texts] if is_string else list(texts)
        stacked = np.stack([self._encode_one(text) for text in text_list])
        device = getattr(self._inner, "_device", "cpu")
        encoded = torch.from_numpy(stacked).to(device)
        lengths = [1] * len(text_list)
        if is_string:
            return encoded[0], 1
        return encoded, lengths

    def __getattr__(self, name):
        return getattr(self._inner, name)


def warmup(model, device):
    """One throwaway sampling call so kernel compilation happens off the clock.

    Zero text features skip the text encoder entirely — the warmup must not
    drag the 16 GB Llama encoder into RAM just to compile Metal shaders.
    """
    import torch
    from ardy.motion_rep.tools import length_to_mask

    try:
        frames = int(model.gen_horizon_len)
        lengths = torch.tensor([frames], device=device)
        with torch.no_grad():
            model(
                [""],
                frames,
                num_denoising_steps=1,
                pad_mask=length_to_mask(lengths),
                first_heading_angle=torch.zeros(1, device=device),
                motion_mask=None,
                observed_motion=None,
                cfg_weight=2.0,
                text_feat=torch.zeros(1, 1, 4096, device=device),
                text_pad_mask=torch.ones(1, 1, device=device, dtype=torch.bool),
                progress_bar=lambda iterable: iterable,
            )
        print("worker: warmup complete", flush=True)
    except Exception as exc:  # non-fatal: first real job just pays the compile
        print(f"worker: warmup skipped ({exc})", flush=True)


def main():
    port = int(os.environ.get("CCLAY_ARDY_WORKER_PORT", "9552"))

    single = importlib.import_module(MODULES["single"])
    device = single.cclay_pick_device()
    single.cclay_mps_compat(device)

    from ardy.model import DEFAULT_MODEL, load_model
    from ardy.model.loading import get_env_var
    from ardy.model.registry import resolve_model_name

    checkpoints_dir = get_env_var("CHECKPOINTS_DIR", None)
    cached_name = resolve_model_name(DEFAULT_MODEL, checkpoints_dir=checkpoints_dir)
    print(f"worker: loading {cached_name} on {device} ...", flush=True)
    cached_model = load_model(cached_name, device=device, checkpoints_dir=checkpoints_dir)
    cached_model.eval()
    fix_text_encoder_device(cached_model, device)
    encoder = getattr(cached_model, "text_encoder", None)
    if encoder is not None and hasattr(encoder, "model"):
        try:
            param = next(encoder.model.parameters())
            tag = f"llm2vec:{param.dtype}:{param.device.type}"
        except Exception:
            tag = "llm2vec:unknown"
        cache_dir = os.path.join(os.path.expanduser("~"), ".cozyclay", "embed-cache")
        cached_model.text_encoder = _CachingEncoder(encoder, cache_dir, tag)
        print(f"worker: embedding cache at {cache_dir} ({tag})", flush=True)
    warmup(cached_model, device)

    server = socket.create_server(("127.0.0.1", port))
    print(f"worker: ready on 127.0.0.1:{port} (model {cached_name}, device {device})", flush=True)

    while True:
        conn, _ = server.accept()
        with conn:
            rfile = conn.makefile("r", encoding="utf-8")
            wfile = conn.makefile("w", encoding="utf-8")
            try:
                job = json.loads(rfile.readline())
            except (ValueError, OSError):
                continue
            mode = job.get("mode") if isinstance(job, dict) else None
            if mode == "ping":
                try:
                    wfile.write("worker: pong\n")
                    wfile.flush()
                except OSError:
                    pass
                continue
            argv = job.get("argv") if isinstance(job, dict) else None
            if mode not in MODULES or not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
                try:
                    wfile.write("worker: exit 2\n")
                    wfile.flush()
                except OSError:
                    pass
                continue

            module = importlib.import_module(MODULES[mode])
            code = 0
            old_stdout = sys.stdout
            sys.stdout = _Tee(wfile)
            try:
                wanted = requested_model_name(mode, argv, resolve_model_name, DEFAULT_MODEL, checkpoints_dir)
                if wanted != cached_name:
                    print(f"worker: switching model {cached_name} -> {wanted}", flush=True)
                    cached_model = load_model(wanted, device=device, checkpoints_dir=checkpoints_dir)
                    cached_model.eval()
                    cached_name = wanted
                module.main(argv, preloaded_model=cached_model)
            except SystemExit as exit_exc:
                code = exit_exc.code if isinstance(exit_exc.code, int) else 1
            except Exception:
                traceback.print_exc(file=sys.stdout)
                code = 1
            finally:
                sys.stdout = old_stdout
            try:
                wfile.write(f"worker: exit {code}\n")
                wfile.flush()
            except OSError:
                pass


if __name__ == "__main__":
    main()
