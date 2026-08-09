r"""
PASS live dashboard - periodic sensor snapshot log.

Unlike webapp/backend/sessions.py (one entry per discrete actuation session,
triggered by Stop/Force Stop), the knee/hip/feet sensors stream continuously
with no natural start/stop - a "session" isn't a meaningful unit for them.
Instead the frontend (App.jsx) POSTs a snapshot of its live computed metrics
(useMetrics.js's `m`) on a fixed interval throughout the day, so the Logs tab
can show how things looked at different points in time rather than only the
current instant. Same SQLite-for-persistence reasoning as sessions.py -
separate .db file so the two logs (discrete sessions vs. periodic snapshots)
don't share a table for two differently-shaped kinds of data.
"""

from __future__ import annotations

import pathlib
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = pathlib.Path(__file__).resolve().parent / "sensor_log.db"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS sensor_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                logged_at TEXT NOT NULL,
                knee_l REAL, knee_r REAL, hip_tilt REAL,
                rehab_score REAL, symmetry_pct REAL, cadence REAL,
                reps_l INTEGER, reps_r INTEGER
            )
        """)
        _conn.commit()
    return _conn


def log_snapshot(knee_l: float | None, knee_r: float | None, hip_tilt: float | None,
                  rehab_score: float | None, symmetry_pct: float | None, cadence: float | None,
                  reps_l: int | None, reps_r: int | None) -> dict:
    logged_at = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO sensor_snapshots "
            "(logged_at, knee_l, knee_r, hip_tilt, rehab_score, symmetry_pct, cadence, reps_l, reps_r) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (logged_at, knee_l, knee_r, hip_tilt, rehab_score, symmetry_pct, cadence, reps_l, reps_r),
        )
        conn.commit()
        row_id = cur.lastrowid
    return {"id": row_id, "loggedAt": logged_at, "kneeL": knee_l, "kneeR": knee_r, "hipTilt": hip_tilt,
            "rehabScore": rehab_score, "symmetryPct": symmetry_pct, "cadence": cadence,
            "repsL": reps_l, "repsR": reps_r}


def get_snapshots(limit: int = 200) -> list[dict]:
    """Most recent snapshots first."""
    with _lock:
        conn = _get_conn()
        rows = conn.execute(
            "SELECT id, logged_at, knee_l, knee_r, hip_tilt, rehab_score, symmetry_pct, cadence, reps_l, reps_r "
            "FROM sensor_snapshots ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"id": r[0], "loggedAt": r[1], "kneeL": r[2], "kneeR": r[3], "hipTilt": r[4],
         "rehabScore": r[5], "symmetryPct": r[6], "cadence": r[7], "repsL": r[8], "repsR": r[9]}
        for r in rows
    ]
