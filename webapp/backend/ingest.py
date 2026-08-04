r"""
PASS live dashboard - shared sensor-state ingestion.

Holds the live STATE dict and the UDP-line parsing logic, used by both:
  - main.py, when running locally on the same LAN as the sensor nodes
    (listens for the UDP broadcasts directly)
  - relay.py, when the dashboard is hosted remotely (Render etc.) and a
    local relay forwards readings over HTTPS instead

Keeping this in one module means both paths agree on wire format and on
what counts as "fresh" (STALE age handling lives in the frontend; this
module just records last-seen times).
"""

from __future__ import annotations

import socket
import time

PORT_FEET = 5006
PORT_KNEE = 5005
PORT_HIP = 5004

STATE = {
    "hip":  {"q": [1.0, 0, 0, 0], "t_ms": 0, "batt": None},
    "knee": {"angle": 0.0, "q_thigh": [1.0, 0, 0, 0], "q_shank": [1.0, 0, 0, 0], "t_ms": 0, "batt": None},
    "feet": {"left":  {"c": [0] * 16, "t_ms": 0, "batt": None},
             "right": {"c": [0] * 16, "t_ms": 0, "batt": None}},
}
_last: dict[str, float] = {}   # key -> monotonic time of last packet


def _mark(key: str) -> None:
    _last[key] = time.monotonic()


def _handle_line(kind: str, line: str) -> None:
    parts = line.strip().split(",")
    if len(parts) < 3:
        return
    try:
        # An OPTIONAL trailing battery-percent field may follow the payload.
        if kind == "hip" and parts[0] == "hip" and len(parts) >= 7:
            STATE["hip"]["t_ms"] = int(float(parts[2]))
            STATE["hip"]["q"] = [float(v) for v in parts[3:7]]
            if len(parts) >= 8:
                STATE["hip"]["batt"] = float(parts[7])
            _mark("hip")
        elif kind == "knee" and parts[0].lstrip("-").isdigit() and len(parts) >= 11:
            STATE["knee"]["t_ms"] = int(float(parts[1]))
            STATE["knee"]["angle"] = float(parts[2])
            STATE["knee"]["q_thigh"] = [float(v) for v in parts[3:7]]
            STATE["knee"]["q_shank"] = [float(v) for v in parts[7:11]]
            if len(parts) >= 12:
                STATE["knee"]["batt"] = float(parts[11])
            _mark("knee")
        elif kind == "feet" and parts[0] in ("foot_left", "foot_right") and len(parts) >= 19:
            side = "left" if parts[0] == "foot_left" else "right"
            STATE["feet"][side]["t_ms"] = int(float(parts[2]))
            STATE["feet"][side]["c"] = [int(float(v)) for v in parts[3:19]]
            if len(parts) >= 20:
                STATE["feet"][side]["batt"] = float(parts[19])
            _mark("foot_" + side)
    except ValueError:
        return


def _udp_listener(port: int, kind: str) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
    except OSError as exc:
        print(f"# UDP {port} ({kind}) bind failed: {exc}")
        return
    print(f"# listening for {kind} on UDP :{port}")
    while True:
        try:
            data, _addr = s.recvfrom(2048)
        except OSError:
            continue
        for line in data.decode("ascii", "ignore").splitlines():
            _handle_line(kind, line)


def snapshot() -> dict:
    now = time.monotonic()

    def age(key):
        t = _last.get(key)
        return None if t is None else round(now - t, 2)

    return {
        "t": round(now, 3),
        "hip":  {**STATE["hip"], "age": age("hip")},
        "knee": {**STATE["knee"], "age": age("knee")},
        "feet": {"left":  {**STATE["feet"]["left"],  "age": age("foot_left")},
                 "right": {**STATE["feet"]["right"], "age": age("foot_right")}},
    }


def apply_remote_snapshot(payload: dict) -> None:
    """Merge a snapshot pushed by relay.py. Only keys explicitly present are
    marked fresh; omitted keys are left to age out normally (so a relay that
    only sees, say, the feet doesn't fake liveness for the knee/hip)."""
    if "hip" in payload:
        STATE["hip"].update({k: v for k, v in payload["hip"].items() if k != "age"})
        _mark("hip")
    if "knee" in payload:
        STATE["knee"].update({k: v for k, v in payload["knee"].items() if k != "age"})
        _mark("knee")
    feet = payload.get("feet", {})
    if "left" in feet:
        STATE["feet"]["left"].update({k: v for k, v in feet["left"].items() if k != "age"})
        _mark("foot_left")
    if "right" in feet:
        STATE["feet"]["right"].update({k: v for k, v in feet["right"].items() if k != "age"})
        _mark("foot_right")
