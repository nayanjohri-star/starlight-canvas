#!/usr/bin/env bash
# run-on-box.sh - generate an ARDY clip on the remote box.
#
#   run-on-box.sh [<pose.npz>] --base <motion-id|npz-path> --prompt "<prompt>" \
#     --duration <seconds> [--dst-frame <N>] [--src-frame <N>] [--seed <S>] \
#     [--root-2d FRAME X Z HEADING ...] [--output <local.npz>] [--dry-run]

#
# The pose npz is an ARDY motion npz (it must carry local_rot_mats and
# posed_joints; the frame at SRC_FRAME holds the pose). It is pushed to a
# fresh remote temp dir and handed to the generator as
#   --pose-from <tmp>/pose.npz <src-frame> <dst-frame>
# which pins the FULL-BODY pose onto <dst-frame> of the new clip. The base
# motion supplies the unconstrained first pass (--base) and the generated
# npz is pulled back. Nothing is ever written inside the ARDY checkout: the
# base npz is read from ~/ardy/outputs/ (or outputs/omb/), the pose and the
# result live under the remote temp dir, and the temp dir is removed on
# exit.
#
# Three modes, chosen by what is given:
#   pose       <pose.npz> present (the default): the pose npz is pushed to a
#              fresh remote temp dir and handed to the constrained generator
#              as --pose-from <tmp>/pose.npz <src-frame> <dst-frame>, pinning
#              the FULL-BODY pose onto <dst-frame> of the new clip. Requires
#              --base and --dst-frame.
#   waypoints  no pose npz but one or more --root-2d groups: the constrained
#              generator runs WITHOUT --pose-from, so the clip follows the
#              path and prompt only, with no full-body pose constraint.
#              --dst-frame is ignored. --base is optional: given, it is the
#              unconstrained first pass; omitted, the script free-generates
#              the base clip itself first (two-pass mode: scripts/generate.py
#              with the same prompt/duration/seed under the remote temp dir,
#              then the constrained pass with --base pointing at that npz).
#   free       no pose npz and no --root-2d: scripts/generate.py on the box,
#              the unconstrained generator (the constrained script refuses a
#              run with no target, pose or waypoint). --base and --dst-frame
#              are ignored.
#
# Each --root-2d group pins the root on the X/Z ground plane at one 0-based
# clip frame (ARDY is Y-up; the horizontal plane is X and Z in meters, Y is
# not constrained). X and Z must be within -20..20, HEADING is a yaw in
# radians within -2π..2π or the literal 'none' to leave facing free. The
# request carries 2..32 sparse authored keys starting at frame 0. Intermediate
# root positions are left for the model to generate. Values are validated
# locally and %q-quoted into the remote command like all other args.
#
# CPU is forced with CUDA_VISIBLE_DEVICES="" and that is deliberate: the
# box's RTX 3070 has only 8.2 GB VRAM against 94 GB RAM, and nvidia-smi is
# broken there (NVML driver/library version mismatch) even though
# torch.cuda.is_available() still returns True - so without the override the
# generator's `device = "cuda:0" if torch.cuda.is_available() else "cpu"`
# line would pick a GPU that cannot hold the model. The preflight probe
# below mirrors that exact line under the same env and prints the device the
# generator will actually use.
#
# env (names shared with CozyClay scripts/ardy/sync-to-box):
#   CCLAY_ARDY_HOST  ssh destination for the ARDY host (required)
#   CCLAY_ARDY_REPO  ARDY checkout on the box       (default $HOME/ardy)
#   CCLAY_ARDY_VENV  venv python on the box         (default ~/ardy/.venv-cuda/bin/python)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${CCLAY_ARDY_HOST:-}"
# REMOTE's default is escaped so the REMOTE shell expands $HOME (the same
# trick sync-to-box uses); VENV_PY's default keeps a literal ~ so the REMOTE
# shell tilde-expands it. Both resolve to the same ~/ardy on the box.
REMOTE="${CCLAY_ARDY_REPO:-\$HOME/ardy}"
# The box carries two venvs and they are NOT interchangeable: .venv runs the
# CPU text-encoder service, .venv-cuda is what the motion generator was actually
# run under (scripts/generate.py in generate_pc_monitor.log, 1060 MiB of VRAM).
VENV_PY="${CCLAY_ARDY_VENV:-~/ardy/.venv-cuda/bin/python}"
# Text encoder URL the generator falls back to when TEXT_ENCODER_URL is unset:
# ardy/model/registry.py:47 DEFAULT_TEXT_ENCODER_URL. Generation dies without it,
# so the preflight checks it rather than letting the run fail minutes in.
ENCODER_URL="${CCLAY_ARDY_ENCODER_URL:-http://127.0.0.1:9550/}"
# Force the motion model onto the CPU as well. Off by default: the encoder --
# the part that does not fit beside the model in 8.2 GB -- already runs on the
# CPU as its own service, and the model itself only needs about 1 GB.
FORCE_CPU=0

# BatchMode: never hang on a password prompt mid-pipeline. ConnectTimeout
# fails fast on a dead host; ServerAlive* drops a wedged connection instead
# of leaving the user staring at a silent ssh (30 s interval * 240 = 2 h).
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=240)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

usage() {
  cat >&2 <<'EOF'
usage: run-on-box.sh [<pose.npz>] --base <motion-id|npz-path> --prompt "<prompt>" \
       --duration <seconds> [--dst-frame <N>] [--src-frame <N>] [--seed <S>] \
       [--root-2d FRAME X Z HEADING ...] [--output <local.npz>] [--dry-run]


  <pose.npz>    OPTIONAL local ARDY motion npz (local_rot_mats +
posed_joints) whose frame <src-frame> holds the CozyClay
                pose to honour. Omit it to generate without a full-body pose
                constraint: with --root-2d groups the clip is
                path/prompt-only constrained (with --base, or two-pass: the
                free generator produces the base clip first); without them
                it is free generation (scripts/generate.py on the box).
  --base        base motion on the box: a bare id or bare <name>.npz
                (looked up in ~/ardy/outputs/<name>.npz, then
                ~/ardy/outputs/omb/<name>.npz), or a path containing /
                relative to the ARDY checkout / absolute. Required in pose
                mode; optional in waypoints mode (omitted = two-pass: the
                free generator first produces the base clip on the box);
                ignored in free mode.
  --prompt      generation prompt for the constrained clip
  --duration    clip duration in seconds (20 fps, 0.15..1200)
  --dst-frame   clip frame to pin the pose onto, 0 <= dst < duration*20
                (pose mode only)
  --src-frame   frame of <pose.npz> to copy (default 0; pose mode only)
  --seed        optional seed for reproducible results
  --output      local destination for the generated npz
                (default tools/ardy/out/<pose>-constrained.npz, or
                tools/ardy/out/<epoch>-generated.npz without a pose)

  --dry-run     run the preflight checks, print the exact remote command,
                and exit without pushing, generating, or pulling
  --root-2d     repeatable root waypoint: FRAME (0-based, inside the clip),
                X and Z in meters within -20..20 (ARDY is Y-up; the ground
                plane is X/Z, Y is not constrained), HEADING a yaw in
                radians within -2π..2π or the literal 'none' to leave
                facing free. Supply 2..32 sparse keys beginning at frame 0;
                ARDY generates all intermediate root motion.

env:
  CCLAY_ARDY_HOST  ssh destination for the ARDY host (required)
  CCLAY_ARDY_REPO  ARDY checkout on the box     (default $HOME/ardy)
  --cpu         also run the motion model on the CPU (slower; the text encoder
                is on the CPU either way, as its own service)

env:
  CCLAY_ARDY_VENV          venv python on the box (default ~/ardy/.venv-cuda/bin/python)
  CCLAY_ARDY_ENCODER_URL   text encoder service   (default http://127.0.0.1:9550/)
EOF
  exit 2
}

POSE_NPZ="" # legacy positional pose; normalized into POSE_ARGS after parsing
POSE_ARGS=() # repeatable triples: LOCAL_NPZ SRC_FRAME DST_FRAME
ROOT_MARGIN=""
CONTACT_THRESHOLD=""
HISTORY_FRAMES=""
BASE=""
PROMPT=""
DURATION=""
DST_FRAME=""
SRC_FRAME=0
SEED=""
OUTPUT=""
DRY_RUN=0
ROOT_2D_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      [[ $# -ge 2 ]] || { echo "run-on-box: --base needs a motion id or npz path" >&2; usage; }
      BASE="$2"; shift 2 ;;
    --prompt)
      [[ $# -ge 2 ]] || { echo "run-on-box: --prompt needs text" >&2; usage; }
      PROMPT="$2"; shift 2 ;;
    --duration)
      [[ $# -ge 2 ]] || { echo "run-on-box: --duration needs seconds" >&2; usage; }
      [[ "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "run-on-box: --duration must be a number, got '$2'" >&2; usage; }
      DURATION="$2"; shift 2 ;;
    --dst-frame)
      [[ $# -ge 2 ]] || { echo "run-on-box: --dst-frame needs a frame number" >&2; usage; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "run-on-box: --dst-frame must be a non-negative integer, got '$2'" >&2; usage; }
      DST_FRAME="$2"; shift 2 ;;
    --src-frame)
      [[ $# -ge 2 ]] || { echo "run-on-box: --src-frame needs a frame number" >&2; usage; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "run-on-box: --src-frame must be a non-negative integer, got '$2'" >&2; usage; }
      SRC_FRAME="$2"; shift 2 ;;
    --seed)
      [[ $# -ge 2 ]] || { echo "run-on-box: --seed needs an integer" >&2; usage; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "run-on-box: --seed must be a non-negative integer, got '$2'" >&2; usage; }
      SEED="$2"; shift 2 ;;
    --pose-from)
      [[ $# -ge 4 ]] || { echo "run-on-box: --pose-from needs LOCAL_NPZ SRC_FRAME DST_FRAME" >&2; usage; }
      [[ "$3" =~ ^[0-9]+$ && "$4" =~ ^[0-9]+$ ]] || { echo "run-on-box: --pose-from frames must be non-negative integers" >&2; usage; }
      POSE_ARGS+=("$2" "$3" "$4"); shift 4 ;;
    --root-2d)
      [[ $# -ge 5 ]] || { echo "run-on-box: --root-2d needs FRAME X Z HEADING" >&2; usage; }
      ROOT_2D_ARGS+=("$2" "$3" "$4" "$5"); shift 5 ;;
    --cpu)
      FORCE_CPU=1; shift ;;
    --root-margin)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "run-on-box: --root-margin needs a non-negative number" >&2; usage; }
      ROOT_MARGIN="$2"; shift 2 ;;
    --history-frames)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "run-on-box: --history-frames needs a non-negative integer" >&2; usage; }
      HISTORY_FRAMES="$2"; shift 2 ;;
    --contact-threshold)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "run-on-box: --contact-threshold needs a non-negative number" >&2; usage; }
      CONTACT_THRESHOLD="$2"; shift 2 ;;
    --output)
      [[ $# -ge 2 ]] || { echo "run-on-box: --output needs a path" >&2; usage; }
      OUTPUT="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage ;;
    -*)
      echo "run-on-box: unknown option '$1'" >&2; usage ;;
    *)
      [[ -z "$POSE_NPZ" ]] || { echo "run-on-box: one pose npz only, got '$1'" >&2; usage; }
      POSE_NPZ="$1"; shift ;;
  esac
done

[[ -n "$HOST" ]] || {
  echo "run-on-box: CCLAY_ARDY_HOST is required (for example: user@ardy-host)" >&2
  exit 2
}

# Normalize the legacy positional pose into the repeatable pose list.
if [[ -n "$POSE_NPZ" ]]; then
  [[ -n "$DST_FRAME" ]] || usage
  POSE_ARGS+=("$POSE_NPZ" "$SRC_FRAME" "$DST_FRAME")
fi

# Mode by what is given: one or more pose npz files pin the full body,
# waypoints alone constrain the path, and neither is free generation.
MODE=""
if [[ ${#POSE_ARGS[@]} -gt 0 ]]; then
  MODE="pose"
elif [[ ${#ROOT_2D_ARGS[@]} -gt 0 ]]; then
  MODE="waypoints"
else
  MODE="free"
fi
# Waypoints run the constrained generator: ONE model sampling call for the
# whole clip. ARDY's trained window is 10 s — frames beyond it sit outside
# the model's temporal horizon and the motion visibly degrades, so the last
# line of defence refuses what every upstream layer should already have.
if [[ "$MODE" == "waypoints" ]] && ! awk -v d="$DURATION" 'BEGIN { exit !(d <= 10) }'; then
  echo "run-on-box: --root-2d requires --duration <= 10 s (one-shot constrained generation; ARDY trained window), got ${DURATION}s" >&2
  exit 1
fi
# Waypoints without --base is two-pass: the free generator first produces
# the base clip on the box (pass 1), then the constrained pass uses it.
TWO_PASS=0
[[ "$MODE" == "waypoints" && -z "$BASE" ]] && TWO_PASS=1
IMPLICIT_POSE_BASE=0

[[ -n "$PROMPT" && -n "$DURATION" ]] || usage
if [[ "$MODE" == "pose" && -z "$BASE" ]]; then
  # Internal parser/reference baseline only. Full-body poses are the actual
  # constraints; users never select a semantic base motion.
  BASE="${CCLAY_ARDY_REFERENCE_BASE:-stand-upright-facing-forward-bring-both--0722140757}"
  IMPLICIT_POSE_BASE=1
fi
# --- local validation, mirroring the CozyClay wrapper's bounds -------------
if [[ "$MODE" == "pose" ]]; then
  for ((i = 0; i < ${#POSE_ARGS[@]}; i += 3)); do
    pose_path="${POSE_ARGS[$i]}"
    [[ -f "$pose_path" ]] || { echo "run-on-box: pose npz not found: $pose_path" >&2; exit 1; }
  done
fi

[[ -n "$PROMPT" ]] || { echo "run-on-box: --prompt must not be empty" >&2; exit 1; }
# The clip is int(duration * 20) frames at ARDY's 20 fps, capped at 1200 s
# like the wrapper; the remote rejects anything below 3 frames because
# inter-frame continuity is undefined there.
awk -v d="$DURATION" 'BEGIN { exit !(d > 0 && d <= 1200) }' || {
  echo "run-on-box: --duration must be > 0 and <= 1200 seconds, got '$DURATION'" >&2; exit 1; }
CLIP_FRAMES="$(awk -v d="$DURATION" 'BEGIN { printf "%d", d * 20 }')"
[[ "$CLIP_FRAMES" -ge 3 ]] || {
  echo "run-on-box: --duration ${DURATION}s yields ${CLIP_FRAMES} frame(s) at 20 fps; a clip needs at least 3" >&2; exit 1; }
if [[ "$MODE" == "pose" ]]; then
  for ((i = 0; i < ${#POSE_ARGS[@]}; i += 3)); do
    dst="${POSE_ARGS[$((i + 2))]}"
    awk -v f="$dst" -v m="$CLIP_FRAMES" 'BEGIN { exit !(f < m) }' || {
      echo "run-on-box: --pose-from destination $dst is outside 0..$((CLIP_FRAMES - 1)) (duration ${DURATION}s at 20 fps)" >&2; exit 1; }
  done
fi
# --- --root-2d validation: each group, then the set as a whole -------------
# Mirrors the bridge contract: 2..32 sparse keys beginning at frame 0,
# strictly ascending, X/Z in meters within -20..20, HEADING a finite number
# of radians within -2π..2π or the literal 'none'.
FLOAT_RE='^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
validate_root_2d() {
  local n="${#ROOT_2D_ARGS[@]}" i frame x z heading prev=-1 count
  [[ $((n % 4)) -eq 0 ]] || { echo "run-on-box: internal error: --root-2d group list is misaligned" >&2; exit 1; }
  count=$((n / 4))
  if [[ "$count" -ne 0 && ( "$count" -lt 2 || "$count" -gt 32 ) ]]; then
    echo "run-on-box: --root-2d needs 2..32 sparse waypoints, got $count" >&2
    exit 1
  fi
  for ((i = 0; i < n; i += 4)); do
    frame="${ROOT_2D_ARGS[$i]}"
    x="${ROOT_2D_ARGS[$((i + 1))]}"
    z="${ROOT_2D_ARGS[$((i + 2))]}"
    heading="${ROOT_2D_ARGS[$((i + 3))]}"
    [[ "$frame" =~ ^[0-9]+$ ]] || { echo "run-on-box: --root-2d FRAME must be a non-negative integer, got '$frame'" >&2; exit 1; }
    awk -v f="$frame" -v m="$CLIP_FRAMES" 'BEGIN { exit !(f >= 0 && f < m) }' || {
      echo "run-on-box: --root-2d frame $frame is outside 0..$((CLIP_FRAMES - 1)) (duration ${DURATION}s at 20 fps)" >&2
      exit 1
    }
    awk -v f="$frame" -v p="$prev" 'BEGIN { exit !(f > p) }' || {
      echo "run-on-box: --root-2d frames must be strictly ascending; frame $frame repeats or precedes frame $prev" >&2
      exit 1
    }
    if [[ $i -eq 0 && "$frame" -ne 0 ]]; then
      echo "run-on-box: --root-2d start must be at frame 0, got frame $frame" >&2
      exit 1
    fi
    prev="$frame"
    [[ "$x" =~ $FLOAT_RE ]] || { echo "run-on-box: --root-2d X must be a number, got '$x'" >&2; exit 1; }
    awk -v v="$x" 'BEGIN { exit !(v >= -20 && v <= 20) }' || {
      echo "run-on-box: --root-2d X $x is outside -20..20 meters" >&2
      exit 1
    }
    [[ "$z" =~ $FLOAT_RE ]] || { echo "run-on-box: --root-2d Z must be a number, got '$z'" >&2; exit 1; }
    awk -v v="$z" 'BEGIN { exit !(v >= -20 && v <= 20) }' || {
      echo "run-on-box: --root-2d Z $z is outside -20..20 meters" >&2
      exit 1
    }
    if [[ "$heading" != "none" ]]; then
      [[ "$heading" =~ $FLOAT_RE ]] || {
        echo "run-on-box: --root-2d HEADING must be a number of radians or the literal 'none', got '$heading'" >&2
        exit 1
      }
      awk -v h="$heading" 'BEGIN { pi = atan2(0, -1); exit !(h >= -2*pi && h <= 2*pi) }' || {
        echo "run-on-box: --root-2d HEADING $heading rad is outside -2π..2π" >&2
        exit 1
      }
    fi
  done
}
validate_root_2d
# SRC_FRAME indexes the pose npz; its real bound is only knowable on the
# box, so like the reference wrapper we accept any non-negative integer here
# and let the remote range-check it against the npz's frame count.
if [[ "$MODE" == "pose" ]]; then
  FIRST_POSE="${POSE_ARGS[0]}"
  OUTPUT="${OUTPUT:-$HERE/out/$(basename "${FIRST_POSE%.npz}")-constrained.npz}"
else
  OUTPUT="${OUTPUT:-$HERE/out/$(date +%s)-generated.npz}"
fi


# --- preflight: fail fast, cheapest first ---------------------------------
if ! ssh "${SSH_OPTS[@]}" "$HOST" ":" </dev/null; then
  echo "run-on-box: cannot ssh to ${HOST} (BatchMode). Check network reachability and the SSH key agent." >&2
  exit 1
fi
echo "run-on-box: ssh to ${HOST} ok"

# Free generation runs scripts/generate.py (the constrained script refuses a
# run with no target, pose or waypoint); every other mode runs the
# constrained generator. Two-pass waypoints mode needs BOTH scripts:
# generate.py for the free base pass, then the constrained script.
GEN_SCRIPT="scripts/cclay_constrained_generate.py"
[[ "$MODE" == "free" ]] && GEN_SCRIPT="scripts/generate.py"
GEN_CHECK="test -x ${VENV_PY} && test -f ${REMOTE}/${GEN_SCRIPT}"
GEN_LABEL="${REMOTE}/${GEN_SCRIPT}"
if [[ "$TWO_PASS" -eq 1 || "$IMPLICIT_POSE_BASE" -eq 1 ]]; then
  GEN_CHECK="test -x ${VENV_PY} && test -f ${REMOTE}/scripts/generate.py && test -f ${REMOTE}/scripts/cclay_constrained_generate.py"
  GEN_LABEL="${REMOTE}/scripts/generate.py and ${REMOTE}/scripts/cclay_constrained_generate.py"
fi
# shellcheck disable=SC2029  # REMOTE/VENV_PY expand remotely by design
if ! ssh "${SSH_OPTS[@]}" "$HOST" "$GEN_CHECK" </dev/null; then
  echo "run-on-box: ${HOST} is missing ${VENV_PY} or ${GEN_LABEL}; sync the ARDY sources to the box first (CozyClay scripts/ardy/sync-to-box --apply)" >&2
  exit 1
fi

# The constrained generator is cclay-owned: the repo copy next to this
# script is the source of truth, synced up on every run so the box can
# never drift behind it (same pattern as run-sequence-on-box.sh).
if ! ssh "${SSH_OPTS[@]}" "$HOST" "cat > ${REMOTE}/scripts/cclay_constrained_generate.py" \
  < "${HERE}/cclay_constrained_generate.py"; then
  echo "run-on-box: could not sync cclay_constrained_generate.py to ${HOST}" >&2
  exit 1
fi
echo "run-on-box: constrained generator synced to ${HOST}"
echo "run-on-box: venv python and generator script present on ${HOST}"


# Resolve --base on the box: anything containing a slash is a repo-relative
# or absolute path and passes through; a bare id or bare <name>.npz is
# looked up under outputs/ then outputs/omb/ (repo-relative, i.e.
# ~/ardy/outputs*). Free mode takes no base, and waypoints mode without one
# is two-pass: the pass-1 output is a fresh absolute temp path verified with
# a plain test -f at the pass-1 step, never through this candidate lookup.
if [[ -n "$BASE" ]]; then
  if [[ "$BASE" == */* ]]; then
    BASE_CANDIDATES="$(printf '%q' "$BASE")"
    BASE_LOOKED="'${BASE}'"
  else
    BASE_NAME="${BASE%.npz}"
    BASE_CANDIDATES="$(printf '%q' "outputs/${BASE_NAME}.npz") $(printf '%q' "outputs/omb/${BASE_NAME}.npz")"
    BASE_LOOKED="outputs/${BASE_NAME}.npz or outputs/omb/${BASE_NAME}.npz under ${REMOTE}"
  fi
  # shellcheck disable=SC2029  # REMOTE expands remotely by design
  if ! BASE_RESOLVED="$(ssh "${SSH_OPTS[@]}" "$HOST" "cd ${REMOTE} && for c in ${BASE_CANDIDATES}; do if test -f \"\$c\"; then printf '%s' \"\$c\"; exit 0; fi; done; exit 1" </dev/null)"; then
    echo "run-on-box: base motion '${BASE}' does not exist on ${HOST} (looked for ${BASE_LOOKED})" >&2
    exit 1
  fi
  echo "run-on-box: base motion on ${HOST}: ${BASE_RESOLVED}"
fi

# The hidden upright reference is only a convenient baseline when it is long
# enough. A loaded clip can be longer than that fixture; in that case generate
# an exact-duration base first instead of letting cclay_constrained_generate.py
# fail after model load with "base has N frames but requested M".
if [[ "$IMPLICIT_POSE_BASE" -eq 1 ]]; then
  # shellcheck disable=SC2029  # resolved path is selected from the box listing
  if ! BASE_FRAMES="$(ssh "${SSH_OPTS[@]}" "$HOST" \
    "cd ${REMOTE} && ${VENV_PY} -c 'import numpy as np,sys; print(np.load(sys.argv[1])[\"local_rot_mats\"].shape[0])' $(printf '%q' "$BASE_RESOLVED")" </dev/null)"; then
    echo "run-on-box: could not inspect implicit pose base ${BASE_RESOLVED}" >&2
    exit 1
  fi
  [[ "$BASE_FRAMES" =~ ^[0-9]+$ ]] || {
    echo "run-on-box: implicit pose base returned invalid frame count '${BASE_FRAMES}'" >&2
    exit 1
  }
  if [[ "$BASE_FRAMES" -lt "$CLIP_FRAMES" ]]; then
    echo "run-on-box: implicit pose base has ${BASE_FRAMES} frames; will free-generate ${CLIP_FRAMES}-frame base first"
    BASE_RESOLVED=""
    TWO_PASS=1
  fi
fi


# Probe the device the generator will use, with the SAME env it will run
# under (CUDA_VISIBLE_DEVICES="" included). The one-liner mirrors the
# generator's `device = "cuda:0" if torch.cuda.is_available() else "cpu"`
# exactly, so what is printed is what the generation will pick.
# shellcheck disable=SC2029  # REMOTE/VENV_PY expand remotely by design
CUDA_ENV=""
[[ "$FORCE_CPU" -eq 1 ]] && CUDA_ENV='CUDA_VISIBLE_DEVICES="" '

# The text encoder is a separate CPU service; without it the generator loads the
# model, then dies. Check it before spending minutes on the rest.
if ! ENCODER_CODE="$(ssh "${SSH_OPTS[@]}" "$HOST" "curl -s -o /dev/null -w '%{http_code}' -m 10 ${ENCODER_URL}" </dev/null)"; then
  echo "run-on-box: could not reach ${HOST} to probe the text encoder" >&2
  exit 1
fi
if [[ "$ENCODER_CODE" != "200" ]]; then
  echo "run-on-box: text encoder at ${ENCODER_URL} answered '${ENCODER_CODE}', not 200." >&2
  echo "run-on-box: start it with:  ssh ${HOST} 'cd ~/ardy && .venv/bin/python -u scripts/run_text_encoder_server.py --host 127.0.0.1 --port 9550 --device cpu'" >&2
  exit 1
fi
echo "run-on-box: text encoder ${ENCODER_URL} responding (cpu service)"

if ! DEVICE="$(ssh "${SSH_OPTS[@]}" "$HOST" "cd ${REMOTE} && ${CUDA_ENV}${VENV_PY} -c 'import torch; print(\"cuda:0\" if torch.cuda.is_available() else \"cpu\")'" </dev/null)"; then
  echo "run-on-box: device probe on ${HOST} failed (venv python erroring?)" >&2
  exit 1
fi
[[ -n "$DEVICE" ]] || { echo "run-on-box: device probe on ${HOST} returned nothing" >&2; exit 1; }
echo "run-on-box: generator will use device '${DEVICE}' on ${HOST}"

# --- the generator invocation ---------------------------------------------
# Args are shell-quoted with printf %q so prompts and paths survive the
# remote shell. The output base is absolute (under the remote temp dir), so
# the generator's _resolve_output_base honors it instead of placing it under
# outputs/.
# scripts/generate.py is the unconstrained generator: its prompt is
# positional and it has no --base / --pose-from / --root-2d. Used for free
# mode and for the two-pass base pass (pass 1); the npz lands at
# <out_base>.npz.
build_free_cmd() {
  local out_base="$1" cmd
  cmd="cd ${REMOTE} && ${CUDA_ENV}${VENV_PY} scripts/generate.py $(printf '%q' "$PROMPT")"
  cmd+=" --duration $(printf '%q' "$DURATION")"
  cmd+=" --output $(printf '%q' "$out_base")"
  if [[ -n "$SEED" ]]; then
    cmd+=" --seed $(printf '%q' "$SEED")"
  fi
  printf '%s' "$cmd"
}

build_remote_cmd() {
  local tmp_dir="$1" cmd i
  # Two-pass waypoints mode has no user base: BASE_RESOLVED stays empty and
  # pass 1's output npz (under the same remote temp dir, cleaned by the EXIT
  # trap) becomes the --base of the constrained pass.
  local base_arg="${BASE_RESOLVED:-${tmp_dir}/base.npz}"
  if [[ "$MODE" == "free" ]]; then
    cmd="$(build_free_cmd "${tmp_dir}/out")"
  else
    cmd="cd ${REMOTE} && ${CUDA_ENV}${VENV_PY} scripts/cclay_constrained_generate.py"
    cmd+=" --prompt $(printf '%q' "$PROMPT")"
    cmd+=" --duration $(printf '%q' "$DURATION")"
    cmd+=" --base $(printf '%q' "$base_arg")"
    if [[ "$MODE" == "pose" ]]; then
      for ((i = 0; i < ${#POSE_ARGS[@]}; i += 3)); do
        pose_index=$((i / 3))
        cmd+=" --pose-from $(printf '%q' "${tmp_dir}/pose-${pose_index}.npz")"
        cmd+=" $(printf '%q' "${POSE_ARGS[$((i + 1))]}") $(printf '%q' "${POSE_ARGS[$((i + 2))]}")"
      done
    fi
    # Each validated --root-2d group is %q-quoted value by value, so no
    # waypoint text can ever reach the remote shell unquoted.
    for ((i = 0; i < ${#ROOT_2D_ARGS[@]}; i += 4)); do
      cmd+=" --root-2d $(printf '%q' "${ROOT_2D_ARGS[$i]}")"
      cmd+=" $(printf '%q' "${ROOT_2D_ARGS[$((i + 1))]}")"
      cmd+=" $(printf '%q' "${ROOT_2D_ARGS[$((i + 2))]}")"
      cmd+=" $(printf '%q' "${ROOT_2D_ARGS[$((i + 3))]}")"
    done
    [[ -z "$ROOT_MARGIN" ]] || cmd+=" --root-margin $(printf '%q' "$ROOT_MARGIN")"
    [[ -z "$CONTACT_THRESHOLD" ]] || cmd+=" --contact-threshold $(printf '%q' "$CONTACT_THRESHOLD")"
    [[ -z "$HISTORY_FRAMES" ]] || cmd+=" --history_frames $(printf '%q' "$HISTORY_FRAMES")"
    cmd+=" --output $(printf '%q' "${tmp_dir}/out")"
    if [[ -n "$SEED" ]]; then
      cmd+=" --seed $(printf '%q' "$SEED")"
    fi
  fi
  printf '%s' "$cmd"
}


if [[ $DRY_RUN -eq 1 ]]; then
  REMOTE_TMP_PLACEHOLDER="<mktemp-dir-on-box>"
  MODE_LABEL="free generation (generate.py)"
  [[ "$MODE" == "pose" ]] && MODE_LABEL="full-body pose pin"
  [[ "$MODE" == "waypoints" ]] && MODE_LABEL="frame-0 root start + prompt (no pose)"
  [[ "$MODE" == "waypoints" && "$TWO_PASS" -eq 1 ]] && MODE_LABEL="frame-0 root start + prompt (no pose) - two-pass (free base first)"
  echo "run-on-box: DRY RUN - preflight done, nothing pushed, nothing generated, nothing pulled."
  echo "run-on-box: mode        ${MODE} - ${MODE_LABEL}"
  [[ "$MODE" == "pose" ]] || echo "run-on-box: pose npz    <none>"
  [[ "$MODE" != "pose" ]] || echo "run-on-box: pose pins   $(( ${#POSE_ARGS[@]} / 3 ))"
  if [[ "$TWO_PASS" -eq 1 ]]; then
    echo "run-on-box: base motion pass-1 output ${REMOTE_TMP_PLACEHOLDER}/base.npz on ${HOST} (free-generated first)"
  else
    [[ -z "${BASE_RESOLVED:-}" ]] || echo "run-on-box: base motion ${BASE_RESOLVED} on ${HOST}"
  fi
  echo "run-on-box: device      ${DEVICE}"
  echo "run-on-box: root-2d    $(( ${#ROOT_2D_ARGS[@]} / 4 )) waypoint(s)"
  [[ "$MODE" != "pose" ]] || echo "run-on-box: would push  $(( ${#POSE_ARGS[@]} / 3 )) pose npz file(s) to ${HOST}:${REMOTE_TMP_PLACEHOLDER}"
  if [[ "$TWO_PASS" -eq 1 ]]; then
    echo "run-on-box: pass 1/2   would run  ssh ${HOST} \"$(build_free_cmd "${REMOTE_TMP_PLACEHOLDER}/base")\""
    echo "run-on-box: pass 2/2   would run  ssh ${HOST} \"$(build_remote_cmd "$REMOTE_TMP_PLACEHOLDER")\""
  else
    echo "run-on-box: would run   ssh ${HOST} \"$(build_remote_cmd "$REMOTE_TMP_PLACEHOLDER")\""
  fi
  echo "run-on-box: would pull  scp -q -o BatchMode=yes ${HOST}:${REMOTE_TMP_PLACEHOLDER}/out.npz ${OUTPUT}"
  echo "run-on-box: would clean ssh ${HOST} \"rm -rf ${REMOTE_TMP_PLACEHOLDER}\""
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"

# Fresh temp dir on the box; the EXIT trap removes it even on failure, and
# cleanup failure never masks the real result. Guard the path (must be
# absolute, as mktemp guarantees) before it can reach the cleanup rm -rf.
if ! REMOTE_TMP="$(ssh "${SSH_OPTS[@]}" "$HOST" "mktemp -d" </dev/null)"; then
  echo "run-on-box: could not create a temp dir on ${HOST} (mktemp failed)" >&2
  exit 1
fi
[[ "$REMOTE_TMP" == /* ]] || { echo "run-on-box: remote mktemp returned a non-absolute path '${REMOTE_TMP}'; aborting" >&2; exit 1; }
trap 'ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf ${REMOTE_TMP}" </dev/null >/dev/null 2>&1 || true' EXIT

if [[ "$TWO_PASS" -eq 1 ]]; then
  # Pass 1: free-generate the base clip with the same prompt/duration/seed
  # the constrained pass will use. Its npz lives under REMOTE_TMP, so the
  # EXIT trap removes it with everything else.
  PASS1_CMD="$(build_free_cmd "${REMOTE_TMP}/base")"
  echo "run-on-box: pass 1/2: free-generating base clip on ${HOST} ..."
  # shellcheck disable=SC2029  # PASS1_CMD is a remote command by design
  ssh "${SSH_OPTS[@]}" "$HOST" "$PASS1_CMD" </dev/null
  BASE_RESOLVED="${REMOTE_TMP}/base.npz"
  # The pass-1 output is a fresh absolute temp path, not a listed base: no
  # BASE_CANDIDATES lookup, just verify the file appeared.
  # shellcheck disable=SC2029  # REMOTE_TMP expands remotely by design
  if ! ssh "${SSH_OPTS[@]}" "$HOST" "test -f ${BASE_RESOLVED}" </dev/null; then
    echo "run-on-box: pass 1/2 failed: ${BASE_RESOLVED} was not produced on ${HOST}" >&2
    exit 1
  fi
  echo "run-on-box: pass 1/2: base clip at ${HOST}:${BASE_RESOLVED}"
fi

if [[ "$MODE" == "pose" ]]; then
  for ((i = 0; i < ${#POSE_ARGS[@]}; i += 3)); do
    pose_index=$((i / 3))
    pose_path="${POSE_ARGS[$i]}"
    echo "run-on-box: pushing pose $((pose_index + 1))/$(( ${#POSE_ARGS[@]} / 3 )) to ${HOST}:${REMOTE_TMP}/pose-${pose_index}.npz ..."
    scp -q "${SCP_OPTS[@]}" "$pose_path" "$HOST:${REMOTE_TMP}/pose-${pose_index}.npz"
  done
fi

REMOTE_CMD="$(build_remote_cmd "$REMOTE_TMP")"
echo "run-on-box: generating on ${HOST} ..."
# shellcheck disable=SC2029  # REMOTE_CMD is a remote command by design
ssh "${SSH_OPTS[@]}" "$HOST" "$REMOTE_CMD" </dev/null

echo "run-on-box: pulling ${HOST}:${REMOTE_TMP}/out.npz -> ${OUTPUT} ..."
# shellcheck disable=SC2029  # HOST:REMOTE_TMP is a remote path by design
scp -q "${SCP_OPTS[@]}" "$HOST:${REMOTE_TMP}/out.npz" "$OUTPUT"
[[ -s "$OUTPUT" ]] || { echo "run-on-box: pulled ${OUTPUT} is empty; the generation failed" >&2; exit 1; }
echo "run-on-box: done - ${OUTPUT} ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"
