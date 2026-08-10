r"""
PASS live dashboard - AI-generated progress summary + exercise suggestions.

Reads the same persisted history the Logs and Session tabs already show
(webapp/backend/sensor_log.py's periodic snapshots, webapp/backend/
sessions.py's actuation session log) and asks Claude to turn it into a short
plain-language summary for the therapist, plus a few concrete exercise
suggestions - the two things a clinician actually wants out of a session
review, instead of reading raw numbers off several tabs themselves.

This is a genuine LLM call, not a template - it costs a small amount per
request and needs an API key, so it only ever runs when the clinician
explicitly clicks "Generate AI summary" (see the /api/ai/summary endpoint in
main.py), never automatically or on a timer.

Requires ANTHROPIC_API_KEY in the environment. Loaded from webapp/backend/.env
if present (see .env.example in this folder) - that file is gitignored, so
the key never gets committed. Never hardcode a key here.
"""

from __future__ import annotations

import os
import pathlib

from dotenv import load_dotenv

from . import sensor_log, sessions

load_dotenv(pathlib.Path(__file__).resolve().parent / ".env")

MODEL = "claude-sonnet-5"
MAX_TOKENS = 700

SYSTEM_PROMPT = (
    "You are assisting a physical therapist reviewing a patient's wearable "
    "rehab sensor data (PASS - Patient Assessment Sensing System: knee "
    "flexion, hip tilt/flexion, gait cadence, symmetry, and a resistive-load "
    "actuation exercise). Given recent sensor snapshots and actuation "
    "session history, write:\n\n"
    "1. A short progress summary (3-5 sentences, plain clinical language, "
    "no jargon a therapist wouldn't already use).\n"
    "2. 2-4 concrete exercise suggestions for the next session, grounded "
    "specifically in the numbers given - not generic rehab advice.\n\n"
    "Only comment on what the data actually shows. If something is missing "
    "or inconclusive (e.g. not enough sessions logged yet), say so plainly "
    "instead of speculating. Do not invent metrics that weren't provided."
)


def _fmt_snapshot(s: dict) -> str:
    parts = [f"t={s['loggedAt']}"]
    if s.get("kneeL") is not None: parts.append(f"kneeL={s['kneeL']:.0f}deg")
    if s.get("kneeR") is not None: parts.append(f"kneeR={s['kneeR']:.0f}deg")
    if s.get("hipTilt") is not None: parts.append(f"hipTilt={s['hipTilt']:.0f}deg")
    if s.get("rehabScore") is not None: parts.append(f"rehabScore={s['rehabScore']:.0f}/100")
    if s.get("symmetryPct") is not None: parts.append(f"symmetryDelta={s['symmetryPct']:.0f}%")
    if s.get("cadence") is not None: parts.append(f"cadence={s['cadence']:.0f}spm")
    parts.append(f"repsL={s.get('repsL', 0)} repsR={s.get('repsR', 0)}")
    return " ".join(parts)


def _fmt_session(s: dict) -> str:
    result = "completed" if s["completed"] else "force-stopped early"
    return (f"t={s['endedAt']} target={s['target']:g}kg peak={s['peak']:.1f}kg "
            f"avg={s['avg']:.1f}kg duration={s['durationS']:.0f}s ({result})")


def _build_prompt(snapshots: list[dict], actuation: list[dict]) -> str:
    lines = ["## Periodic sensor snapshots (most recent first)"]
    lines += [f"- {_fmt_snapshot(s)}" for s in snapshots] if snapshots else ["(none logged yet)"]
    lines.append("\n## Actuation (resistive-load) sessions (most recent first)")
    lines += [f"- {_fmt_session(s)}" for s in actuation] if actuation else ["(none logged yet)"]
    return "\n".join(lines)


def generate_summary() -> dict:
    """Returns {"summary": str} on success, or {"error": str} if the API key
    is missing, there's nothing to summarize yet, or the API call fails."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY is not set - see webapp/backend/.env.example"}

    snapshots = sensor_log.get_snapshots(limit=30)
    actuation = sessions.get_sessions(limit=10)
    if not snapshots and not actuation:
        return {"error": "No session history logged yet - nothing to summarize."}

    import anthropic  # lazy: only needed once a key is actually configured

    prompt = _build_prompt(snapshots, actuation)
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=MODEL, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:  # network/API failure - surface it, don't crash the endpoint
        return {"error": f"AI request failed: {exc}"}

    text = "".join(block.text for block in resp.content if block.type == "text")
    return {"summary": text}
