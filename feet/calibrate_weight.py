"""
calibrate_weight.py
Interactive weight/force calibration helper for the PASS foot insole.

The LEGACT FS-INS-16Z insole is documented as a RELATIVE pressure sensor, not
a calibrated force sensor (see docs/left_insole_channel_map.md) - there is no
known ADC-to-Newton conversion built in anywhere in this project. This script
lets you build one empirically: apply a sequence of KNOWN weights, log the
live reading at each, and fit a curve - the same voltage-divider + known-mass
calibration approach FSR datasheets/guides recommend.

Listens on the same UDP port the live dashboard already reads (:5006), so it
works with a board exactly as already set up - no rewiring, no different
firmware. Applies the same per-channel running-min baseline subtraction
useMetrics.js uses on the dashboard, so an unloaded insole reads ~0 instead
of a large near-4095-per-zone number, and each logged point is a short
rolling average instead of one noisy sample.

Usage:
    python calibrate_weight.py                  # whole left insole (16-zone sum)
    python calibrate_weight.py --side right
    python calibrate_weight.py --channel 12      # single zone only (e.g. heel)

Make sure the insole is completely UNLOADED when the script starts - it
primes the baseline first. Then, at each prompt: place a known weight, let
the reading settle, type the weight in kg, Enter. Include a 0 kg point.
Type 'q' when done (need >=3 points) to fit and print the calibration curve.
"""

from __future__ import annotations

import argparse
import socket
import time

import numpy as np

ADC_MAX = 4095
N_ZONES = 16
UDP_PORT = 5006
G = 9.80665           # standard gravity, kg -> N
SETTLE_S = 1.5         # average the reading over this long before logging a point
BASELINE_PRIME_S = 2.0


def parse_foot_line(line: str, side: str) -> list[int] | None:
    parts = line.strip().split(",")
    if not parts or parts[0] != f"foot_{side}":
        return None
    # unit_id, frame, t_ms, c0..c15, batt  (see feet/firmware/foot_*.ino)
    if len(parts) < 3 + N_ZONES:
        return None
    try:
        return [int(v) for v in parts[3:3 + N_ZONES]]
    except ValueError:
        return None


def sample_window(sock: socket.socket, side: str, channel: int | None,
                   baseline: list[float | None], seconds: float) -> list[float]:
    """Collect (baseline-subtracted) total-load samples for `seconds`, updating
    the running-min baseline per channel as data arrives (same idea as the
    dashboard's own zero-point tracking)."""
    sock.settimeout(0.5)
    totals: list[float] = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            data, _ = sock.recvfrom(2048)
        except socket.timeout:
            continue
        raw = parse_foot_line(data.decode("ascii", "ignore"), side)
        if raw is None:
            continue
        pressure = [ADC_MAX - v for v in raw]
        for i, p in enumerate(pressure):
            baseline[i] = p if baseline[i] is None else min(baseline[i], p)
        loaded = [max(0.0, p - baseline[i]) for i, p in enumerate(pressure)]
        totals.append(loaded[channel] if channel is not None else sum(loaded))
    return totals


def fit_and_report(weights_kg: list[float], readings: list[float]) -> None:
    force_n = np.array(weights_kg) * G
    x = np.array(readings)

    print("\n-- calibration points --")
    for w, r, f in zip(weights_kg, readings, force_n):
        print(f"  {w:6.2f} kg  ({f:6.2f} N)  ->  reading {r:8.1f}")

    m, c = np.polyfit(x, force_n, 1)
    pred_lin = m * x + c
    ss_tot = np.sum((force_n - force_n.mean()) ** 2)
    r2_lin = 1 - np.sum((force_n - pred_lin) ** 2) / ss_tot if ss_tot > 0 else float("nan")
    print(f"\nLinear fit:    F(N) = {m:.6g} * reading + {c:.6g}   (R^2 = {r2_lin:.4f})")

    # Power-law fit (the standard FSR treatment): F = a * reading^b, via
    # log-log linear regression - needs strictly positive points on both axes.
    mask = (x > 0) & (force_n > 0)
    if mask.sum() >= 3:
        b, log_a = np.polyfit(np.log(x[mask]), np.log(force_n[mask]), 1)
        a = np.exp(log_a)
        pred_pow = a * x[mask] ** b
        ss_tot_m = np.sum((force_n[mask] - force_n[mask].mean()) ** 2)
        r2_pow = 1 - np.sum((force_n[mask] - pred_pow) ** 2) / ss_tot_m if ss_tot_m > 0 else float("nan")
        print(f"Power-law fit: F(N) = {a:.6g} * reading^{b:.4f}   (R^2 = {r2_pow:.4f})")
    else:
        print("Power-law fit: need >=3 strictly positive points, skipped")

    print(
        "\nHigher R^2 = better fit. FSRs are typically non-linear, so expect "
        "the power-law fit to win unless your points only span a narrow "
        "range. Where the readings stop increasing as you add more weight is "
        "your practical max - beyond that the sensor (or the ADC) has "
        "saturated and can no longer tell loads apart. Neither fit replaces "
        "a real load cell - treat this as a rough estimate, and re-run it if "
        "you change the insole, the pull-up resistor, or which zone(s) you "
        "sum, per the RELATIVE-sensor warning in docs/left_insole_channel_map.md."
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Interactive FSR insole weight calibration")
    ap.add_argument("--side", choices=["left", "right"], default="left")
    ap.add_argument("--channel", type=int, default=None,
                     help="calibrate one zone (0-15) instead of the whole-insole sum")
    ap.add_argument("--port", type=int, default=UDP_PORT)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", args.port))

    target = f"zone {args.channel}" if args.channel is not None else "whole insole (16-zone sum)"
    print(f"Listening on UDP :{args.port} for foot_{args.side} - calibrating {target}.")

    baseline: list[float | None] = [None] * N_ZONES
    input(f"\nMake sure the insole is completely UNLOADED right now, then press Enter "
          f"to prime the baseline ({BASELINE_PRIME_S:.0f}s)...")
    primed = sample_window(sock, args.side, args.channel, baseline, BASELINE_PRIME_S)
    if not primed:
        print("  WARNING: no foot_" + args.side + " packets received - is the board powered "
              "and on WiFi? Continuing anyway; baseline will prime from the first real data.")
    else:
        print(f"  baseline primed ({len(primed)} samples)")

    print("\nAt each prompt: place a known weight, let it settle, then enter the weight "
          "in kg. Include a 0 kg point. Type 'q' when done (need >=3 points).\n")

    weights_kg: list[float] = []
    readings: list[float] = []

    while True:
        raw_in = input("weight (kg), or 'q' to fit and quit: ").strip()
        if raw_in.lower() == "q":
            break
        try:
            w = float(raw_in)
        except ValueError:
            print("  not a number, try again")
            continue
        print(f"  averaging for {SETTLE_S:.0f}s...")
        samples = sample_window(sock, args.side, args.channel, baseline, SETTLE_S)
        if not samples:
            print("  no packets received in that window - point NOT logged, try again")
            continue
        reading = sum(samples) / len(samples)
        print(f"  reading = {reading:.1f}")
        weights_kg.append(w)
        readings.append(reading)

    if len(weights_kg) < 3:
        print(f"\nNeed at least 3 points to fit a curve - collected {len(weights_kg)}")
        return
    fit_and_report(weights_kg, readings)


if __name__ == "__main__":
    main()
