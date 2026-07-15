"""
app.py
PASS: Patient Assessment Sensing System (Knee Rehabilitation) dashboard.

A display layer ONLY. All measurement (engine, metrics, rep detection) comes from
the validated pipeline via imports; this file renders it. Data is read through
the single swappable point in data_source.get_source(), so switching to the real
sensor later touches only data_source.py.

Run from the knee/ folder:
    ../.venv/Scripts/streamlit run dashboard/app.py

Demo login: password 1234, pick Patient or Therapist.
"""

from __future__ import annotations

import sys
import pathlib

# Make the project modules (sources/, metrics.py, repetitions.py) importable when
# Streamlit runs this file from dashboard/.
ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import time
from collections import deque
from datetime import date, timedelta

import numpy as np
import pandas as pd
import altair as alt
import streamlit as st

import theme
from data_source import get_source, source_label
from biomechanics.relative_orientation import knee_relative
from biomechanics.joint_angles import knee_flexion_angle
from filters import StreamingLowpass, lowpass_offline
from metrics import range_of_motion, summarize
from repetitions import detect_reps

DEMO_PASSWORD = "1234"

# --- patient live-plot tuning ---------------------------------------------
PLOT_WINDOW_S = 8.0          # width of the scrolling live plot (seconds)
SESSION_WINDOW_S = 30.0      # history used for ROM / rep metrics (seconds)
RUN_EVERY_S = 0.15           # fragment redraw cadence (~7 fps)
ACCENT = theme.CHART         # brand data-viz teal

# --- static demo data (encouragement) -------------------------------------
DEMO_STREAK_DAYS = 5
DEMO_ROM_IMPROVEMENT_DEG = 8

# --- therapist view tuning ------------------------------------------------
SESSION_DURATION_S = 12.0    # length of the analysed "current session"
HISTORY_WEEKS = 6            # weeks of demo history to generate
HISTORY_PER_WEEK = 3        # sessions per week
GOAL_ROM_DEG = 70           # clinical target line on the trend


# --- session / routing ----------------------------------------------------

def init_state():
    st.session_state.setdefault("authenticated", False)
    st.session_state.setdefault("role", None)
    # Persist the session in the URL so a refresh (or the wordmark "home" link)
    # keeps you signed in instead of dropping back to the login screen.
    if not st.session_state.authenticated:
        role = st.query_params.get("role")
        if role in ("Patient", "Therapist"):
            st.session_state.authenticated = True
            st.session_state.role = role


def do_logout():
    _reset_patient_stream()
    _reset_therapist_session()
    st.query_params.clear()
    st.session_state.authenticated = False
    st.session_state.role = None


def home_href() -> str:
    """Link target for the wordmark: reload the current role's home. The nonce
    forces a real navigation (so a therapist on any tab returns to Progress),
    while the role param keeps the session signed in across the reload."""
    return f"?role={st.session_state.role}&h={int(time.time() * 1000)}"


# --- login screen ---------------------------------------------------------

def login_screen():
    _, mid, _ = st.columns([1, 1.5, 1])
    with mid:
        st.markdown(f"""
<div style="text-align:center; margin: 8px 0 2px;">
  <div style="display:flex; align-items:center; justify-content:center; gap:13px;">
    {theme.logo_svg(42)}
    <span style="font-family:{theme.FONT_HEAD}; font-size:2.3rem; font-weight:600;
                 letter-spacing:0.01em; color:{theme.PRIMARY_DK}; line-height:1;">PASS</span>
  </div>
  <p style="color:{theme.MUTED}; margin-top:12px; font-size:0.95rem;">
    Patient Assessment Sensing System<br>
    <span style="font-size:0.85rem; color:{theme.FAINT};">Knee Rehabilitation</span>
  </p>
</div>
""", unsafe_allow_html=True)
        st.write("")

        with st.form("login", clear_on_submit=False):
            role = st.radio("I am a", ["Patient", "Therapist"], horizontal=True)
            password = st.text_input("Password", type="password",
                                     placeholder="Enter password")
            submitted = st.form_submit_button("Sign in", use_container_width=True,
                                              type="primary")
        if submitted:
            if password == DEMO_PASSWORD:
                st.session_state.authenticated = True
                st.session_state.role = role
                st.query_params["role"] = role
                st.rerun()
            else:
                st.error("Incorrect password.")

        st.markdown(
            f"<p style='text-align:center; color:{theme.MUTED}; font-size:0.8rem;'>"
            f"SUTD 30.007 &nbsp;·&nbsp; demo access: password <b>1234</b></p>",
            unsafe_allow_html=True)


# --- authenticated shell --------------------------------------------------

def render_sidebar():
    with st.sidebar:
        theme.render_sidebar_brand()
        st.caption("Knee Rehabilitation")
        st.divider()
        theme.section_label("Signed in as")
        st.markdown(f"**{st.session_state.role}**")
        theme.section_label("Data source")
        st.markdown(source_label())
        st.divider()
        st.button("Sign out", on_click=do_logout, use_container_width=True)


def _init_patient_stream():
    """Create the stream, causal filter and rolling buffers once (persist across
    fragment reruns via session_state)."""
    ss = st.session_state
    if ss.get("p_stream") is not None:
        return
    source = get_source()
    rate = float(getattr(source, "rate_hz", getattr(source, "fs_hz", 100.0)))
    ss.p_source = source
    ss.p_rate = rate
    ss.p_stream = source.stream()
    ss.p_filter = StreamingLowpass(cutoff_hz=6.0, fs_hz=rate)
    ss.p_times = deque(maxlen=int(PLOT_WINDOW_S * rate) + 5)
    ss.p_angles = deque(maxlen=int(PLOT_WINDOW_S * rate) + 5)
    ss.p_session = deque(maxlen=int(SESSION_WINDOW_S * rate))


def _reset_patient_stream():
    for k in ("p_source", "p_rate", "p_stream", "p_filter",
              "p_times", "p_angles", "p_session"):
        st.session_state.pop(k, None)


def _pull_samples(n: int):
    """Pull n packets, compute the knee angle through the validated engine, smooth
    causally, and append to the buffers. The whole per-sample hot path."""
    ss = st.session_state
    for _ in range(n):
        try:
            pkt = next(ss.p_stream)
        except StopIteration:
            break
        # validated path: recompute angle from the raw quaternions (source-agnostic).
        # Default +x flexion axis for synthetic; becomes the measured axis on hardware.
        raw = float(knee_flexion_angle(knee_relative(pkt.quat_thigh, pkt.quat_shank)))
        ss.p_angles.append(ss.p_filter.process(raw))
        ss.p_times.append(pkt.t_ms / 1000.0)
        ss.p_session.append(ss.p_angles[-1])


@st.fragment(run_every=RUN_EVERY_S)
def _patient_live_panel():
    """Reruns independently ~7x/s: advance the stream, refresh cards + plot only."""
    ss = st.session_state
    _pull_samples(max(1, int(ss.p_rate * RUN_EVERY_S)))

    session = np.fromiter(ss.p_session, dtype=float)
    rom = range_of_motion(session) if session.size else 0.0
    reps = detect_reps(session, ss.p_rate).count if session.size >= 3 else 0

    c1, c2, c3 = st.columns(3)
    c1.metric("Today's range of motion", f"{rom:.0f}°",
              f"{DEMO_ROM_IMPROVEMENT_DEG}° this week")
    c2.metric("Reps this session", f"{reps}")
    c3.metric("Day streak", f"{DEMO_STREAK_DAYS} days")

    st.write("")
    if ss.p_times:
        df = pd.DataFrame({"t": np.fromiter(ss.p_times, float),
                           "angle": np.fromiter(ss.p_angles, float)})
        tmax = float(df["t"].iloc[-1])
        tmin = max(0.0, tmax - PLOT_WINDOW_S)
        base = alt.Chart(df).encode(
            x=alt.X("t:Q", title="Seconds",
                    scale=alt.Scale(domain=[tmin, tmax], nice=False)),
            y=alt.Y("angle:Q", title="Knee angle (°)",
                    scale=alt.Scale(domain=[-5, 75])),
        )
        chart = (base.mark_area(opacity=0.12, color=ACCENT)
                 + base.mark_line(color=ACCENT, strokeWidth=2.5)).properties(height=320)
        st.altair_chart(chart, use_container_width=True)
    else:
        theme.callout("info", "Warming up the sensor stream.")


def patient_view():
    _init_patient_stream()
    theme.render_brand_header(home_href=home_href())

    st.markdown("## Welcome back")
    st.caption(date.today().strftime("%A, %d %B %Y") + "  ·  today's session")
    theme.callout("positive",
                  f"Great progress. Your range of motion improved "
                  f"<b>{DEMO_ROM_IMPROVEMENT_DEG}°</b> this week. Keep it up.")
    st.write("")

    theme.section_label("Live knee movement")
    _patient_live_panel()


@st.cache_data
def generate_demo_history() -> pd.DataFrame:
    """Fabricated ~6-week session history (ROM improving over time). DEMO DATA,
    labeled as such wherever it is shown. Deterministic (seeded)."""
    rng = np.random.default_rng(42)
    n = HISTORY_WEEKS * HISTORY_PER_WEEK
    start = date.today() - timedelta(days=HISTORY_WEEKS * 7)
    dates = [start + timedelta(days=round(i * (HISTORY_WEEKS * 7) / n)) for i in range(n)]
    rom = np.linspace(42, 66, n) + rng.normal(0, 2.2, n)
    reps = np.clip(np.round(np.linspace(8, 16, n) + rng.normal(0, 1.3, n)), 4, None)
    max_flex = rom + rng.normal(1.0, 1.2, n)
    return pd.DataFrame({
        "date": pd.to_datetime(dates),
        "session": np.arange(1, n + 1),
        "rom_deg": rom.round(1),
        "max_flexion_deg": max_flex.round(1),
        "reps": reps.astype(int),
    })


def _reset_therapist_session():
    for k in ("th_rate", "th_time", "th_angle", "th_metrics", "th_reps"):
        st.session_state.pop(k, None)


def _capture_current_session():
    """Capture and analyse one session from the swappable source (cached in
    session_state so it is stable across reruns / tab switches)."""
    ss = st.session_state
    if ss.get("th_angle") is not None:
        return
    src = get_source()
    rate = float(getattr(src, "rate_hz", getattr(src, "fs_hz", 100.0)))
    cap = src.get_data(SESSION_DURATION_S)
    raw = knee_flexion_angle(knee_relative(cap.quat_thigh, cap.quat_shank))
    angle = lowpass_offline(np.asarray(raw, float), cutoff_hz=6.0, fs_hz=rate)
    ss.th_rate = rate
    ss.th_time = np.asarray(cap.t_ms, float) / 1000.0
    ss.th_angle = angle
    ss.th_metrics = summarize(angle, rate)
    ss.th_reps = detect_reps(angle, rate)


def _cadence_rpm(reps) -> float:
    pt = np.asarray(reps.peak_times_s, float)
    if pt.size >= 2 and (pt[-1] - pt[0]) > 0:
        return (reps.count - 1) / (pt[-1] - pt[0]) * 60.0
    return float("nan")


# --- therapist tabs -------------------------------------------------------

def _tab_progress(hist: pd.DataFrame):
    theme.callout("caution",
                  "Sample data: generated for demonstration (no real patient history yet).")
    change = hist["rom_deg"].iloc[-1] - hist["rom_deg"].iloc[0]
    c1, c2, c3 = st.columns(3)
    c1.metric("Starting ROM", f"{hist['rom_deg'].iloc[0]:.0f}°")
    c2.metric("Latest ROM", f"{hist['rom_deg'].iloc[-1]:.0f}°", f"{change:+.0f}° over 6 wks")
    c3.metric("Avg reps / session", f"{hist['reps'].mean():.0f}")

    goal = alt.Chart(pd.DataFrame({"y": [GOAL_ROM_DEG]})).mark_rule(
        strokeDash=[5, 5], color="#9aa5b1").encode(y="y:Q")
    goal_txt = alt.Chart(pd.DataFrame({"y": [GOAL_ROM_DEG], "t": [f"Goal {GOAL_ROM_DEG}°"]})).mark_text(
        align="left", dx=5, dy=-6, color="#9aa5b1").encode(
        y="y:Q", text="t:N", x=alt.value(5))
    base = alt.Chart(hist).encode(
        x=alt.X("date:T", title="Session date"),
        y=alt.Y("rom_deg:Q", title="Range of motion (°)",
                scale=alt.Scale(domain=[35, 75])))
    line = base.mark_line(color=ACCENT, strokeWidth=2.5, point=alt.OverlayMarkDef(color=ACCENT))
    theme.section_label("Range-of-motion trend · sample data")
    st.altair_chart((line + goal + goal_txt).properties(height=300), use_container_width=True)

    reps_bar = alt.Chart(hist).mark_bar(color=ACCENT, opacity=0.7).encode(
        x=alt.X("date:T", title="Session date"),
        y=alt.Y("reps:Q", title="Reps completed"))
    theme.section_label("Repetitions per session · sample data")
    st.altair_chart(reps_bar.properties(height=180), use_container_width=True)


def _tab_current(ss):
    m, r, rate = ss.th_metrics, ss.th_reps, ss.th_rate
    st.caption(f"Computed live from the data source ({source_label()}) "
               "through the validated engine.")
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Range of motion", f"{m.range_of_motion_deg:.1f}°")
    c2.metric("Max flexion", f"{m.max_flexion_deg:.1f}°")
    c3.metric("Max extension", f"{m.max_extension_deg:.1f}°")
    c4.metric("Peak ang. velocity", f"{m.peak_angular_velocity_dps:.0f}°/s")
    cadence = _cadence_rpm(r)
    c5.metric("Cadence", "N/A" if np.isnan(cadence) else f"{cadence:.0f} rpm")

    df = pd.DataFrame({"t": ss.th_time, "angle": ss.th_angle})
    lo = float(min(-5, np.min(ss.th_angle) - 5))
    hi = float(max(75, np.max(ss.th_angle) + 5))
    base = alt.Chart(df).encode(
        x=alt.X("t:Q", title="Seconds"),
        y=alt.Y("angle:Q", title="Knee angle (°)", scale=alt.Scale(domain=[lo, hi])))
    chart = (base.mark_area(opacity=0.10, color=ACCENT)
             + base.mark_line(color=ACCENT, strokeWidth=2))
    theme.section_label("Knee angle · full session")
    st.altair_chart(chart.properties(height=280), use_container_width=True)


def _tab_reps(r, rate):
    st.caption("Detection with honesty indicators: how much to trust the count, "
               "not just the count.")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Reps detected", f"{r.count}")
    c2.metric("Adaptive prominence", f"{r.effective_prominence_deg:.1f}°",
              help="Peak-detection threshold, scaled to this patient's ROM so "
                   "shallow low-ROM reps are still counted.")
    amp = "N/A" if np.isnan(r.amplitude_cv) else f"{r.amplitude_cv:.2f}"
    per = "N/A" if np.isnan(r.period_cv) else f"{r.period_cv:.2f}"
    c3.metric("Amplitude consistency (CV)", amp,
              help="Coefficient of variation of rep depth. Lower = more consistent.")
    c4.metric("Timing consistency (CV)", per,
              help="Coefficient of variation of rep intervals. Lower = steadier cadence.")

    st.write("")
    if r.partial_at_start or r.partial_at_end:
        which = []
        if r.partial_at_start:
            which.append("first")
        if r.partial_at_end:
            which.append("last")
        theme.callout(
            "caution",
            f"The <b>{' and '.join(which)}</b> rep may be cut off: the recording "
            "started or ended mid-movement, so the count is a lower bound. "
            f"Trusted range: <b>{r.count}–{r.count + len(which)} reps</b>.")
    else:
        theme.callout(
            "positive",
            "Recording is complete: no partial reps at either edge; "
            "the count is reliable.")

    if r.count > 0:
        table = pd.DataFrame({
            "Rep": np.arange(1, r.count + 1),
            "Time (s)": np.round(r.peak_times_s, 2),
            "Peak flexion (°)": np.round(r.peak_values_deg, 1),
            "Prominence (°)": np.round(r.peak_prominences_deg, 1),
        })
        theme.section_label("Per-repetition detail")
        st.dataframe(table, use_container_width=True, hide_index=True)


def _tab_compare(hist: pd.DataFrame):
    theme.callout("caution", "Sample data: demonstration only.")
    labels = {int(row.session): f"Session {int(row.session)} · {row.date:%d %b} · ROM {row.rom_deg:.0f}°"
              for row in hist.itertuples()}
    sessions = list(labels)
    col_a, col_b = st.columns(2)
    a = col_a.selectbox("Session A", sessions, index=len(sessions) - 4,
                        format_func=lambda s: labels[s])
    b = col_b.selectbox("Session B", sessions, index=len(sessions) - 1,
                        format_func=lambda s: labels[s])
    ra = hist[hist.session == a].iloc[0]
    rb = hist[hist.session == b].iloc[0]

    st.write("")
    m1, m2, m3 = st.columns(3)
    m1.metric("ROM", f"{rb.rom_deg:.0f}°", f"{rb.rom_deg - ra.rom_deg:+.0f}° vs A")
    m2.metric("Max flexion", f"{rb.max_flexion_deg:.0f}°",
              f"{rb.max_flexion_deg - ra.max_flexion_deg:+.0f}° vs A")
    m3.metric("Reps", f"{int(rb.reps)}", f"{int(rb.reps - ra.reps):+d} vs A")

    comp = pd.DataFrame({
        "metric": ["ROM (°)", "Max flexion (°)", "Reps"],
        f"Session {a}": [ra.rom_deg, ra.max_flexion_deg, ra.reps],
        f"Session {b}": [rb.rom_deg, rb.max_flexion_deg, rb.reps],
    }).melt("metric", var_name="session", value_name="value")
    bars = alt.Chart(comp).mark_bar().encode(
        x=alt.X("session:N", title=None, axis=alt.Axis(labelAngle=0)),
        y=alt.Y("value:Q", title=None),
        color=alt.Color("session:N", scale=alt.Scale(range=[ACCENT, "#7fb7d6"]), legend=None),
        column=alt.Column("metric:N", title=None))
    st.altair_chart(bars.properties(height=200, width=140))


def therapist_view():
    _capture_current_session()
    ss = st.session_state
    m, r = ss.th_metrics, ss.th_reps
    hist = generate_demo_history()

    theme.render_brand_header("Clinician workspace", home_href=home_href())

    top = st.columns([3, 1])
    with top[0]:
        st.markdown("## Therapist dashboard")
        st.caption("Patient: **A. Demo** · ID PASS-001 · Left knee · Post-op week 6  "
                   "*(demo patient)*")
    with top[1]:
        st.write("")
        st.button("New session capture", on_click=_reset_therapist_session,
                  use_container_width=True)

    change = hist["rom_deg"].iloc[-1] - hist["rom_deg"].iloc[0]
    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Current-session ROM", f"{m.range_of_motion_deg:.0f}°")
    k2.metric("6-week ROM change", f"{change:+.0f}°", help="From sample history")
    k3.metric("Sessions logged", f"{len(hist)}", help="Sample history")
    k4.metric("Reps this session", f"{r.count}")
    st.divider()

    t1, t2, t3, t4 = st.tabs(["Progress", "Current session",
                              "Rep analysis", "Compare"])
    with t1:
        _tab_progress(hist)
    with t2:
        _tab_current(ss)
    with t3:
        _tab_reps(r, ss.th_rate)
    with t4:
        _tab_compare(hist)


# --- entry ----------------------------------------------------------------

def main():
    st.set_page_config(page_title="PASS · Knee Rehabilitation",
                       layout="wide", initial_sidebar_state="expanded")
    theme.inject_css()
    init_state()

    if not st.session_state.authenticated:
        login_screen()
        return

    render_sidebar()
    if st.session_state.role == "Patient":
        patient_view()
    else:
        therapist_view()


if __name__ == "__main__":
    main()
