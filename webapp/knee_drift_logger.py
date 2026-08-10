r"""
PASS live dashboard - knee drift logger.

Standalone diagnostic tool: connects to the dashboard's live WebSocket (the
same /ws endpoint the frontend uses) and appends a row per knee side to a CSV
file at a fixed interval, for as long as it's left running. Built to chase a
knee-angle drift bug that only shows up after hours of continuous runtime and
isn't reproducible on demand - so instead of trying to catch it live, this
lets you leave two knee boards on a table (or worn) for a long stretch and
analyze the resulting file afterward.

Logs the RAW q_thigh/q_shank quaternions alongside the computed angle, not
just the angle - a plain angle-over-time log can't tell "the sensor's own
fusion drifted" apart from "something in the relative-orientation math",
the raw quaternions can.

Storage: at the default 1s interval, a full 8-hour run is only ~6-8 MB
(two rows/sample, ~150 bytes/row). Safe to leave running overnight.

This is a standalone script, not part of the dashboard - it only runs when
launched by hand, and only for as long as it's left running. Opening the
dashboard in a browser has no effect on it either way.

Usage (any machine that can reach the dashboard, doesn't need this repo's venv):
    pip install websockets
    python knee_drift_logger.py --url http://<dashboard-host>:8000
    python knee_drift_logger.py --url https://pass-dashboard.onrender.com

Or set the env var instead of --url:
    set PASS_DASHBOARD_URL=http://192.168.1.23:8000
    python knee_drift_logger.py

Output: CSV at --out (default knee_drift_<timestamp>.csv in the current
directory) with columns:
    wall_time_iso, elapsed_s, side, angle_deg,
    qt_w, qt_x, qt_y, qt_z, qs_w, qs_x, qs_y, qs_z,
    age_s, batt

Stop any time with Ctrl+C - the file is flushed after every write, so
nothing is lost even if it's killed mid-session.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import time
from datetime import datetime, timezone

import websockets


def _ws_url(base: str) -> str:
    base = base.rstrip("/")
    if base.startswith("https://"):
        return base.replace("https://", "wss://", 1) + "/ws"
    if base.startswith("http://"):
        return base.replace("http://", "ws://", 1) + "/ws"
    if base.startswith(("ws://", "wss://")):
        return base + "/ws"
    return "ws://" + base + "/ws"


async def _run(url: str, interval_s: float, out_path: str) -> None:
    is_new = not os.path.exists(out_path)
    f = open(out_path, "a", newline="")
    writer = csv.writer(f)
    if is_new:
        writer.writerow([
            "wall_time_iso", "elapsed_s", "side", "angle_deg",
            "qt_w", "qt_x", "qt_y", "qt_z", "qs_w", "qs_x", "qs_y", "qs_z",
            "age_s", "batt",
        ])
        f.flush()

    start_t = time.monotonic()
    last_write_t = 0.0
    rows_written = 0
    print(f"# knee_drift_logger: logging to {os.path.abspath(out_path)} every {interval_s}s - Ctrl+C to stop")

    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                print(f"# knee_drift_logger: connected to {url}")
                await ws.send("hi")
                async for raw in ws:
                    now_t = time.monotonic()
                    if now_t - last_write_t < interval_s:
                        continue
                    try:
                        snap = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    knee = snap.get("knee") or {}
                    wrote_any = False
                    for side in ("left", "right"):
                        k = knee.get(side)
                        if not k:
                            continue
                        qt = k.get("q_thigh") or [None] * 4
                        qs = k.get("q_shank") or [None] * 4
                        writer.writerow([
                            datetime.now(timezone.utc).isoformat(),
                            round(now_t - start_t, 2),
                            side,
                            k.get("angle"),
                            *qt, *qs,
                            k.get("age"),
                            k.get("batt"),
                        ])
                        wrote_any = True
                    if wrote_any:
                        f.flush()
                        last_write_t = now_t
                        rows_written += 1
                        if rows_written % 60 == 0:  # ~ every minute at the default 1s interval
                            l = knee.get("left", {}).get("angle")
                            r = knee.get("right", {}).get("angle")
                            elapsed_min = (now_t - start_t) / 60
                            print(f"# t={elapsed_min:.1f}min  left={l}  right={r}  ({rows_written} samples)")
        except (websockets.exceptions.WebSocketException, OSError) as exc:
            print(f"# knee_drift_logger: connection lost ({exc}), retrying in 2s")
            await asyncio.sleep(2)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("PASS_DASHBOARD_URL", "http://localhost:8000"),
                     help="Dashboard base URL (http/https/ws/wss all accepted), default http://localhost:8000")
    ap.add_argument("--interval", type=float, default=1.0, help="Seconds between logged samples (default 1.0)")
    ap.add_argument("--out", default=None, help="Output CSV path (default knee_drift_<timestamp>.csv)")
    args = ap.parse_args()

    out_path = args.out or f"knee_drift_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    url = _ws_url(args.url)

    try:
        asyncio.run(_run(url, args.interval, out_path))
    except KeyboardInterrupt:
        print("\n# knee_drift_logger: stopped")


if __name__ == "__main__":
    main()
