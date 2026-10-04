#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${CCLAY_ARDY_HOST:-}"
REMOTE="${CCLAY_ARDY_REPO:-\$HOME/ardy}"
VENV_PY="${CCLAY_ARDY_VENV:-~/ardy/.venv-cuda/bin/python}"
SCRIPT="$HERE/cclay_motion_edit.py"
SOURCE=""
MANIFEST=""
PROMPT=""
OUTPUT=""
SEED=""
CONTEXT_BEFORE=40
CONTEXT_AFTER=20
POSES=()

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=240)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

usage() {
  echo "usage: run-edit-on-box.sh --source motion.npz --manifest edits.json --prompt TEXT --output out.npz [--seed N] [--context-before N] [--context-after N]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --seed) SEED="${2:-}"; shift 2 ;;
    --context-before) CONTEXT_BEFORE="${2:-}"; shift 2 ;;
    --context-after) CONTEXT_AFTER="${2:-}"; shift 2 ;;
    --pose) POSES+=("${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$HOST" ]] || {
  echo "run-edit-on-box: CCLAY_ARDY_HOST is required (for example: user@ardy-host)" >&2
  exit 2
}

[[ -f "$SOURCE" && -f "$MANIFEST" && -f "$SCRIPT" && -n "$PROMPT" && -n "$OUTPUT" ]] || usage
[[ ${#POSES[@]} -gt 0 ]] || usage
[[ "$CONTEXT_BEFORE" =~ ^[0-9]+$ && "$CONTEXT_AFTER" =~ ^[0-9]+$ ]] || usage
[[ -z "$SEED" || "$SEED" =~ ^[0-9]+$ ]] || usage

mkdir -p "$(dirname "$OUTPUT")"
REMOTE_TMP="$(ssh "${SSH_OPTS[@]}" "$HOST" "mktemp -d" </dev/null)"
[[ "$REMOTE_TMP" == /* ]] || { echo "run-edit-on-box: unsafe remote temp path" >&2; exit 1; }
trap 'ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf ${REMOTE_TMP}" </dev/null >/dev/null 2>&1 || true' EXIT

scp -q "${SCP_OPTS[@]}" "$SOURCE" "$HOST:${REMOTE_TMP}/source.npz"
scp -q "${SCP_OPTS[@]}" "$MANIFEST" "$HOST:${REMOTE_TMP}/manifest.json"
scp -q "${SCP_OPTS[@]}" "$SCRIPT" "$HOST:${REMOTE_TMP}/edit.py"
for ((i = 0; i < ${#POSES[@]}; i += 1)); do
  [[ -f "${POSES[$i]}" ]] || { echo "run-edit-on-box: missing pose ${POSES[$i]}" >&2; exit 1; }
  scp -q "${SCP_OPTS[@]}" "${POSES[$i]}" "$HOST:${REMOTE_TMP}/pose-${i}.npz"
done

CMD="cd ${REMOTE} && ${VENV_PY} ${REMOTE_TMP}/edit.py"
CMD+=" --source ${REMOTE_TMP}/source.npz --manifest ${REMOTE_TMP}/manifest.json"
CMD+=" --prompt $(printf '%q' "$PROMPT") --output ${REMOTE_TMP}/out.npz"
CMD+=" --context-before ${CONTEXT_BEFORE} --context-after ${CONTEXT_AFTER}"
[[ -z "$SEED" ]] || CMD+=" --seed ${SEED}"

echo "run-edit-on-box: editing with ARDY history and sparse constraints ..."
ssh "${SSH_OPTS[@]}" "$HOST" "$CMD" </dev/null
scp -q "${SCP_OPTS[@]}" "$HOST:${REMOTE_TMP}/out.npz" "$OUTPUT"
[[ -s "$OUTPUT" ]] || { echo "run-edit-on-box: empty output" >&2; exit 1; }
echo "run-edit-on-box: done - ${OUTPUT} ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"
