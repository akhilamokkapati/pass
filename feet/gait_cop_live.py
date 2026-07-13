"""
Gait center-of-pressure visualizer  -  LIVE + CSV log + metrics
Reads: "z0:.. z1:.. z2:.. z3:.."  (heel, midfoot, fore-medial, fore-lateral)
"""

import os, time, csv, threading
from collections import deque
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Polygon
from matplotlib.animation import FuncAnimation

# ------------------------- CONFIG -------------------------
SIMULATE    = False
PORT        = "COM7"      # <-- your ESP32-C6 port
BAUD        = 115200
MAXLOAD     = 300.0       # load that maps to full colour (firm tap ~300)
CONTACT_ON  = 40.0        # sum of zones above this = foot on the ground
CONTACT_OFF = 20.0        # falls below this = foot lifted (hysteresis)
MIN_STANCE  = 0.10        # ignore contacts shorter than this (s)
LOG_DIR     = "logs"
# ----------------------------------------------------------

zones = ["heel", "midfoot", "fore-medial", "fore-lateral"]
# POS row order matches z0..z3 as physically wired:
POS = np.array([
    [ 0.0, 1.2],   # z0 -> heel
    [-0.7, 5.9],   # z1 -> fore-medial
    [ 0.8, 5.6],   # z2 -> fore-lateral
    [ 0.5, 3.5],   # z3 -> midfoot
])

lock = threading.Lock()
S = {"loads": np.zeros(4), "cop": None, "contact": False,
     "steps": 0, "cadence": 0.0, "stance_ms": 0.0, "path": 0.0}

def compute_cop(loads):
    total = loads.sum()
    if total <= 1e-6:
        return None, total
    return (loads[:, None] * POS).sum(axis=0) / total, total

def start_reader():
    os.makedirs(LOG_DIR, exist_ok=True)
    fname = os.path.join(LOG_DIR, time.strftime("gait_log_%Y%m%d_%H%M%S.csv"))
    print(f"Logging to: {os.path.abspath(fname)}")
    f = open(fname, "w", newline="")
    w = csv.writer(f)
    w.writerow(["t_s", "z0", "z1", "z2", "z3", "cop_x", "cop_y", "contact"])

    import serial
    try:
        ser = serial.Serial(PORT, BAUD, timeout=1)
    except Exception as e:
        print(f"Could not open {PORT}: {e}\nClose the Arduino Serial Monitor/Plotter and check the port.")
        return

    state = "off"; t0 = time.time(); t_start = 0.0
    prev_starts = deque(maxlen=6); cop_prev = None; path = 0.0; rows = 0

    while True:
        line = ser.readline().decode(errors="ignore").strip()
        vals = {}
        for tok in line.replace(",", " ").split():
            if ":" in tok:
                k, v = tok.split(":", 1)
                try: vals[k] = float(v)
                except ValueError: pass
        if not vals:
            continue
        raw = np.array([vals.get(f"z{i}", 0.0) for i in range(4)])
        t = time.time()
        loads = np.clip(raw, 0, None)
        cop, total = compute_cop(loads)

        if state == "off":
            if total > CONTACT_ON:
                state = "on"; t_start = t; path = 0.0; cop_prev = cop
        else:
            if cop is not None and cop_prev is not None:
                path += float(np.hypot(*(cop - cop_prev)))
            if cop is not None:
                cop_prev = cop
            if total < CONTACT_OFF:
                stance = t - t_start
                if stance >= MIN_STANCE:
                    prev_starts.append(t_start)
                    cadence = 0.0
                    if len(prev_starts) >= 2:
                        cadence = 60.0 / float(np.mean(np.diff(prev_starts)))
                    with lock:
                        S["steps"] += 1; S["stance_ms"] = stance * 1000.0
                        S["path"] = path; S["cadence"] = cadence
                state = "off"

        with lock:
            S["loads"] = loads; S["cop"] = cop; S["contact"] = (state == "on")

        cx, cy = (cop if cop is not None else (float("nan"), float("nan")))
        w.writerow([f"{t-t0:.3f}", *[int(v) for v in raw], f"{cx:.3f}", f"{cy:.3f}", int(state == "on")])
        rows += 1
        if rows % 20 == 0:
            f.flush()

FOOT = np.array([[0.0,0.0],[-1.0,0.4],[-1.3,2.0],[-1.2,4.0],[-1.5,5.6],
                 [-1.2,6.9],[-0.4,7.6],[0.4,7.6],[1.1,7.0],[1.5,5.6],
                 [1.2,4.0],[1.1,2.0],[0.9,0.4],[0.0,0.0]])

fig, ax = plt.subplots(figsize=(4.4, 6.6))
fig.canvas.manager.set_window_title("Gait CoP  -  live")
ax.add_patch(Polygon(FOOT, closed=True, facecolor="#f4f2ec", edgecolor="#8a8880", lw=1.5, zorder=0))
ax.set_xlim(-2.6, 2.6); ax.set_ylim(-0.9, 8.8); ax.set_aspect("equal"); ax.axis("off")

cmap = plt.cm.plasma
circles = []
for (x, y), name in zip(POS, zones):
    c = Circle((x, y), 0.55, facecolor=cmap(0.0), edgecolor="#555", lw=1.0, zorder=2)
    ax.add_patch(c); circles.append(c)
    ax.text(x, y - 0.95, name, ha="center", va="top", fontsize=8, color="#555")

trail = deque(maxlen=60)
(trail_line,) = ax.plot([], [], "-", color="#7f77dd", lw=2, alpha=0.6, zorder=3)
(cop_dot,)    = ax.plot([], [], "o", color="#534ab7", ms=14, zorder=4)
info = ax.text(-2.5, 8.7, "", fontsize=9, color="#222", va="top", family="monospace")
prev_contact = [False]

def update(_):
    with lock:
        loads = S["loads"].copy(); cop = S["cop"]; contact = S["contact"]
        steps = S["steps"]; cadence = S["cadence"]; stance = S["stance_ms"]; path = S["path"]
    for c, L in zip(circles, loads):
        c.set_facecolor(cmap(min(L / MAXLOAD, 1.0)))
    if contact and not prev_contact[0]:
        trail.clear()
    prev_contact[0] = contact
    if contact and cop is not None:
        trail.append(cop); cop_dot.set_data([cop[0]], [cop[1]])
    else:
        cop_dot.set_data([], [])
    if trail:
        t = np.array(trail); trail_line.set_data(t[:, 0], t[:, 1])
    else:
        trail_line.set_data([], [])
    vals = "  ".join(f"z{i}:{int(l):4d}" for i, l in enumerate(loads))
    info.set_text(f"{vals}\nsteps: {steps}   cadence: {cadence:5.1f}/min\n"
                  f"stance: {stance:5.0f} ms   CoP path: {path:4.2f}")
    return circles + [trail_line, cop_dot, info]

if __name__ == "__main__":
    threading.Thread(target=start_reader, daemon=True).start()
    ani = FuncAnimation(fig, update, interval=30, blit=False, cache_frame_data=False)
    plt.tight_layout()
    plt.show()
