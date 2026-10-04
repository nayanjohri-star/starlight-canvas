#!/usr/bin/env python3
"""setup-text-encoder.py - provision the ARDY text-encoder models without a
Hugging Face account, approval wait, or access token.

ARDY's text encoder is LLM2Vec on top of meta-llama/Meta-Llama-3-8B-Instruct.
The official Meta repository is gated (manual approval + token). This script
instead downloads a byte-pinned stack from public, ungated repositories:

  base       NousResearch/Meta-Llama-3-8B-Instruct   (public mirror of the
             official weights; every safetensors shard is verified against a
             pinned SHA-256 before use)
  adapters   McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp
             McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised

and lays them out for ARDY's `TEXT_ENCODERS_DIR` override
(ardy/model/llm2vec/llm2vec_wrapper.py), rewriting each adapter's
`base_model_name_or_path` to the local base directory so nothing ever
resolves back to the gated meta-llama repository at runtime.

Every revision is pinned to a full commit SHA and every LFS payload to a
SHA-256, so re-runs are reproducible and a tampered or changed upstream file
fails loudly instead of silently drifting the embeddings (and with them the
generated motion).

Licenses: the base weights are Meta Llama 3 Community License (the LICENSE
and USE_POLICY.md files are downloaded alongside the weights and must stay
there); the McGill adapters are MIT. This script only downloads for local
use - it does not redistribute anything.

Usage (typically on the ARDY box; stdlib only, python >= 3.8):

  python3 setup-text-encoder.py                  # into ~/cclay-text-encoders
  python3 setup-text-encoder.py --dest /srv/enc  # custom destination
  python3 setup-text-encoder.py --verify-only    # re-hash an existing tree

Afterwards start the encoder service with the printed environment:

  TEXT_ENCODERS_DIR=<dest> python scripts/run_text_encoder_server.py
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

HF = "https://huggingface.co"

BASE_DIR = "NousResearch/Meta-Llama-3-8B-Instruct"
MNTP_DIR = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
# The mntp *download* lands in a -src dir: merge-text-encoder.py bakes the
# base+MNTP merge into the runtime MNTP_DIR path (transformers v5 dropped
# automatic adapter-dir resolution, so the runtime path must be a full model).
MNTP_SRC_DIR = MNTP_DIR + "-src"
SUP_DIR = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"

# (local dir, repo id, pinned full commit SHA, files)
# Each file: (path, size, sha256-or-None). SHA-256 comes from the HF LFS
# metadata of the pinned revision; small non-LFS files carry only a size and
# are already immutable because the revision is a commit hash.
# Pins match nv-tlabs/ardy issue #9's reproduction stack.
MANIFEST = [
    (
        BASE_DIR,
        "NousResearch/Meta-Llama-3-8B-Instruct",
        "53346005fb0ef11d3b6a83b12c895cca40156b6c",
        [
            ("LICENSE", 7801, None),
            ("USE_POLICY.md", 4696, None),
            ("config.json", 654, None),
            ("generation_config.json", 187, None),
            ("model-00001-of-00004.safetensors", 4976698672,
             "d8cf9c4d0dd972e1a2131bfe656235ee98221679711a3beef6d46dadf0f20b5c"),
            ("model-00002-of-00004.safetensors", 4999802720,
             "8d4782b4a69ef03845159ce1a15e272aadaaf134dc138d68f616098e8531729c"),
            ("model-00003-of-00004.safetensors", 4915916176,
             "3acdd690e65c24f42a24581b8467af98bd3ca357444580f8012aacd2bd607921"),
            ("model-00004-of-00004.safetensors", 1168138808,
             "67e9ad31c8c32abf3a55ee7fc7217b3ecb35fd3c74d98a5bd233e0e4d6964f46"),
            ("model.safetensors.index.json", 23950, None),
            ("special_tokens_map.json", 73, None),
            ("tokenizer.json", 9085698, None),
            ("tokenizer_config.json", 50977, None),
        ],
    ),
    (
        MNTP_SRC_DIR,
        "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
        "31474e395ada192e8ed1586db6be79fb3b70c9c0",
        [
            ("README.md", 3315, None),
            ("adapter_config.json", 794, None),
            ("adapter_model.safetensors", 167829552,
             "de9c8736618a13173c6a1623cdef1b75e86c69317f1073ae82cd516ac36a632d"),
            ("attn_mask_utils.py", 11132, None),
            ("config.json", 781, None),
            ("modeling_llama_encoder.py", 2856, None),
            ("special_tokens_map.json", 335, None),
            ("tokenizer.json", 9085671, None),
            ("tokenizer_config.json", 51042, None),
        ],
    ),
    (
        SUP_DIR,
        "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised",
        "baa8ebf04a1c2500e61288e7dad65e8ae42601a7",
        [
            ("README.md", 62702, None),
            ("adapter_config.json", 794, None),
            ("adapter_model.safetensors", 167829552,
             "53f8f94ebdf396667ba99dd96e78203edae27bbcdbd1cf5f12b611e1d916b225"),
        ],
    ),
]

# adapter_config.json is rewritten after download (base_model_name_or_path ->
# local base dir), so its byte size legitimately changes; everything else must
# keep the manifest size forever.
MUTATED = {"adapter_config.json"}

CHUNK = 1024 * 1024


def log(msg):
    print("setup-text-encoder: %s" % msg, flush=True)


def fail(msg):
    print("setup-text-encoder: ERROR: %s" % msg, file=sys.stderr, flush=True)
    sys.exit(1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def file_ok(path, size, sha, verify_hash):
    """Is the on-disk file already the pinned artifact?"""
    if not os.path.isfile(path):
        return False
    name = os.path.basename(path)
    if name in MUTATED:
        return True  # rewritten in place; checked by rewrite_adapter_config
    if os.path.getsize(path) != size:
        return False
    if sha is not None and verify_hash:
        return sha256_file(path) == sha
    return True


def download(url, dest, size, sha):
    """Resumable download to dest + '.partial', verified, then atomic rename."""
    part = dest + ".partial"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(1, 6):
        try:
            have = os.path.getsize(part) if os.path.isfile(part) else 0
            if have > size:
                os.remove(part)
                have = 0
            if have < size:
                req = urllib.request.Request(url)
                req.add_header("User-Agent", "cozyclay-setup-text-encoder/1")
                if have:
                    req.add_header("Range", "bytes=%d-" % have)
                with urllib.request.urlopen(req, timeout=60) as resp:
                    if have and resp.status != 206:
                        # Server ignored the Range header; start over.
                        have = 0
                        mode = "wb"
                    else:
                        mode = "ab" if have else "wb"
                    done = have
                    t0 = time.time()
                    with open(part, mode) as out:
                        while True:
                            block = resp.read(CHUNK)
                            if not block:
                                break
                            out.write(block)
                            done += len(block)
                            if size > CHUNK and time.time() - t0 > 5:
                                log("  ... %d / %d MiB" % (done // 2**20, size // 2**20))
                                t0 = time.time()
            got = os.path.getsize(part)
            if got != size:
                raise IOError("size mismatch: got %d, want %d" % (got, size))
            if sha is not None:
                actual = sha256_file(part)
                if actual != sha:
                    os.remove(part)
                    raise IOError("sha256 mismatch: got %s, want %s" % (actual, sha))
            os.replace(part, dest)
            return
        except (urllib.error.URLError, IOError, OSError) as e:
            if attempt == 5:
                fail("giving up on %s after 5 attempts: %s" % (url, e))
            log("  retry %d/5 for %s (%s)" % (attempt, os.path.basename(dest), e))
            time.sleep(2 * attempt)


def rewrite_adapter_config(path, base_path):
    """Point the adapter at the local base so nothing resolves to gated repos."""
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if cfg.get("base_model_name_or_path") == base_path:
        return False
    cfg["base_model_name_or_path"] = base_path
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", default=os.environ.get(
        "TEXT_ENCODERS_DIR", os.path.expanduser("~/cclay-text-encoders")),
        help="target directory (default: $TEXT_ENCODERS_DIR or ~/cclay-text-encoders)")
    ap.add_argument("--verify-only", action="store_true",
                    help="verify an existing tree (sizes + SHA-256), download nothing")
    ap.add_argument("--print-plan", action="store_true",
                    help="list every pinned file and exit")
    args = ap.parse_args()

    dest = os.path.abspath(os.path.expanduser(args.dest))
    os.makedirs(dest, exist_ok=True)
    dest_real = os.path.realpath(dest)

    def safe_join(*parts):
        """Join paths and verify the result stays within base."""
        full = os.path.realpath(os.path.join(dest_real, *parts))
        if full != dest_real and not full.startswith(dest_real + os.sep):
            fail("path traversal detected: %s" % os.path.join(*parts))
        return full

    base_path = safe_join(BASE_DIR)

    if args.print_plan:
        for local_dir, repo, rev, files in MANIFEST:
            print("%s @ %s" % (repo, rev))
            for path, size, sha in files:
                print("  %-40s %12d  %s" % (path, size, sha or "-"))
        return

    total = sum(size for _, _, _, files in MANIFEST for _, size, _ in files)
    missing = []
    for local_dir, repo, rev, files in MANIFEST:
        for path, size, sha in files:
            target = safe_join(local_dir, path)
            if not file_ok(target, size, sha, verify_hash=args.verify_only):
                missing.append((local_dir, repo, rev, path, size, sha))

    if args.verify_only:
        if missing:
            for local_dir, _, _, path, _, _ in missing:
                print("  BAD/MISSING  %s/%s" % (local_dir, path))
            fail("%d file(s) failed verification under %s" % (len(missing), dest))
        log("all %d files verified OK under %s" % (
            sum(len(f) for _, _, _, f in MANIFEST), dest))
        return

    if missing:
        todo = sum(m[4] for m in missing)
        log("destination: %s" % dest)
        log("downloading %d file(s), %.1f GiB of %.1f GiB total pinned payload"
            % (len(missing), todo / 2**30, total / 2**30))
        for local_dir, repo, rev, path, size, sha in missing:
            url = "%s/%s/resolve/%s/%s?download=true" % (HF, repo, rev, path)
            log("fetch %s/%s (%d bytes)" % (local_dir, path, size))
            download(url, safe_join(local_dir, path), size, sha)
    else:
        log("all pinned files already present under %s" % dest)

    for adapter_dir in (MNTP_SRC_DIR, SUP_DIR):
        cfg = safe_join(adapter_dir, "adapter_config.json")
        if rewrite_adapter_config(cfg, base_path):
            log("repointed %s -> local base" % os.path.join(adapter_dir, "adapter_config.json"))

    log("downloads verified. Bake the MNTP merge next (one-time, ~5 min):")
    log("  cd <ardy checkout> && <ardy venv python> merge-text-encoder.py --dest %s" % dest)
    print()
    print("Start ARDY's text-encoder service (and any local ARDY run) with:")
    print()
    print("  export TEXT_ENCODERS_DIR=%s" % dest)
    print("  python scripts/run_text_encoder_server.py")
    print()
    print("The base weights are Meta Llama 3 (Meta Llama 3 Community License;")
    print("see %s/LICENSE)." % base_path)
    print("This product is built with Meta Llama 3.")


if __name__ == "__main__":
    main()
