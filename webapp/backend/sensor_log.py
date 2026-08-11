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
from datetime import datetime, timedelta, timezone

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


def get_trend(days: int = 90) -> dict:
    """Per-day rollup of the snapshot log so the dashboard can show whether a
    patient is improving or declining over time, not just the current instant.

    Each snapshot (logged ~every 15 min while sensors are live, see
    log_snapshot) is bucketed by its calendar date (UTC). Per metric we keep
    the aggregation that best reflects rehab progress:

      - rehabScore : daily mean  (overall performance that day)
      - maxFlexion : daily peak of either knee's flexion (best ROM reached)
      - symmetry   : daily mean Symmetry Index (raw SI, lower = more symmetric)

    Returns the per-day `points` series plus a per-metric `summary` giving the
    baseline (first day with data), latest, previous (day before latest) and
    the deltas, already sized so a caller just renders arrows. `higherIsBetter`
    is included per metric so an "improving" arrow can reflect real clinical
    improvement (rehab score / ROM up, symmetry index down). The frontend
    presents symmetry as a 100 - SI score so every displayed metric reads the
    same way, but the raw SI is what's stored and returned here.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with _lock:
        conn = _get_conn()
        rows = conn.execute(
            "SELECT logged_at, knee_l, knee_r, rehab_score, symmetry_pct "
            "FROM sensor_snapshots WHERE logged_at >= ? ORDER BY logged_at ASC",
            (cutoff,),
        ).fetchall()

    buckets: dict[str, dict] = {}
    for logged_at, knee_l, knee_r, rehab_score, symmetry_pct in rows:
        day = logged_at[:10]
        b = buckets.setdefault(day, {"rehab": [], "flex": [], "sym": [], "count": 0})
        b["count"] += 1
        if rehab_score is not None:
            b["rehab"].append(rehab_score)
        # Peak ROM counts only physiologically plausible knee flexion. An
        # uncalibrated sensor can report impossible angles (a knee does not
        # bend to 170 deg, nor to -130 deg), and a single such spike would
        # otherwise dominate the daily max and masquerade as range of motion.
        knees = [k for k in (knee_l, knee_r) if k is not None and 0 <= k <= 160]
        if knees:
            b["flex"].append(max(knees))
        if symmetry_pct is not None:
            b["sym"].append(symmetry_pct)

    def _mean(xs: list) -> float | None:
        return round(sum(xs) / len(xs), 1) if xs else None

    points = []
    for day in sorted(buckets):
        b = buckets[day]
        points.append({
            "date": day,
            "rehabScore": _mean(b["rehab"]),
            "maxFlexion": round(max(b["flex"]), 1) if b["flex"] else None,
            "symmetry": _mean(b["sym"]),
            "n": b["count"],
        })

    def _summary(key: str, higher_is_better: bool) -> dict | None:
        series = [p[key] for p in points if p[key] is not None]
        if not series:
            return None
        baseline, latest = series[0], series[-1]
        previous = series[-2] if len(series) >= 2 else None
        return {
            "baseline": baseline,
            "latest": latest,
            "previous": previous,
            "deltaVsBaseline": round(latest - baseline, 1),
            "deltaVsPrevious": round(latest - previous, 1) if previous is not None else None,
            "higherIsBetter": higher_is_better,
            "points": len(series),
        }

    summary = {
        "rehabScore": _summary("rehabScore", True),
        "maxFlexion": _summary("maxFlexion", True),
        "symmetry": _summary("symmetry", False),
    }
    return {"points": points, "summary": summary, "days": days}
