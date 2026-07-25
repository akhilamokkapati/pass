"""
insole_pressure_map.py
Live pressure-map viewer for the PASS left foot insole (16-zone FS-INS-16Z).

Bring-up / demo tool. Reads the XIAO 16-channel scan over serial, inverts the
pull-up reading so pressure reads UP, auto-baselines each zone (its running
unpressed level), and draws a live foot heatmap. Doubles as the press-test tool:
press a spot, see which channel lights up, then fill in that zone's anatomy.

This parses the current scan output (16 integers per line, whitespace OR comma
separated), so no firmware change is needed. It is NOT the normalized insole data
source; that is the separate feet/sources work.

Run:
    python insole_pressure_map.py --port COM6
    python insole_pressure_map.py            # auto-detects if one port is present
"""

from __future__ import annotations

import argparse
import re

import numpy as np

ADC_MAX = 4095

# Zone layout in normalized foot coordinates (y: 0 = heel, 1 = toe tip).
# PROVISIONAL. Only C8/C9 (big toe) and C12/C13 (heel) are confirmed; adjust the
# rest as the press test tells you what is where. Editing positions changes nothing
# but the drawing, so this stays fully configurable per the channel-map doc.
POSITIONS = {
    8:  (0.34, 0.92), 9:  (0.47, 0.93),                     # big toe (confirmed)
    0:  (0.59, 0.91), 1:  (0.70, 0.87), 2:  (0.80, 0.81),   # other toes (TODO)
    3:  (0.30, 0.70), 4:  (0.44, 0.71), 5:  (0.57, 0.71),
    6:  (0.69, 0.68), 7:  (0.79, 0.62),                     # forefoot (TODO)
    10: (0.40, 0.47), 11: (0.62, 0.47),                     # midfoot (TODO)
    14: (0.40, 0.30), 15: (0.62, 0.30),                     # rear midfoot (TODO)
    12: (0.44, 0.13), 13: (0.58, 0.13),                     # heel (confirmed)
}

ANATOMY = {8: "big toe", 9: "big toe", 12: "heel", 13: "heel"}


def parse_frame(line: str):
    """Return a (16,) float array of raw channel values, or None. Robust to the
    padded scan format AND a CSV frame: takes the LAST 16 integers on the line, so
    a leading frame/timestamp is ignored, and header lines (no 16 ints) are skipped."""
    tokens = re.split(r"[,\s]+", line.strip())
    vals = [t for t in tokens if re.fullmatch(r"-?\d+", t)]
    if len(vals) < 16:
        return None
    return np.array([int(v) for v in vals[-16:]], dtype=float)


def pick_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    from serial.tools import list_ports
    ports = list(list_ports.comports())
    if len(ports) == 1:
        print(f"# using the only serial port found: {ports[0].device}")
        return ports[0].device
    names = ", ".join(p.device for p in ports) or "none"
    raise SystemExit(f"specify --port. Ports available: {names}")


def main() -> None:
    ap = argparse.ArgumentParser(description="PASS left foot insole live pressure map")
    ap.add_argument("--port", default=None, help="serial port, e.g. COM6 (auto if one present)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--fullscale", type=int, default=1500,
                    help="pressure (counts below baseline) mapped to full color")
    args = ap.parse_args()

    import serial
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation
    from matplotlib.patches import Ellipse

    ser = serial.Serial(pick_port(args.port), args.baud, timeout=0.1)

    chans = sorted(POSITIONS)                       # 0..15
    xs = np.array([POSITIONS[c][0] for c in chans])
    ys = np.array([POSITIONS[c][1] for c in chans])
    baseline = None                                 # per-zone running unpressed level

    fig, ax = plt.subplots(figsize=(6, 9))
    ax.add_patch(Ellipse((0.55, 0.52), 0.78, 1.02, facecolor="0.94",
                         edgecolor="0.8", lw=1.5, zorder=0))
    sc = ax.scatter(xs, ys, c=np.zeros(len(chans)), cmap="YlOrRd",
                    vmin=0, vmax=args.fullscale, s=1700, edgecolors="0.4",
                    linewidths=1.2, zorder=2)
    for c in chans:
        x, y = POSITIONS[c]
        label = f"C{c}" + (f"\n{ANATOMY[c]}" if c in ANATOMY else "")
        ax.annotate(label, (x, y), ha="center", va="center", fontsize=7, zorder=3)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title("PASS left foot insole - live pressure\npress 'r' while unloaded to re-zero")
    fig.colorbar(sc, ax=ax, shrink=0.5, label="pressure (counts below baseline)")

    def read_latest():
        latest = None
        while ser.in_waiting > 0:
            raw = parse_frame(ser.readline().decode("ascii", errors="ignore"))
            if raw is not None:
                latest = raw
        return latest

    def on_key(event):
        nonlocal baseline
        if event.key == "r":
            raw = read_latest()
            if raw is not None:
                baseline = raw.copy()               # re-zero to the current (unloaded) level

    fig.canvas.mpl_connect("key_press_event", on_key)

    def update(_frame):
        nonlocal baseline
        raw = read_latest()
        if raw is not None:
            baseline = raw.copy() if baseline is None else np.maximum(baseline, raw)
            pressure = np.clip(baseline - raw, 0, None)   # pull-up: pressing lowers raw
            sc.set_array(np.array([pressure[c] for c in chans]))
        return (sc,)

    FuncAnimation(fig, update, interval=100, blit=False, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
