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
PORT_ACTUATION = 5007       # telemetry OUT: actuation board -> laptop (this listener)
PORT_ACTUATION_CMD = 5008   # commands IN: laptop -> actuation board (see send_command)

_KNEE_DEFAULT = {"angle": 0.0, "q_thigh": [1.0, 0, 0, 0], "q_shank": [1.0, 0, 0, 0], "t_ms": 0, "batt": None}

STATE = {
    "hip":  {"q": [1.0, 0, 0, 0], "t_ms": 0, "batt": None},
    "knee": {"left":  dict(_KNEE_DEFAULT),
             "right": dict(_KNEE_DEFAULT)},
    "feet": {"left":  {"c": [0] * 16, "t_ms": 0, "batt": None},
             "right": {"c": [0] * 16, "t_ms": 0, "batt": None}},
    # tension/state are placeholders until the strain gauge + motor are wired
    # (see actuation/Actuation Context.md) - the firmware sends 0.0/"idle" for
    # now, just enough for the dashboard to show the board online.
    "actuation": {"tension_n": 0.0, "state": "idle", "t_ms": 0, "batt": None},
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
        elif kind == "knee" and parts[0] in ("knee_left", "knee_right") and len(parts) >= 12:
            side = "left" if parts[0] == "knee_left" else "right"
            STATE["knee"][side]["t_ms"] = int(float(parts[2]))
            STATE["knee"][side]["angle"] = float(parts[3])
            STATE["knee"][side]["q_thigh"] = [float(v) for v in parts[4:8]]
            STATE["knee"][side]["q_shank"] = [float(v) for v in parts[8:12]]
            if len(parts) >= 13:
                STATE["knee"][side]["batt"] = float(parts[12])
            _mark("knee_" + side)
        elif kind == "actuation" and parts[0] == "actuation" and len(parts) >= 5:
            STATE["actuation"]["t_ms"] = int(float(parts[2]))
            STATE["actuation"]["tension_n"] = float(parts[3])
            STATE["actuation"]["state"] = parts[4]
            if len(parts) >= 6:
                STATE["actuation"]["batt"] = float(parts[5])
            _mark("actuation")
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
        "knee": {"left":  {**STATE["knee"]["left"],  "age": age("knee_left")},
                 "right": {**STATE["knee"]["right"], "age": age("knee_right")}},
        "feet": {"left":  {**STATE["feet"]["left"],  "age": age("foot_left")},
                 "right": {**STATE["feet"]["right"], "age": age("foot_right")}},
        "actuation": {**STATE["actuation"], "age": age("actuation")},
    }


def apply_remote_snapshot(payload: dict) -> None:
    """Merge a snapshot pushed by relay.py. Only keys explicitly present are
    marked fresh; omitted keys are left to age out normally (so a relay that
    only sees, say, the feet doesn't fake liveness for the knee/hip)."""
    if "hip" in payload:
        STATE["hip"].update({k: v for k, v in payload["hip"].items() if k != "age"})
        _mark("hip")
    knee = payload.get("knee", {})
    if "left" in knee:
        STATE["knee"]["left"].update({k: v for k, v in knee["left"].items() if k != "age"})
        _mark("knee_left")
    if "right" in knee:
        STATE["knee"]["right"].update({k: v for k, v in knee["right"].items() if k != "age"})
        _mark("knee_right")
    feet = payload.get("feet", {})
    if "left" in feet:
        STATE["feet"]["left"].update({k: v for k, v in feet["left"].items() if k != "age"})
        _mark("foot_left")
    if "right" in feet:
        STATE["feet"]["right"].update({k: v for k, v in feet["right"].items() if k != "age"})
        _mark("foot_right")
    if "actuation" in payload:
        STATE["actuation"].update({k: v for k, v in payload["actuation"].items() if k != "age"})
        _mark("actuation")


def send_command(cmd: str, value: float = 0.0) -> None:
    """Broadcast a command line to the actuation board. Only reaches it when
    called from a process on the same LAN (the local backend, or relay.py) -
    client isolation being off on the router is what makes this reach the
    board at all; see the downlink test this replaced. Line format matches
    the telemetry convention: unit_id-prefixed, comma-separated."""
    line = f"actuation,{cmd},{value}".encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.sendto(line, ("192.168.0.255", PORT_ACTUATION_CMD))
    s.close()
