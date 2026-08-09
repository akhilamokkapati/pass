r"""
PASS live dashboard - actuation session log + next-weight recommendation.

Every completed (or force-stopped) actuation session gets written to a local
SQLite file (webapp/backend/sessions.db, gitignored - it's runtime data, not
source, same reasoning as webapp/frontend/dist). This is what makes "based on
progress so far" mean something: without it there's no history to look back
on. SQLite specifically because it needs zero setup (stdlib sqlite3, no
server, no new dependency) and survives backend restarts on a local machine -
the actual way this app has been run all along. It will NOT survive a Render
free-tier redeploy (no persistent disk there - see render.yaml's plan: free),
same limitation as everything else on that tier; fine for local use, which is
what this feature is for.
"""

from __future__ import annotations

import pathlib
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = pathlib.Path(__file__).resolve().parent / "sessions.db"

# One connection guarded by a lock - SQLite handles concurrent readers fine,
# but this backend's own writes (session log + recommendation approve/reject)
# can come from different request-handler coroutines, so serialize them
# rather than trust sqlite3's default connection-per-thread assumption doesn't
# get violated by FastAPI's async handlers running on different threads.
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

# How close actual tension needs to track the target to count as "on track" -
# same +/-5% band ActuationPanel.jsx's own live "Delta%" readout already
# calls good, reused here rather than inventing a second threshold.
GOOD_DELTA_PCT = 5.0


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS actuation_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ended_at TEXT NOT NULL,
                target_kg REAL NOT NULL,
                duration_s REAL NOT NULL,
                peak_kg REAL NOT NULL,
                avg_kg REAL NOT NULL,
                samples INTEGER NOT NULL,
                completed INTEGER NOT NULL
            )
        """)
        _conn.commit()
    return _conn


def log_session(target_kg: float, duration_s: float, peak_kg: float, avg_kg: float,
                 samples: int, completed: bool) -> dict:
    """Record one finished session (completed normally via Stop, or cut short
    via Force Stop mid-exercise - `completed` distinguishes the two). A forced
    stop is itself a meaningful signal for the recommendation ("this was too
    much"), so it's logged too, not discarded."""
    ended_at = datetime.now(timezone.utc).isoformat()
    with _lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO actuation_sessions (ended_at, target_kg, duration_s, peak_kg, avg_kg, samples, completed) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (ended_at, target_kg, duration_s, peak_kg, avg_kg, samples, 1 if completed else 0),
        )
        conn.commit()
        row_id = cur.lastrowid
    return {"id": row_id, "endedAt": ended_at, "target": target_kg, "durationS": duration_s,
            "peak": peak_kg, "avg": avg_kg, "samples": samples, "completed": completed}


def get_sessions(limit: int = 50) -> list[dict]:
    """Most recent sessions first."""
    with _lock:
        conn = _get_conn()
        rows = conn.execute(
            "SELECT id, ended_at, target_kg, duration_s, peak_kg, avg_kg, samples, completed "
            "FROM actuation_sessions ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"id": r[0], "endedAt": r[1], "target": r[2], "durationS": r[3],
         "peak": r[4], "avg": r[5], "samples": r[6], "completed": bool(r[7])}
        for r in rows
    ]


def recommend_next_kg(kg_options: list[float]) -> dict | None:
    """Suggest the next force level from the single most recent session, using
    the same "on track" band the live dashboard already shows the patient/
    clinician during a session - not a new, separately-tuned threshold.

    - No sessions yet -> no recommendation (nothing to base one on).
    - Forced-stopped early, or actual tension drifted outside the good band ->
      stay at the same level (it wasn't clearly mastered yet).
    - Completed cleanly, on target, and not already at the top preset -> step
      up to the next kg_options level.
    - Completed cleanly at the top preset already -> stay (nothing higher to
      recommend).
    """
    sessions = get_sessions(limit=1)
    if not sessions:
        return None
    last = sessions[0]
    target = last["target"]
    delta_pct = abs((last["avg"] - target) / target) * 100 if target > 0 else 100

    on_track = last["completed"] and delta_pct <= GOOD_DELTA_PCT
    options = sorted(kg_options)
    try:
        idx = options.index(target)
    except ValueError:
        idx = -1  # last session's target isn't one of the current presets - stay put, don't guess a step

    if on_track and 0 <= idx < len(options) - 1:
        next_kg = options[idx + 1]
        reason = f"Last session held {last['avg']:.1f} kg against a {target:g} kg target " \
                 f"(within {GOOD_DELTA_PCT:g}%) and finished without a force stop."
    else:
        next_kg = target if idx >= 0 else options[0]
        if not last["completed"]:
            reason = f"Last session at {target:g} kg was stopped early - recommend staying here."
        elif delta_pct > GOOD_DELTA_PCT:
            reason = f"Last session at {target:g} kg drifted {delta_pct:.0f}% from target - recommend staying here."
        else:
            reason = f"Already at the top preset ({target:g} kg) and on track - recommend staying here."

    return {"kg": next_kg, "reason": reason, "basedOnSessionId": last["id"]}


# ---- live pending-recommendation state ------------------------------------
# Separate from the SQLite log above on purpose: this is "what's currently
# awaiting a clinician's decision right now", not history - in-memory is
# right for it, the same way ingest.py's live sensor STATE is in-memory while
# actuation_sessions.db is what actually needs to survive a restart. Read by
# main.py's broadcaster and merged into the same WebSocket snapshot every
# other live reading already flows through, so a clinician's approve/reject
# shows up on the patient's screen the same tick as everything else does -
# no separate notification channel to build.
_pending: dict | None = None
_state_lock = threading.Lock()


def refresh_recommendation(kg_options: list[float]) -> dict | None:
    """Recompute from the latest session and set it as the new pending
    recommendation (status='pending'), replacing whatever was there before -
    a fresh session always supersedes an old, un-acted-on suggestion."""
    global _pending
    rec = recommend_next_kg(kg_options)
    with _state_lock:
        _pending = {**rec, "status": "pending"} if rec else None
    return _pending


def respond_to_recommendation(approved: bool) -> dict | None:
    """Clinician approve/reject. No-op (returns None) if nothing is pending -
    e.g. a stale button click after a new session already replaced it."""
    global _pending
    with _state_lock:
        if _pending is None:
            return None
        _pending = {**_pending, "status": "approved" if approved else "rejected"}
        return _pending


def get_pending_recommendation() -> dict | None:
    with _state_lock:
        return _pending
