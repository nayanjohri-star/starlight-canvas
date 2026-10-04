#!/usr/bin/env bash
# setup-text-encoder-on-box.sh - provision the ARDY text-encoder models on the
# remote box WITHOUT a Hugging Face account, gated-access approval, or token.
#
#   CCLAY_ARDY_HOST=user@gpu-box tools/ardy/setup-text-encoder-on-box.sh
#   ... --verify-only     re-hash an existing tree on the box, download nothing
#
# Copies setup-text-encoder.py to a fresh remote temp dir (nothing is written
# inside the ARDY checkout, same rule as run-on-box.sh), runs it with the
# box's python3, and removes the script afterwards. The models land under
# CCLAY_ARDY_ENCODERS_DIR (default ~/cclay-text-encoders on the box, kept
# across re-runs; re-running only verifies and fills gaps).
#
# env (names shared with run-on-box.sh / sync-to-box):
#   CCLAY_ARDY_HOST          ssh destination for the ARDY host (required)
#   CCLAY_ARDY_ENCODERS_DIR  TEXT_ENCODERS_DIR on the box
#                            (default $HOME/cclay-text-encoders, box-side)
#   CCLAY_ARDY_REPO          ARDY checkout on the box (default $HOME/ardy)
#   CCLAY_ARDY_ENC_VENV      encoder venv python on the box
#                            (default ~/ardy/.venv/bin/python — the CPU
#                            text-encoder venv, NOT the .venv-cuda generator)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${CCLAY_ARDY_HOST:-}"
# Escaped so the REMOTE shell expands $HOME, the same trick run-on-box.sh uses.
ENCODERS_DIR="${CCLAY_ARDY_ENCODERS_DIR:-\$HOME/cclay-text-encoders}"
REPO="${CCLAY_ARDY_REPO:-\$HOME/ardy}"
# Literal ~ so the REMOTE shell tilde-expands it, like run-on-box.sh's VENV_PY.
VENV_PY="${CCLAY_ARDY_ENC_VENV:-~/ardy/.venv/bin/python}"

[[ -n "$HOST" ]] || {
  echo "setup-text-encoder-on-box: set CCLAY_ARDY_HOST (e.g. user@gpu-box)" >&2
  exit 1
}

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=240)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

if ! ssh "${SSH_OPTS[@]}" "$HOST" ":" </dev/null; then
  echo "setup-text-encoder-on-box: cannot ssh to ${HOST}" >&2
  exit 1
fi
echo "setup-text-encoder-on-box: ssh to ${HOST} ok"

if ! REMOTE_TMP="$(ssh "${SSH_OPTS[@]}" "$HOST" "mktemp -d" </dev/null)"; then
  echo "setup-text-encoder-on-box: mktemp on ${HOST} failed" >&2
  exit 1
fi
[[ "$REMOTE_TMP" == /* ]] || {
  echo "setup-text-encoder-on-box: remote mktemp returned non-absolute '${REMOTE_TMP}'; aborting" >&2
  exit 1
}
trap 'ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf ${REMOTE_TMP}" </dev/null >/dev/null 2>&1 || true' EXIT

scp -q "${SCP_OPTS[@]}" "${HERE}/setup-text-encoder.py" "$HOST:${REMOTE_TMP}/setup-text-encoder.py"
scp -q "${SCP_OPTS[@]}" "${HERE}/merge-text-encoder.py" "$HOST:${REMOTE_TMP}/merge-text-encoder.py"

# Forward optional flags (--verify-only / --print-plan) verbatim; each one is
# %q-quoted like every other remote arg in this toolset.
EXTRA=""
for arg in "$@"; do
  EXTRA+=" $(printf '%q' "$arg")"
done

# shellcheck disable=SC2029  # ENCODERS_DIR/REMOTE_TMP expand remotely by design
ssh "${SSH_OPTS[@]}" "$HOST" \
  "python3 ${REMOTE_TMP}/setup-text-encoder.py --dest \"${ENCODERS_DIR}\"${EXTRA}" </dev/null

# Bake the MNTP merge unless this was a flag-only run (--verify-only /
# --print-plan download nothing, so there is nothing new to merge). The merge
# runs inside the ARDY checkout under the encoder venv (torch + peft + the
# ardy package) and is idempotent: it no-ops when the merged model already
# matches the adapter hash.
if [[ -z "$EXTRA" ]]; then
  # shellcheck disable=SC2029  # remote expansion by design
  ssh "${SSH_OPTS[@]}" "$HOST" \
    "cd ${REPO} && ${VENV_PY} ${REMOTE_TMP}/merge-text-encoder.py --dest \"${ENCODERS_DIR}\"" </dev/null
fi

cat <<'EOF'

setup-text-encoder-on-box: done.

Restart the text-encoder service on the box with TEXT_ENCODERS_DIR set, e.g.:

  ssh $CCLAY_ARDY_HOST
  cd ~/ardy
  TEXT_ENCODERS_DIR=$HOME/cclay-text-encoders \
    .venv/bin/python scripts/run_text_encoder_server.py

No Hugging Face login or token is needed on the box from now on.
EOF
