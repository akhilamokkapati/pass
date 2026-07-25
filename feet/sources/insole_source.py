"""
insole_source.py
PASS left foot insole data source (task 3).

Same ROLE and interface pattern as the knee serial source: a class exposing
stream() and get_data(duration_s), pyserial imported lazily, and an injectable
line_source for hardware-free tests. The payload is insole pressure, not knee
quaternions, so it uses the feet InsoleFrame/InsoleCapture (see schema.py).

It does the one transform every consumer needs: INVERTS each raw channel
(pressure = ADC_MAX - raw) so pressure reads up (pull-up topology: pressing pulls
the raw ADC down). Per-zone normalization is a separate, re-runnable step
(normalize.ZoneNormalizer).

FIRMWARE LINE: 16 integers per line (whitespace or comma separated). A leading
frame/timestamp, if present, is ignored - the LAST 16 integers are the channels.
The current scan firmware has no timestamp column, so this source generates its
own frame counter and t_ms.
"""

from __future__ import annotations

import re
import time
from typing import Iterable, Iterator

import numpy as np

from .schema import InsoleFrame, InsoleCapture, N_ZONES

ADC_MAX = 4095            # 12-bit full scale; unpressed sits near here
DEFAULT_BAUD = 115200


def parse_frame_line(line: str) -> np.ndarray | None:
    """Parse one scan line into a (16,) raw-counts array, or None. Accepts only
    whole integer tokens, so header lines ('C0 C1 ...', '16-channel scan start')
    are rejected; takes the LAST 16 integers so a frame/timestamp prefix is ignored."""
    tokens = re.split(r"[,\s]+", line.strip())
    vals = [t for t in tokens if re.fullmatch(r"-?\d+", t)]
    if len(vals) < N_ZONES:
        return None
    return np.array([int(v) for v in vals[-N_ZONES:]], dtype=float)


class InsoleSource:
    """
    Live insole source. Provide either `line_source` (iterable of decoded str
    lines, for tests/replay) or `port` (opened lazily with pyserial).

    port         : e.g. "COM6". Ignored if line_source is given.
    baud         : serial baud (XIAO USB CDC default 115200).
    line_source  : iterable of str lines; when set, no serial port is opened.
    """

    def __init__(self, port: str | None = None, baud: int = DEFAULT_BAUD,
                 line_source: Iterable[str] | None = None):
        self.port = port
        self.baud = int(baud)
        self.line_source = line_source
        self.n_malformed = 0

    def _raw_lines(self) -> Iterator[str]:
        if self.line_source is not None:
            yield from self.line_source
            return
        if self.port is None:
            raise ValueError("InsoleSource needs either a line_source or a port")
        import serial                                  # lazy: only for real hardware
        with serial.Serial(self.port, self.baud, timeout=1.0) as ser:
            while True:
                raw = ser.readline()
                if not raw:
                    continue
                yield raw.decode("ascii", errors="ignore")

    def stream(self) -> Iterator[InsoleFrame]:
        """Yield inverted-pressure frames one at a time. Malformed lines skipped."""
        frame_no = 0
        t0 = None
        for line in self._raw_lines():
            raw = parse_frame_line(line)
            if raw is None:
                if line and line.strip():
                    self.n_malformed += 1
                continue
            now = time.monotonic()
            if t0 is None:
                t0 = now
            yield InsoleFrame(
                t_ms=int((now - t0) * 1000.0),
                frame=frame_no,
                pressure=ADC_MAX - raw,               # invert: pressure reads up
            )
            frame_no += 1

    def get_data(self, duration_s: float | None = None) -> InsoleCapture:
        """Collect frames into a Capture. Stops after duration_s of source time, or
        when the line source ends (whichever first)."""
        frames: list[InsoleFrame] = []
        for fr in self.stream():
            frames.append(fr)
            if duration_s is not None and fr.t_ms >= duration_s * 1000.0:
                break
        return InsoleCapture(
            t_ms=np.array([f.t_ms for f in frames], dtype=int),
            frame=np.array([f.frame for f in frames], dtype=int),
            pressure=np.array([f.pressure for f in frames], dtype=float).reshape(-1, N_ZONES),
        )
