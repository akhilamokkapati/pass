r"""
calibrate_live.py
Capture a straight-leg + bent pose from the live serial link and save the knee
calibration (neutral orientation + measured flexion axis) to live_calibration.json,
which the dashboard loads (data_source.get_calibration) so its live values read
accurately: a straight leg reads ~0 deg and the degrees match how you mounted the
sensors.

Run once, with the sensors strapped on and the Arduino Serial Monitor CLOSED:
    cd knee
    ../.venv/Scripts/python calibrate_live.py --port COM5
Then start the dashboard (data_source SOURCE_MODE = "serial") and record.
"""

from __future__ import annotations

import argparse
import json
import pathlib

import numpy as np

from sources.serial_source import SerialSource
from calibrate import calibrate_from_quaternions
from axis_calibration import calibrate_flexion_axis

OUT = pathlib.Path(__file__).resolve().parent / "live_calibration.json"


def main() -> None:
    ap = argparse.ArgumentParser(
        description="PASS knee live calibration -> live_calibration.json")
    ap.add_argument("--port", default="COM5", help="serial port, e.g. COM5")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--hold", type=float, default=2.5, help="seconds per pose")
    args = ap.parse_args()

    src = SerialSource(port=args.port, baud=args.baud)
    print("# PASS knee calibration. Make sure the Arduino Serial Monitor is CLOSED.")

    input("\n>> Stand with your leg STRAIGHT and hold still, then press Enter... ")
    straight = src.get_data(args.hold)
    neu = calibrate_from_quaternions(straight.quat_thigh, straight.quat_shank)
    print(f"#   straight-leg captured: n={neu.n_samples}  "
          f"residual_rms={neu.residual_rms_deg:.2f} deg (smaller = held stiller)")

    input(">> Now BEND your knee to about 60 deg and hold still, then press Enter... ")
    bent = src.get_data(args.hold)
    axis_cal = calibrate_flexion_axis(straight.quat_thigh, straight.quat_shank,
                                      bent.quat_thigh, bent.quat_shank)
    print(f"#   flexion axis = {np.round(axis_cal.flexion_axis, 3)}")
    print(f"#   bend {axis_cal.bend_angle_deg:.1f} deg  "
          f"confidence {axis_cal.axis_confidence:.2f}  reliable={axis_cal.reliable}")
    if not axis_cal.reliable:
        print("#   WARN weak calibration: bend further (>= 30 deg), hold stiller, "
              "keep the motion about ONE axis, and re-run for best accuracy.")

    OUT.write_text(json.dumps({
        "q_neutral": neu.q_neutral.tolist(),
        "flexion_axis": axis_cal.flexion_axis.tolist(),
        "bend_angle_deg": float(axis_cal.bend_angle_deg),
        "axis_confidence": float(axis_cal.axis_confidence),
        "reliable": bool(axis_cal.reliable),
    }, indent=2), encoding="utf-8")
    print(f"\n# saved calibration -> {OUT}")
    print("# now set data_source SOURCE_MODE = 'serial' and run the dashboard.")


if __name__ == "__main__":
    main()
