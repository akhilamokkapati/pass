"""
insole_pressure_map.py
Live pressure-map viewer for the PASS left foot insole (16-zone FS-INS-16Z).

Reads the XIAO 16-channel scan through the insole source (parsing + pull-up
inversion), draws a live foot heatmap, and doubles as the press-test tool.

Two display modes:
- raw (default): pressure above each zone's unloaded resting level. Press 'r'
  (foot off the insole) to re-zero.
- normalized: stand still, press 'c' to calibrate; the map then shows
  fraction-of-standing-load per zone (ZoneNormalizer, task 4), so you can watch
  your weight distribution shift as you lean.

Positions/anatomy are a configurable dict. Only C8/C9 (big toe) and C12/C13 (heel)
are confirmed; edit the rest as the press test tells you what is where.

Run:
    python insole_pressure_map.py --port COM6
    python insole_pressure_map.py            # auto-detects if one port is present
"""

from __future__ import annotations

import argparse
from collections import deque

import numpy as np

from sources.insole_source import parse_frame_line, ADC_MAX
from sources.normalize import ZoneNormalizer

# Normalized foot coordinates (y: 0 = heel, 1 = toe). PROVISIONAL except the
# confirmed zones; editing changes only the drawing.
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
                    help="raw-mode: pressure (counts above resting) mapped to full color")
    args = ap.parse_args()

    import serial
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation
    from matplotlib.patches import Ellipse

    ser = serial.Serial(pick_port(args.port), args.baud, timeout=0.1)

    chans = sorted(POSITIONS)
    xs = np.array([POSITIONS[c][0] for c in chans])
    ys = np.array([POSITIONS[c][1] for c in chans])

    state = {"rest": None, "mode": "raw", "recent": deque(maxlen=30)}
    norm = ZoneNormalizer()

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
    cbar = fig.colorbar(sc, ax=ax, shrink=0.5, label="pressure (counts above resting)")

    def set_title():
        if state["mode"] == "raw":
            ax.set_title("PASS left foot insole - raw pressure\n"
                         "'c' = calibrate standing   'r' = re-zero (foot off)")
        else:
            ax.set_title("PASS left foot insole - fraction of standing load\n"
                         "1.0 = your standing load   'c' = re-calibrate")
    set_title()

    def read_latest():
        latest = None
        while ser.in_waiting > 0:
            raw = parse_frame_line(ser.readline().decode("ascii", errors="ignore"))
            if raw is not None:
                latest = ADC_MAX - raw            # invert: pressure reads up
        if latest is not None:
            state["recent"].append(latest)
        return latest

    def on_key(event):
        if event.key == "r":
            latest = read_latest()
            if latest is not None:
                state["rest"] = latest.copy()     # re-zero raw mode
        elif event.key == "c":
            read_latest()
            if state["recent"]:
                norm.fit(np.array(state["recent"]))   # standing calibration (task 4)
                state["mode"] = "normalized"
                sc.set_clim(0, 1.5)
                cbar.set_label("fraction of standing load")
                set_title()
                fig.canvas.draw_idle()

    fig.canvas.mpl_connect("key_press_event", on_key)

    def update(_frame):
        pressure = read_latest()
        if pressure is not None:
            if state["mode"] == "normalized" and norm.is_fitted:
                disp = norm.transform(pressure)
            else:
                r = state["rest"]
                state["rest"] = pressure.copy() if r is None else np.minimum(r, pressure)
                disp = np.clip(pressure - state["rest"], 0, None)
            sc.set_array(np.array([disp[c] for c in chans]))
        return (sc,)

    FuncAnimation(fig, update, interval=100, blit=False, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
