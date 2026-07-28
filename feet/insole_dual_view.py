"""
insole_dual_view.py
Live pressure map for BOTH PASS foot insoles side by side.

Each foot reads its own serial port, inverts the pull-up reading (pressure reads
up), auto-baselines per zone, and draws a foot heatmap. Left uses the confirmed
press-test layout; right is provisional (see foot_layout.py).

Keys (with the window focused):
- 'c': stand still, then press to calibrate BOTH feet -> each map shows
  fraction-of-standing-load (ZoneNormalizer).
- 'r': re-zero both (feet off the insoles).

A foot whose port is missing or fails to open just shows "not connected"; the
other foot still runs.

Run:
    python insole_dual_view.py --left-port COM11 --right-port COM12
"""

from __future__ import annotations

import argparse
from collections import deque

import numpy as np

from sources.insole_source import parse_frame_line, ADC_MAX
from sources.normalize import ZoneNormalizer
from foot_layout import FEET


class FootPanel:
    """One foot: its serial link, rolling state, and scatter on a given axis."""

    def __init__(self, ax, name, cfg, port, baud, fullscale):
        from matplotlib.patches import Ellipse

        self.name = name
        self.positions = cfg["positions"]
        self.anatomy = cfg["anatomy"]
        self.fullscale = fullscale
        self.chans = sorted(self.positions)
        self.rest = None
        self.recent = deque(maxlen=30)
        self.norm = ZoneNormalizer()
        self.mode = "raw"
        self.ax = ax

        xs = [self.positions[c][0] for c in self.chans]
        ys = [self.positions[c][1] for c in self.chans]
        ax.add_patch(Ellipse((0.50, 0.52), 0.78, 1.02, facecolor="0.94",
                             edgecolor="0.8", lw=1.5, zorder=0))
        self.sc = ax.scatter(xs, ys, c=np.zeros(len(self.chans)), cmap="YlOrRd",
                             vmin=0, vmax=fullscale, s=900, edgecolors="0.4",
                             linewidths=1.0, zorder=2)
        for c in self.chans:
            x, y = self.positions[c]
            label = f"C{c}" + (f"\n{self.anatomy[c]}" if c in self.anatomy else "")
            ax.annotate(label, (x, y), ha="center", va="center", fontsize=6, zorder=3)
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.set_aspect("equal")
        ax.axis("off")

        self.ser = None
        try:
            import serial
            if port:
                self.ser = serial.Serial(port, baud, timeout=0.1)
        except Exception as exc:                       # noqa: BLE001 - report and degrade
            print(f"# {name}: could not open {port}: {exc}")
        tag = "confirmed" if cfg["confirmed"] else "provisional layout"
        ax.set_title(f"{name} foot ({tag})" if self.ser
                     else f"{name} foot - not connected ({port})")

    def read_latest(self):
        if self.ser is None:
            return None
        latest = None
        while self.ser.in_waiting > 0:
            raw = parse_frame_line(self.ser.readline().decode("ascii", errors="ignore"))
            if raw is not None:
                latest = ADC_MAX - raw
        if latest is not None:
            self.recent.append(latest)
        return latest

    def calibrate(self):
        self.read_latest()
        if self.recent:
            self.norm.fit(np.array(self.recent))
            self.mode = "normalized"
            self.sc.set_clim(0, 1.5)

    def rezero(self):
        latest = self.read_latest()
        if latest is not None:
            self.rest = latest.copy()

    def update(self):
        p = self.read_latest()
        if p is None:
            return
        if self.mode == "normalized" and self.norm.is_fitted:
            disp = self.norm.transform(p)
        else:
            self.rest = p.copy() if self.rest is None else np.minimum(self.rest, p)
            disp = np.clip(p - self.rest, 0, None)
        self.sc.set_array(np.array([disp[c] for c in self.chans]))


def main() -> None:
    ap = argparse.ArgumentParser(description="PASS both-feet live pressure map")
    ap.add_argument("--left-port", default=FEET["left"]["port"], help="left insole port")
    ap.add_argument("--right-port", default=FEET["right"]["port"], help="right insole port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--fullscale", type=int, default=1500)
    args = ap.parse_args()

    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    fig, axes = plt.subplots(1, 2, figsize=(11, 8))
    fig.suptitle("PASS foot insoles - live pressure   ('c' calibrate standing, 'r' re-zero)")
    panels = [
        FootPanel(axes[0], "left", FEET["left"], args.left_port, args.baud, args.fullscale),
        FootPanel(axes[1], "right", FEET["right"], args.right_port, args.baud, args.fullscale),
    ]

    def on_key(event):
        if event.key == "c":
            for p in panels:
                p.calibrate()
            fig.canvas.draw_idle()
        elif event.key == "r":
            for p in panels:
                p.rezero()

    fig.canvas.mpl_connect("key_press_event", on_key)

    def update(_frame):
        for p in panels:
            p.update()
        return [p.sc for p in panels]

    FuncAnimation(fig, update, interval=100, blit=False, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
