r"""
run_live_wifi.py
PASS knee module - live run over WiFi (UDP) instead of the USB serial link.

Identical guided flow to run_live.py:

    NetworkSource (UDP :5005 from the knee firmware)
      -> straight-leg zero        (calibrate.calibrate_from_quaternions)
      -> measured flexion axis    (axis_calibration.calibrate_flexion_axis)
      -> live scrolling knee angle (live_plot.LiveKneePlot, causal low-pass)

The ONLY difference from run_live.py is the source: the knee firmware
(knee_wifi.ino) joins the travel router (30.007) and unicasts the SAME CSV
contract to this laptop over UDP, which NetworkSource parses with the same
parser as the serial link. Everything downstream (engine, calibration, plot) is
unchanged.

PREREQS
-------
  * travel router 30.007 powered on and near everything;
  * this laptop connected to 30.007 (ipconfig shows 192.168.0.100);
  * the knee's serial/boot log shows "# knee wifi JOINED ...".

USAGE:
    cd knee
    ..\.venv\Scripts\python run_live_wifi.py
    ..\.venv\Scripts\python run_live_wifi.py --port 5005 --hold 3
"""

from __future__ import annotations

import argparse

import numpy as np

from sources.network_source import NetworkSource, DEFAULT_UDP_PORT
from calibrate import calibrate_from_quaternions
from axis_calibration import calibrate_flexion_axis
from live_plot import LiveKneePlot
from filters import DEFAULT_CUTOFF_HZ


def main() -> None:
    ap = argparse.ArgumentParser(
        description="PASS knee live run over WiFi UDP (NetworkSource)")
    ap.add_argument("--port", type=int, default=DEFAULT_UDP_PORT,
                    help="UDP port the knee firmware sends to (default 5005)")
    ap.add_argument("--hold", type=float, default=2.5,
                    help="seconds to hold each calibration pose")
    ap.add_argument("--window", type=float, default=10.0, help="live scroll window (s)")
    ap.add_argument("--cutoff", type=float, default=DEFAULT_CUTOFF_HZ,
                    help="low-pass cutoff (Hz)")
    ap.add_argument("--fps", type=float, default=30.0, help="plot redraw rate")
    args = ap.parse_args()

    source = NetworkSource(port=args.port)

    print("# PASS knee live run (WiFi)")
    print(f"# listening on UDP :{args.port}. The knee must show JOINED and this "
          "laptop must be on 30.007 (192.168.0.100). Allow Python through the "
          "firewall if it hangs with no data.")

    # 1. Straight-leg pose: both the zero (q_neutral) and the axis-measurement neutral.
    input("\n>> Stand with your leg STRAIGHT and hold still, then press Enter... ")
    straight = source.get_data(args.hold)
    neu = calibrate_from_quaternions(straight.quat_thigh, straight.quat_shank)
    print(f"#   straight-leg captured: n={neu.n_samples}  "
          f"residual_rms={neu.residual_rms_deg:.2f} deg  (smaller = held stiller)")

    # 2. Bent pose: the neutral->bent rotation gives the flexion axis.
    input(">> Now BEND your knee to about 60 deg and hold still, then press Enter... ")
    bent = source.get_data(args.hold)
    axis_cal = calibrate_flexion_axis(straight.quat_thigh, straight.quat_shank,
                                      bent.quat_thigh, bent.quat_shank)
    print(f"#   flexion axis = {np.round(axis_cal.flexion_axis, 3)}")
    print(f"#   bend {axis_cal.bend_angle_deg:.1f} deg  "
          f"confidence {axis_cal.axis_confidence:.2f}  reliable={axis_cal.reliable}")
    if not axis_cal.reliable:
        print("#   WARN weak calibration: bend further (>= 30 deg), hold stiller, and "
              "keep the motion about ONE axis. Ctrl-C and re-run for a clean axis.")

    # 3. Live scrolling knee angle, zeroed and on the measured axis, causal-filtered.
    print("\n# Opening the live plot. Bend and extend your knee to see it track.")
    print("# Close the plot window to stop.")
    LiveKneePlot(source, window_s=args.window, target_fps=args.fps,
                 cutoff_hz=args.cutoff, axis=axis_cal.flexion_axis,
                 q_neutral=neu.q_neutral,
                 title=f"PASS knee - live (WiFi, UDP :{args.port})").run()


if __name__ == "__main__":
    main()
