r"""
PASS live dashboard - AI-generated progress summary + exercise suggestions.

Reads the same persisted history the Logs and Session tabs already show
(webapp/backend/sensor_log.py's periodic snapshots, webapp/backend/
sessions.py's actuation session log) and asks an LLM to turn it into a short
plain-language summary for the therapist, plus a few concrete exercise
suggestions - the two things a clinician actually wants out of a session
review, instead of reading raw numbers off several tabs themselves.

This is a genuine LLM call, not a template - runs on Google's Gemini API
specifically because its free tier is a real free tier (not just trial
credits that expire), so this feature costs nothing per use rather than
billing per click. It still only ever runs when the clinician explicitly
clicks "Generate AI summary" (see the /api/ai/summary endpoint in main.py),
never automatically or on a timer - no reason to burn free-tier rate limit
on requests nobody asked for.

Requires GEMINI_API_KEY in the environment (get one free at
https://aistudio.google.com/apikey). Loaded from webapp/backend/.env if
present (see .env.example in this folder) - that file is gitignored, so the
key never gets committed. Never hardcode a key here.
"""

from __future__ import annotations

import os
import pathlib

from dotenv import load_dotenv

from . import sensor_log, sessions

load_dotenv(pathlib.Path(__file__).resolve().parent / ".env")

MODEL = "gemini-flash-latest"   # Google-maintained alias, not a pinned version -
                                 # avoids this breaking again next time a specific
                                 # version gets retired for new API keys
# Whatever model "latest" currently resolves to spends some of this budget on
# internal reasoning before the visible answer - a low limit (originally 700)
# let the reasoning eat the whole budget and cut the summary off before it
# started. Passing thinking_budget=0 to turn reasoning off entirely errored
# on this model (INVALID_ARGUMENT), so the fix is just enough headroom.
MAX_OUTPUT_TOKENS = 3000

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
    "instead of speculating. Do not invent metrics that weren't provided.\n\n"
    "Do not use em dashes or en dashes anywhere. Use a plain hyphen for "
    "ranges (e.g. 8-10 reps) and rephrase sentences instead of using dashes "
    "as punctuation."
)

# Unicode dash variants Gemini sometimes emits despite the instruction above.
# The app deliberately avoids em dashes everywhere, so normalise any of these
# to a plain hyphen before the summary reaches the dashboard or the PDF report.
_DASHES = "‒–—―−"   # figure/en/em/bar/minus


def _strip_dashes(text: str) -> str:
    return "".join("-" if ch in _DASHES else ch for ch in text)


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
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GEMINI_API_KEY is not set - see webapp/backend/.env.example"}

    snapshots = sensor_log.get_snapshots(limit=30)
    actuation = sessions.get_sessions(limit=10)
    if not snapshots and not actuation:
        return {"error": "No session history logged yet - nothing to summarize."}

    from google import genai  # lazy: only needed once a key is actually configured
    from google.genai import types

    prompt = _build_prompt(snapshots, actuation)
    try:
        client = genai.Client(api_key=api_key)
        resp = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT, max_output_tokens=MAX_OUTPUT_TOKENS,
            ),
        )
    except Exception as exc:  # network/API failure - surface it, don't crash the endpoint
        return {"error": f"AI request failed: {exc}"}

    text = (resp.text or "").strip()
    if not text:
        return {"error": "AI returned an empty response - try again."}
    return {"summary": _strip_dashes(text)}
