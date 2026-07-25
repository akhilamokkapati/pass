"""
schema.py
PASS feet insole data schema - the shared insole frame/capture contract.

Mirrors the ROLE of the knee sources' schema (one shared definition both the
source and consumers import), but the insole payload is its own shape: a 16-zone
pressure vector, not knee quaternions. It deliberately does not reuse or extend
the knee Packet/Capture.

Pressure here is already INVERTED (pressure reads up), so higher = more load.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

N_ZONES = 16


@dataclass
class InsoleFrame:
    """One scan of the 16 zones."""
    t_ms: int                      # milliseconds since the source started
    frame: int                     # incrementing counter (drop detection)
    pressure: np.ndarray           # (16,) inverted counts, pressure reads up


@dataclass
class InsoleCapture:
    """A finite span of scans as arrays (the get_data return contract)."""
    t_ms: np.ndarray               # (N,)
    frame: np.ndarray              # (N,)
    pressure: np.ndarray           # (N,16) inverted counts
