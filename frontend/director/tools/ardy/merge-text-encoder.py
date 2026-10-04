#!/usr/bin/env python3
"""merge-text-encoder.py - bake the MNTP LoRA into the base weights.

Run under the ARDY text-encoder venv (needs torch, peft, transformers, and
the `ardy` package importable — i.e. from the ARDY checkout):

  cd ~/ardy && .venv/bin/python merge-text-encoder.py --dest ~/cclay-text-encoders

Why this exists: transformers v5 removed the automatic PEFT-adapter
resolution that `from_pretrained` did in v4 (`find_adapter_config_file` is
gone from modeling_utils). ARDY's vendored LLM2Vec loader relies on that
behavior — it points `from_pretrained` at the MNTP *adapter* repo and lets
transformers chase `adapter_config.json` to the (gated) base. Under v5 that
path simply fails with "no model.safetensors found".

So instead of an adapter directory, the local MNTP path becomes a full
model: this script loads the ungated base (NousResearch mirror, already
hash-verified by setup-text-encoder.py), applies the MNTP LoRA with peft,
`merge_and_unload()`s it — the exact math upstream LLM2Vec performs at load
time — and saves the merged weights to the path ARDY's TEXT_ENCODERS_DIR
override resolves. Plain full-model loading works identically under
transformers v4 and v5; the supervised LoRA keeps loading through peft
directly, which both versions support.

Layout before:  <dest>/McGill-NLP/...-mntp        (downloaded adapter files)
Layout after:   <dest>/McGill-NLP/...-mntp-src    (the downloads, kept for
                                                   provenance + re-merges)
                <dest>/McGill-NLP/...-mntp        (merged full model +
                                                   tokenizer + MERGE_MANIFEST)

The merged config.json keeps `_name_or_path` =
"meta-llama/Meta-Llama-3-8B-Instruct": it is a metadata string (no download
or gate involved) that LLM2Vec's `prepare_for_tokenization` matches to pick
the Llama-3 chat template — losing it would silently change every prompt
embedding.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys

BASE = "NousResearch/Meta-Llama-3-8B-Instruct"
MNTP = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
MNTP_SRC = MNTP + "-src"
NAME_OR_PATH = "meta-llama/Meta-Llama-3-8B-Instruct"
TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]


def log(msg):
    print("merge-text-encoder: %s" % msg, flush=True)


def fail(msg):
    print("merge-text-encoder: ERROR: %s" % msg, file=sys.stderr, flush=True)
    sys.exit(1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", default=os.environ.get(
        "TEXT_ENCODERS_DIR", os.path.expanduser("~/cclay-text-encoders")))
    args = ap.parse_args()
    dest = os.path.abspath(os.path.expanduser(args.dest))
    base_dir = os.path.join(dest, BASE)
    mntp_dir = os.path.join(dest, MNTP)
    src_dir = os.path.join(dest, MNTP_SRC)

    if not os.path.isfile(os.path.join(base_dir, "model.safetensors.index.json")):
        fail("base model missing under %s — run setup-text-encoder.py first" % base_dir)

    # Migrate a pre-merge tree: the download step used to land the adapter
    # files directly at the mntp path.
    if os.path.isdir(mntp_dir) and not os.path.isdir(src_dir) \
            and os.path.isfile(os.path.join(mntp_dir, "adapter_model.safetensors")) \
            and not os.path.isfile(os.path.join(mntp_dir, "model.safetensors.index.json")):
        os.rename(mntp_dir, src_dir)
        log("moved downloaded adapter layout to %s" % MNTP_SRC)

    if not os.path.isfile(os.path.join(src_dir, "adapter_model.safetensors")):
        fail("MNTP adapter missing under %s — run setup-text-encoder.py first" % src_dir)

    adapter_sha = sha256_file(os.path.join(src_dir, "adapter_model.safetensors"))
    manifest_path = os.path.join(mntp_dir, "MERGE_MANIFEST.json")
    if os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        if manifest.get("mntp_adapter_sha256") == adapter_sha \
                and os.path.isfile(os.path.join(mntp_dir, "model.safetensors.index.json")):
            log("merged model already present and matches the adapter hash — nothing to do")
            return

    import torch  # deferred: keep --help fast and errors readable
    import peft
    import transformers
    from peft import PeftModel
    from ardy.model.llm2vec.llm2vec import LLM2Vec

    log("loading base (bfloat16, cpu) from %s" % base_dir)
    model_class = LLM2Vec._get_model_class("LlamaConfig", enable_bidirectional=True)
    model = model_class.from_pretrained(base_dir, torch_dtype=torch.bfloat16)

    log("applying + merging the MNTP LoRA from %s" % src_dir)
    model = PeftModel.from_pretrained(model, src_dir)
    model = model.merge_and_unload()

    tmp_out = mntp_dir + ".merging"
    if os.path.isdir(tmp_out):
        shutil.rmtree(tmp_out)
    log("saving merged model to %s" % mntp_dir)
    model.save_pretrained(tmp_out, safe_serialization=True)
    del model

    for name in TOKENIZER_FILES:
        src = os.path.join(src_dir, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(tmp_out, name))

    # Preserve the chat-template key and the source architecture label.
    cfg_path = os.path.join(tmp_out, "config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    with open(os.path.join(src_dir, "config.json"), "r", encoding="utf-8") as f:
        src_cfg = json.load(f)
    cfg["_name_or_path"] = NAME_OR_PATH
    if "architectures" in src_cfg:
        cfg["architectures"] = src_cfg["architectures"]
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")

    with open(os.path.join(tmp_out, "MERGE_MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump({
            "base": BASE,
            "mntp_adapter_sha256": adapter_sha,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "peft": peft.__version__,
            "name_or_path": NAME_OR_PATH,
        }, f, indent=2)
        f.write("\n")

    if os.path.isdir(mntp_dir):
        shutil.rmtree(mntp_dir)
    os.rename(tmp_out, mntp_dir)
    log("done — %s is a full merged model; the supervised LoRA stays a peft adapter" % MNTP)


if __name__ == "__main__":
    main()
