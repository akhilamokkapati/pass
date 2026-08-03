"""
insole_wifi_view.py
Live pressure map for BOTH PASS foot insoles over WiFi (UDP), untethered.

Each foot's XIAO (pass_foot_wifi firmware) sends a UDP frame every 100 ms:
    unit_id,frame,t_ms,c0,...,c15      (values already inverted; pressure reads up)
to this laptop on UDP :5006. This viewer listens, keys frames by unit_id
("foot_left" / "foot_right"), and draws both feet with the SAME layout and
heatmap as insole_dual_view.py. It does NOT invert again (the firmware did).

Prereqs:
  * laptop and both feet on the same network (travel router 30.007);
  * Windows Firewall must allow inbound UDP on the port (allow it the first time).

Keys (window focused): 'c' calibrate standing, 'r' re-zero (same as serial viewer).

Run:
    python insole_wifi_view.py
    python insole_wifi_view.py --port 5006
"""

from __future__ import annotations

import argparse
import socket
import time

import numpy as np

from foot_layout import FEET
from insole_dual_view import FootPanel

UNIT_OF = {"left": "foot_left", "right": "foot_right"}


class UdpReceiver:
    """Non-blocking UDP listener that keeps the latest frame per unit_id."""

    def __init__(self, port: int = 5006):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", port))
        self.sock.setblocking(False)
        self.latest: dict[str, np.ndarray] = {}
        self.stamp: dict[str, float] = {}

    def poll(self) -> None:
        """Drain the socket; store the newest 16-channel frame for each unit."""
        while True:
            try:
                data, _ = self.sock.recvfrom(2048)
            except (BlockingIOError, OSError):
                break
            parts = data.decode("ascii", "ignore").strip().split(",")
            if not parts:
                continue
            unit = parts[0]
            ints = [int(t) for t in parts[1:] if t.lstrip("-").isdigit()]
            # ints = [frame, t_ms, c0..c15, (battery)]; take the 16 channels by
            # position so an optional trailing battery field does not shift them.
            if len(ints) >= 18:
                self.latest[unit] = np.array(ints[2:18], dtype=float)
                self.stamp[unit] = time.monotonic()


class WifiFootPanel(FootPanel):
    """FootPanel that pulls frames from a shared UdpReceiver instead of serial."""

    def __init__(self, ax, name, cfg, receiver: UdpReceiver, fullscale):
        self.receiver = receiver
        self.unit = UNIT_OF[name]
        # port=None -> parent opens no serial link; we feed it from UDP instead.
        super().__init__(ax, name, cfg, port=None, baud=0, fullscale=fullscale)
        ax.set_title(f"{name} foot ({self.unit}) - waiting for WiFi...")

    def read_latest(self):
        # Firmware already inverted the values, so return them as-is (no ADC_MAX - raw).
        self.receiver.poll()
        arr = self.receiver.latest.get(self.unit)
        if arr is not None:
            self.recent.append(arr)
        return arr


def main() -> None:
    ap = argparse.ArgumentParser(description="PASS both-feet live pressure map over WiFi")
    ap.add_argument("--port", type=int, default=5006, help="UDP listen port")
    ap.add_argument("--fullscale", type=int, default=1500)
    args = ap.parse_args()

    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    receiver = UdpReceiver(args.port)
    print(f"# listening for foot frames on UDP :{args.port} "
          "(allow Python through the firewall if nothing shows)")

    fig, axes = plt.subplots(1, 2, figsize=(11, 8))
    fig.suptitle("PASS foot insoles - live over WiFi   ('c' calibrate standing, 'r' re-zero)")
    panels = [
        WifiFootPanel(axes[0], "left", FEET["left"], receiver, args.fullscale),
        WifiFootPanel(axes[1], "right", FEET["right"], receiver, args.fullscale),
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
            if p.unit in receiver.stamp:
                age = time.monotonic() - receiver.stamp[p.unit]
                state = "live" if age < 1.5 else f"stale {age:.0f}s"
            else:
                state = "waiting..."
            p.ax.set_title(f"{p.name} foot ({state})")
        return [p.sc for p in panels]

    # keep a reference so the animation is not garbage-collected
    _ani = FuncAnimation(fig, update, interval=100, blit=False, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
