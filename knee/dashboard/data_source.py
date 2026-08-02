"""
data_source.py
THE single, swappable data-access point for the PASS dashboard.

The whole dashboard reads its live/recorded data through get_source(). To switch
where the data comes from (synthetic now, the real BNO085 serial link when the
sensors arrive, or a recorded HuGaDB file), you change ONLY this file (the
SOURCE_MODE constant, or the serial port). No dashboard/view code changes. This
is the architecture requirement: the display layer never knows which source it is
talking to; every source exposes the same stream()/get_data() interface.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np

from sources.synthetic import SyntheticSource
from biomechanics.joint_angles import DEFAULT_FLEXION_AXIS
# When the hardware arrives, uncomment the one you need:
# from sources.serial_source import SerialSource
# from sources.hugadb import HuGaDBSource

# ---------------------------------------------------------------------------
# REPOINT HERE. "synthetic" today; "serial" on sensor day.
# ---------------------------------------------------------------------------
SOURCE_MODE = "synthetic"        # "synthetic" | "serial" | "hugadb"

# Config for each mode (only the active one is used).
SERIAL_PORT = "COM5"             # set to the XIAO's port on sensor day
HUGADB_FILE = "hugadb/HuGaDB_v2_various_01_00.csv"

# Live-sensor calibration written by calibrate_live.py (knee/live_calibration.json).
_CALIB_FILE = pathlib.Path(__file__).resolve().parent.parent / "live_calibration.json"
_IDENTITY = np.array([1.0, 0.0, 0.0, 0.0])


def get_calibration():
    """(q_neutral, flexion_axis) applied to the live angle so it reads accurately.

    In serial mode, loads live_calibration.json (from calibrate_live.py) so a
    straight leg reads ~0 deg and the flexion axis matches how the sensors are
    mounted. Otherwise returns the identity neutral + default axis, i.e. exactly
    the previous synthetic behavior (no calibration applied)."""
    if SOURCE_MODE == "serial" and _CALIB_FILE.exists():
        d = json.loads(_CALIB_FILE.read_text(encoding="utf-8"))
        return np.asarray(d["q_neutral"], float), np.asarray(d["flexion_axis"], float)
    return _IDENTITY, np.asarray(DEFAULT_FLEXION_AXIS, float)


def get_source():
    """Return the configured data source. Every source exposes stream() and
    get_data(duration_s); the dashboard uses only that interface."""
    if SOURCE_MODE == "synthetic":
        # A realistic knee-flexion profile for the live demo.
        return SyntheticSource(rate_hz=100.0, min_angle_deg=0.0,
                               max_angle_deg=60.0, rep_period_s=3.0, noise_deg=1.5)
    if SOURCE_MODE == "serial":
        from sources.serial_source import SerialSource
        return SerialSource(port=SERIAL_PORT)
    if SOURCE_MODE == "hugadb":
        from sources.hugadb import HuGaDBSource
        return HuGaDBSource(HUGADB_FILE)
    raise ValueError(f"unknown SOURCE_MODE: {SOURCE_MODE!r}")


def source_label() -> str:
    """Human-readable description of the active source, for display."""
    return {
        "synthetic": "Synthetic (demo)",
        "serial": f"Live sensor ({SERIAL_PORT})",
        "hugadb": "Recorded (HuGaDB)",
    }.get(SOURCE_MODE, SOURCE_MODE)
