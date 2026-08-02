"""
hip_wifi_view.py
Live pelvis motion for the PASS hip node over WiFi (UDP), shown RELATIVE to your
neutral standing pose (so it is intuitive and never wraps at +/-180).

The hip XIAO (hip_wifi firmware) joins 30.007 and broadcasts
    hip,seq,t_ms,qw,qx,qy,qz
to UDP :5004. This viewer listens, and on 'z' captures your current pose as
neutral. It then shows how far the pelvis has rotated AWAY from that neutral:

  * TILT (bold)  = total angle away from neutral - one clean number, always >= 0,
                   rises as you lean/tilt in ANY direction. This is the big readout.
  * the three thin lines = the tilt split by body axis (all 0 at neutral), so you
    can see the direction of the motion.

Because the sensor's mounting orientation is arbitrary, "relative to neutral" is
what makes this readable - the raw absolute Euler angles are not.

Keys (window focused): 'z' = set current pose as neutral (stand still first).

Run:
    cd hip
    ../.venv/Scripts/python hip_wifi_view.py
"""

from __future__ import annotations

import argparse
import math
import socket
import time
from collections import deque


def qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def qconj(q):
    w, x, y, z = q
    return (w, -x, -y, -z)


def rel_tilt_deg(q_ref, q):
    """Rotation of q away from q_ref, as (total_deg, ax_deg, ay_deg, az_deg).
    The three components are the rotation-vector (axis*angle); their magnitude
    equals total. All zero when q == q_ref, and smooth for normal motion."""
    w, x, y, z = qmul(qconj(q_ref), q)
    if w < 0.0:                       # shortest rotation
        w, x, y, z = -w, -x, -y, -z
    nv = math.sqrt(x * x + y * y + z * z)
    total = math.degrees(2.0 * math.atan2(nv, w))
    if nv < 1e-9:
        return 0.0, 0.0, 0.0, 0.0
    f = total / nv
    return total, x * f, y * f, z * f


class HipReceiver:
    """Non-blocking UDP listener keeping the latest pelvis quaternion."""

    def __init__(self, port: int = 5004):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", port))
        self.sock.setblocking(False)
        self.quat = None             # (w,x,y,z)
        self.t = None                # device seconds
        self.stamp = None            # monotonic wall clock of last packet

    def poll(self):
        while True:
            try:
                data, _ = self.sock.recvfrom(2048)
            except (BlockingIOError, OSError):
                break
            for line in data.decode("ascii", "ignore").splitlines():
                p = line.strip().split(",")
                if len(p) >= 7 and p[0] == "hip":
                    try:
                        self.t = float(p[2]) / 1000.0
                        self.quat = tuple(float(v) for v in p[3:7])
                        self.stamp = time.monotonic()
                    except ValueError:
                        continue


def main() -> None:
    ap = argparse.ArgumentParser(description="PASS hip live pelvis tilt (WiFi)")
    ap.add_argument("--port", type=int, default=5004)
    ap.add_argument("--window", type=float, default=10.0, help="scroll window (s)")
    args = ap.parse_args()

    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation

    rx = HipReceiver(args.port)
    print(f"# listening for hip frames on UDP :{args.port}. Press 'z' (standing) to zero.")

    n = int(args.window * 60) + 10
    tb = deque(maxlen=n)
    tot = deque(maxlen=n); ax_ = deque(maxlen=n); ay_ = deque(maxlen=n); az_ = deque(maxlen=n)
    ref = {"q": None}
    t0 = {"v": None}

    fig, ax = plt.subplots(figsize=(10, 5))
    (l_tot,) = ax.plot([], [], color="C3", lw=2.6, label="TILT from neutral (total)")
    (l_x,) = ax.plot([], [], color="C0", lw=1.0, alpha=0.7, label="axis 1")
    (l_y,) = ax.plot([], [], color="C1", lw=1.0, alpha=0.7, label="axis 2")
    (l_z,) = ax.plot([], [], color="C2", lw=1.0, alpha=0.7, label="axis 3 (twist)")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Degrees from neutral")
    ax.legend(loc="upper left", fontsize=9)
    ax.grid(alpha=0.3)
    readout = ax.text(0.98, 0.95, "", transform=ax.transAxes, ha="right", va="top",
                      fontsize=26, fontweight="bold", color="C3")

    def on_key(event):
        if event.key == "z" and rx.quat is not None:
            ref["q"] = rx.quat

    fig.canvas.mpl_connect("key_press_event", on_key)

    def update(_frame):
        rx.poll()
        if rx.quat is not None:
            if ref["q"] is None:                 # auto-zero on first packet
                ref["q"] = rx.quat
            if t0["v"] is None:
                t0["v"] = rx.t
            total, cx, cy, cz = rel_tilt_deg(ref["q"], rx.quat)
            tb.append(rx.t - t0["v"])
            tot.append(total); ax_.append(cx); ay_.append(cy); az_.append(cz)

        if tb:
            t = list(tb)
            l_tot.set_data(t, list(tot))
            l_x.set_data(t, list(ax_))
            l_y.set_data(t, list(ay_))
            l_z.set_data(t, list(az_))
            right = t[-1]
            ax.set_xlim(max(0.0, right - args.window), max(args.window, right))
            hi = max(10.0, max(tot) + 5)
            lo = min(-5.0, min(min(ax_), min(ay_), min(az_)) - 5)
            ax.set_ylim(lo, hi)

        live = rx.stamp is not None and (time.monotonic() - rx.stamp) < 1.0
        cur = tot[-1] if tot else 0.0
        readout.set_text(f"{cur:5.1f} deg" if live else "-- stale --")
        readout.set_color("C3" if live else "0.6")
        state = "live" if live else ("stale" if rx.stamp else "waiting...")
        ax.set_title(f"PASS hip - pelvis tilt from neutral (WiFi, {state})   "
                     "('z' = zero standing)")
        return l_tot, l_x, l_y, l_z, readout

    _ani = FuncAnimation(fig, update, interval=40, blit=False, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
