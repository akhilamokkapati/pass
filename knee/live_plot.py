"""
live_plot.py
PASS knee module - real-time scrolling knee-angle plot (live path).

Drives a source's stream() in real time, runs the engine per sample, low-passes
the angle with the CAUSAL StreamingLowpass (filtfilt cannot run live), and shows
a scrolling plot of raw + filtered knee flexion.

Two cadences are deliberately DECOUPLED so the plot never chokes:
  * sample cadence ~ source rate (e.g. 100 Hz) - driven by a wall-clock pump;
  * redraw cadence ~ target_fps (e.g. 30 fps) - driven by the animation timer.
Each redraw frame pulls however many samples should have arrived since the last
frame, runs the hot loop on each, then redraws ONCE.

The hot loop (ingest) is kept clean: receive -> engine angle -> filter -> buffer.
No print, no disk, no sleep, no drawing per sample.

VALIDATION: exercised against the SYNTHETIC stream now. Its real test comes when
the BNO085s arrive and we feed live fused quaternions through the same path.
"""

from __future__ import annotations

import time
from collections import deque

import numpy as np

from biomechanics.relative_orientation import knee_relative, remove_offset
from biomechanics.joint_angles import knee_flexion_angle, DEFAULT_FLEXION_AXIS
from filters import StreamingLowpass, DEFAULT_CUTOFF_HZ

IDENTITY_QUAT = np.array([1.0, 0.0, 0.0, 0.0])


def _source_rate_hz(source) -> float:
    """Sample rate of a source (synthetic uses rate_hz, others fs_hz)."""
    return float(getattr(source, "rate_hz", getattr(source, "fs_hz", 100.0)))


class LiveKneePlot:
    """
    Real-time knee-angle plot over a source's stream().

    source      : any PASS source exposing stream() (synthetic for now).
    window_s    : width of the scrolling time window.
    target_fps  : redraw rate; decoupled from the sample rate.
    cutoff_hz   : causal low-pass cutoff.
    axis        : flexion axis for the engine (synthetic default +x).
    q_neutral   : straight-leg neutral (identity for the already-zeroed synthetic).
    """

    def __init__(self, source, window_s: float = 10.0, target_fps: float = 30.0,
                 cutoff_hz: float = DEFAULT_CUTOFF_HZ,
                 axis=DEFAULT_FLEXION_AXIS, q_neutral=IDENTITY_QUAT,
                 title: str = "PASS knee - live (synthetic stream)"):
        self.source = source
        self.rate_hz = _source_rate_hz(source)
        self.window_s = float(window_s)
        self.target_fps = float(target_fps)
        self.axis = np.asarray(axis, dtype=float)
        self.q_neutral = np.asarray(q_neutral, dtype=float)
        self.title = str(title)

        self._stream = source.stream()               # infinite; WE pace it
        self._filter = StreamingLowpass(cutoff_hz, self.rate_hz)

        n = int(self.window_s * self.rate_hz) + 1
        self.buf_t = deque(maxlen=n)
        self.buf_raw = deque(maxlen=n)
        self.buf_filt = deque(maxlen=n)

        self._t0 = None
        self._emitted = 0
        # cap catch-up per frame so a stall can't spiral into a huge pull
        self._max_pull = max(1, int(4 * self.rate_hz / self.target_fps))

    # --- hot loop (no I/O, no drawing) ------------------------------------

    def _angle(self, packet) -> float:
        rel = remove_offset(knee_relative(packet.quat_thigh, packet.quat_shank),
                            self.q_neutral)
        return float(knee_flexion_angle(rel, axis=self.axis))

    def ingest(self, packet) -> float:
        """Process one packet: engine angle -> causal filter -> buffer. Returns
        the filtered value. This is the whole per-sample path."""
        raw = self._angle(packet)
        filt = self._filter.process(raw)
        self.buf_t.append(packet.t_ms / 1000.0)
        self.buf_raw.append(raw)
        self.buf_filt.append(filt)
        return filt

    def pump(self, now: float | None = None) -> int:
        """Pull and ingest all samples due by wall-clock `now`, capped. Returns
        how many were ingested this call. Does no drawing."""
        now = time.monotonic() if now is None else now
        if self._t0 is None:
            self._t0 = now
        target = int((now - self._t0) * self.rate_hz)
        pulled = 0
        while self._emitted < target and pulled < self._max_pull:
            self.ingest(next(self._stream))
            self._emitted += 1
            pulled += 1
        return pulled

    # --- animation (matplotlib only lives here) ---------------------------

    def build_figure(self):
        """Create the figure, axes and line handles. Separated from run() so the
        drawing path can be exercised headlessly."""
        import matplotlib.pyplot as plt

        self.fig, self.ax = plt.subplots(figsize=(10, 5))
        (self._raw_line,) = self.ax.plot([], [], color="0.7", lw=0.8, label="raw")
        (self._filt_line,) = self.ax.plot([], [], color="C0", lw=1.8, label="filtered")
        self.ax.set_xlabel("Time (s)")
        self.ax.set_ylabel("Knee flexion (deg)")
        self.ax.set_title(self.title)
        self.ax.legend(loc="upper right")
        self.ax.grid(alpha=0.3)
        return self.fig

    def draw_frame(self, _frame=None):
        """One animation frame: pump due samples, then redraw once."""
        self.pump()
        if not self.buf_t:
            return self._raw_line, self._filt_line
        t = np.fromiter(self.buf_t, float)
        self._raw_line.set_data(t, np.fromiter(self.buf_raw, float))
        self._filt_line.set_data(t, np.fromiter(self.buf_filt, float))
        right = t[-1]
        self.ax.set_xlim(max(0.0, right - self.window_s), max(self.window_s, right))
        lo = min(self.buf_raw); hi = max(self.buf_raw)
        self.ax.set_ylim(lo - 5, hi + 5)
        return self._raw_line, self._filt_line

    def run(self):
        """Open the scrolling live plot (blocking until the window is closed)."""
        import matplotlib.pyplot as plt
        from matplotlib.animation import FuncAnimation

        self.build_figure()
        self._ani = FuncAnimation(self.fig, self.draw_frame,
                                  interval=1000.0 / self.target_fps,
                                  blit=False, cache_frame_data=False)
        plt.show()


if __name__ == "__main__":
    import argparse
    from sources.synthetic import SyntheticSource

    ap = argparse.ArgumentParser(description="PASS knee live plot (synthetic)")
    ap.add_argument("--noise", type=float, default=2.0, help="synthetic noise (deg)")
    ap.add_argument("--window", type=float, default=10.0, help="scroll window (s)")
    ap.add_argument("--fps", type=float, default=30.0, help="redraw rate")
    ap.add_argument("--cutoff", type=float, default=DEFAULT_CUTOFF_HZ, help="low-pass Hz")
    args = ap.parse_args()

    src = SyntheticSource(noise_deg=args.noise)
    LiveKneePlot(src, window_s=args.window, target_fps=args.fps,
                 cutoff_hz=args.cutoff).run()
