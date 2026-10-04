#!/usr/bin/env python3
"""Bench launcher for cclay_gvhmr_extract.py (issue #430), YOLO runs only.

    python cclay_bench_runner.py <runner.py> <runner args...>

Runs the runner's own main() with exactly the given argv, in the same way
tools/ardy/cclay_gvhmr_worker.py loads it, and adds one observation: the
runner logs how many frames its YOLO track detected only on the raw-detection
fallback, so the tracker path gets a "[bench] yolo track: N/M frames" line
here. The wrapped method's inputs and return value are passed through
untouched; the runner's decisions do not change.
"""
import importlib.util
from pathlib import Path
import sys


def main():
    runner_path = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(runner_path.parent))
    from hmr4d.utils.preproc.tracker import Tracker

    original = Tracker.sort_track_length

    def counted(track_history, video_path):
        result = original(track_history, video_path)
        id_to_frame_ids, _, id_sorted = result
        if id_sorted:
            print(f"[bench] yolo track: {len(id_to_frame_ids[id_sorted[0]])}/{len(track_history)} frames",
                  file=sys.stderr, flush=True)
        return result

    Tracker.sort_track_length = staticmethod(counted)
    spec = importlib.util.spec_from_file_location("cozyclay_gvhmr_bench", runner_path)
    runner = importlib.util.module_from_spec(spec)
    sys.argv = [str(runner_path), *sys.argv[2:]]
    spec.loader.exec_module(runner)
    runner.main()


if __name__ == "__main__":
    main()
