"""
normalize.py
PASS insole per-zone normalization (task 4).

Zones vary in sensitivity and resting level, so raw counts are not comparable
across zones. Given a STANDING-STILL calibration segment, this computes each
zone's static standing load and rescales so the output is FRACTION OF STATIC LOAD:
a zone at its standing load reads ~1.0, more reads > 1, less reads < 1. That puts
all 16 zones on the same fair scale.

Re-runnable per session: call fit() again with a fresh standing segment each time
the insole is put on (mounting shifts). Nothing is baked in.

Pressure input is the inverted (pressure-reads-up) value from InsoleSource.
"""

from __future__ import annotations

import numpy as np

from .schema import N_ZONES

MIN_LOAD = 20.0          # floor (counts) so zones bearing ~no standing load do not blow up


class ZoneNormalizer:
    """Fit a per-zone standing-load reference, then scale to fraction-of-static-load."""

    def __init__(self, min_load: float = MIN_LOAD):
        self.min_load = float(min_load)
        self.standing_load: np.ndarray | None = None    # (16,)

    @property
    def is_fitted(self) -> bool:
        return self.standing_load is not None

    def fit(self, standing_pressure: np.ndarray) -> "ZoneNormalizer":
        """Learn the standing reference from a still segment.

        standing_pressure: (M,16) frames captured while standing still, or a single
        (16,) frame. Re-runnable: each call replaces the previous reference."""
        p = np.atleast_2d(np.asarray(standing_pressure, dtype=float))
        if p.shape[-1] != N_ZONES:
            raise ValueError(f"expected (M,{N_ZONES}) pressure, got {p.shape}")
        mean = p.mean(axis=0)
        self.standing_load = np.maximum(mean, self.min_load)
        return self

    def transform(self, pressure: np.ndarray) -> np.ndarray:
        """Scale pressure to fraction-of-static-load. Accepts (16,) or (N,16).
        Standing-load reads ~1.0 per zone."""
        if not self.is_fitted:
            raise RuntimeError("ZoneNormalizer.fit() must be called first")
        return np.asarray(pressure, dtype=float) / self.standing_load
