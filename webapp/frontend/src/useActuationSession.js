// All actuation-session state and control logic, lifted out of
// ActuationPanel.jsx so it survives switching tabs. Previously this state
// (phase, countdown, in-progress samples...) lived INSIDE ActuationPanel,
// which App.jsx only mounts while tab === 'session' - so navigating to
// Gait/Logs/etc. unmounted the component and threw the whole session away
// mid-exercise. Called once in App.jsx (always mounted regardless of tab),
// its return value is handed to both the full ActuationPanel (shown on the
// Session tab) and ActuationFloatingWidget (shown everywhere else while a
// session is actually running), so both are just views over the same live
// state instead of each owning their own copy.

import { useEffect, useRef, useState } from 'react'

async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return null   // offline - caller already has its own local state to fall back on
  }
}

async function sendCmd(cmd, value = 0) {
  try {
    await fetch('/api/actuation/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, value }),
    })
  } catch { /* offline - button still gives feedback, command just won't land */ }
}

// Shared by stopSession (normal Stop) and forceStop (mid-exercise Force Stop)
// so both log to the same shape via /api/actuation/session.
function summarizeSession(s) {
  const durationS = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0
  const peak = s.samples.reduce((mx, v) => Math.max(mx, v), 0)
  const avg = s.samples.length ? s.samples.reduce((a, v) => a + v, 0) / s.samples.length : 0
  return { durationS, peak, avg }
}

const COUNTDOWN_S = 3
const JOG_REPEAT_MS = 150
// Samples are pushed once per WebSocket tick while phase === 'exercising',
// and the backend broadcasts at a fixed 20 Hz (main.py's _broadcaster) - so
// index * this constant approximates each sample's elapsed time within its
// session. Good enough for a comparison chart; not a precision timing claim.
const SAMPLE_DT_S = 0.05
const READY_MARGIN = 0.95   // fraction of target tension counted as "reached"
const KG_TO_N = 9.81
// Assessment mode: fixed 1kg load, motor braked in place once reached - see
// ASSESSMENT_LOAD_N in angle_pid_wifi_test.cpp (must match).
const ASSESSMENT_STATES = ['assessing_knee_extension', 'assessing_curl', 'assessment_done']
// Preset force-level buttons (kg), converted to real Newtons (*KG_TO_N) before
// being sent as start_exercise's forceSetpoint - the firmware's force PID
// (calculateForcePID/forceDeltaToCounts) does real physics with this number,
// unlike the old raw-passthrough convention.
export const KG_OPTIONS = [1, 2, 3, 4, 5]

// Client-side only for now - no exercise field exists in the sessions
// database or the recommendation logic (sessions.py) yet, so this just
// drives the Recommendation card's displayed copy. ptReps is a placeholder
// stand-in for a real PT-entered value, not sourced from any clinician
// input - swap this out once that exists. motorIndex matches
// angle_pid_wifi_test.cpp's select_motor command (0 = motor A, 1 = motor B).
export const EXERCISES = [
  { id: 'knee_extension', label: 'Knee extension', ptReps: 10, motorIndex: 1 },
  { id: 'hamstring_curl', label: 'Hamstring curl', ptReps: 8, motorIndex: 0 },
]

export function useActuationSession(m) {
  const online = !!m?.actuationOk
  // Telemetry now carries a real Newton reading (angle_pid_wifi_test.cpp
  // sends active->force) - converted to kg once, right here, so every
  // existing kg-based comparison/display/DB column below (target matching,
  // chart, session summaries) keeps working unchanged instead of needing a
  // *KG_TO_N or /KG_TO_N at each individual use site.
  const tension = (m?.actuationTension ?? 0) / KG_TO_N
  const boardState = m?.actuationState ?? null
  const rec = m?.actuationRecommendation ?? null
  const assessmentEnabled = !!m?.actuationAssessmentEnabled
  const assessmentActive = ASSESSMENT_STATES.includes(boardState)
  // Rep count comes from the knee module's own IMU-based counter
  // (useMetrics.js's repsR, threshold-crossing on knee flexion angle) -
  // already flowing through the same `m` snapshot passed in here, no new
  // wiring needed. It's a global, ever-increasing counter (only reset by the
  // Gait tab's own "Reset reps" control), so repsCompleted below is a LOCAL
  // delta from a baseline captured when the exercise starts, not the raw
  // total - see beginExercise(). Right knee only - the actuation hardware
  // is right-leg-only, no left-side rig exists.
  const totalReps = m?.repsR ?? 0

  const [level, setLevel] = useState(KG_OPTIONS[0])
  const [exercise, setExercise] = useState(EXERCISES[0].id)
  const [phase, setPhase] = useState('idle') // idle | countdown | twisting | ready | exercising | summary
  const [countdown, setCountdown] = useState(COUNTDOWN_S)
  const [summary, setSummary] = useState(null)
  const [logRefreshKey, setLogRefreshKey] = useState(0)
  // The previous session's full tension curve, for the live chart to compare
  // the in-progress session against - frozen at whatever it was when THIS
  // session started (see startSession), not re-fetched after logging, or
  // "previous" would immediately become the session that just finished.
  const [previousSamples, setPreviousSamples] = useState([])
  const sessionRef = useRef({ startedAt: null, samples: [], target: 0 })
  const repsBaselineRef = useRef(0)
  const jogTimer = useRef(null)

  const fetchPreviousSamples = () => {
    fetch('/api/actuation/session/latest')
      .then((res) => res.json())
      .then((data) => setPreviousSamples(data?.session?.samplesSeries || []))
      .catch(() => {})
  }
  useEffect(fetchPreviousSamples, [])

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      sessionRef.current = { startedAt: null, samples: [], target: level }
      const motorIndex = EXERCISES.find((ex) => ex.id === exercise)?.motorIndex ?? 0
      sendCmd('select_motor', motorIndex)
      sendCmd('start_exercise', level * KG_TO_N)
      setPhase('twisting')
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, level, exercise])

  useEffect(() => {
    if (phase !== 'twisting') return
    if (online && tension >= sessionRef.current.target * READY_MARGIN && sessionRef.current.target > 0) {
      setPhase('ready')
    }
  }, [phase, online, tension])

  useEffect(() => {
    if (phase !== 'exercising') return
    sessionRef.current.samples.push(tension)
  }, [phase, tension])

  useEffect(() => () => clearInterval(jogTimer.current), [])

  const startSession = () => {
    fetchPreviousSamples()
    setSummary(null)
    setCountdown(COUNTDOWN_S)
    setPhase('countdown')
  }

  const markReady = () => setPhase('ready')

  const beginExercise = () => {
    sessionRef.current.startedAt = Date.now()
    sessionRef.current.samples = []
    repsBaselineRef.current = totalReps
    setPhase('exercising')
  }
  const repsCompleted = phase === 'exercising' ? Math.max(0, totalReps - repsBaselineRef.current) : 0

  const stopSession = () => {
    const s = sessionRef.current
    const { durationS, peak, avg } = summarizeSession(s)
    setSummary({ target: s.target, durationS, peak, avg, samples: s.samples.length })
    sendCmd('stop', 0)
    setPhase('summary')
    postJson('/api/actuation/session', {
      target: s.target, durationS, peak, avg, samples: s.samples.length,
      completed: true, kgOptions: KG_OPTIONS, samplesSeries: s.samples,
    }).then(() => setLogRefreshKey((k) => k + 1))
  }

  // A force stop mid-exercise is still a meaningful data point ("this level
  // was too much") - log it same as a normal Stop, just with completed:false,
  // so the recommendation can react to it. A force stop from any other phase
  // (still twisting, hasn't started exercising yet) has no sample data worth
  // logging.
  const forceStop = () => {
    clearInterval(jogTimer.current)
    sendCmd('stop', 0)
    if (phase === 'exercising') {
      const s = sessionRef.current
      const { durationS, peak, avg } = summarizeSession(s)
      postJson('/api/actuation/session', {
        target: s.target, durationS, peak, avg, samples: s.samples.length,
        completed: false, kgOptions: KG_OPTIONS, samplesSeries: s.samples,
      }).then(() => setLogRefreshKey((k) => k + 1))
    }
    setPhase('idle')
  }

  const respondRecommendation = (approved) =>
    postJson('/api/actuation/recommendation/respond', { approved })

  // Clinician-only toggle (see sessions.py's assessment-mode gate) - patient
  // only sees the Start Assessment button while this is on.
  const setAssessmentEnabled = (enabled) =>
    postJson('/api/actuation/assessment/enable', { enabled })

  // Patient-triggered - the firmware runs the whole guided A-then-B sequence
  // itself (see remoteStartAssessment/serviceRemoteFlows in
  // angle_pid_wifi_test.cpp); progress is read straight from boardState
  // (assessing_knee_extension / assessing_curl / assessment_done), not
  // tracked here.
  const startAssessment = () => sendCmd('start_assessment', 0)

  const [remarkText, setRemarkText] = useState('')
  const [remarkStatus, setRemarkStatus] = useState(null) // null | 'saved'
  const logRemark = async (sessionId) => {
    const text = remarkText.trim()
    if (!sessionId || !text) return
    const res = await postJson('/api/actuation/session/remark', { sessionId, text })
    if (res?.remark) {
      setRemarkText('')
      setRemarkStatus('saved')
    }
  }

  // Manual Control's motor selector - a separate control from `exercise`'s
  // knee-extension/curl picker above (manual jogging is raw per-motor
  // testing, not tied to an exercise), but its highlighted/default motor
  // tracks whichever exercise was picked/run last, so it starts pointed at
  // the right motor instead of always defaulting to A. Still overridable by
  // clicking the other button directly. Sends select_motor immediately on
  // pick so the firmware has a target before the first jog press - see
  // remoteJog() in angle_pid_wifi_test.cpp (only jogs while state ==
  // SELECT_MODE, which select_motor puts it in).
  const [manualMotor, setManualMotorState] = useState(EXERCISES[0].motorIndex)
  useEffect(() => {
    const motorIndex = EXERCISES.find((ex) => ex.id === exercise)?.motorIndex
    if (motorIndex != null) setManualMotorState(motorIndex)
  }, [exercise])
  const selectManualMotor = (motorIndex) => {
    setManualMotorState(motorIndex)
    sendCmd('select_motor', motorIndex)
  }

  const jogStart = (cmd) => {
    sendCmd(cmd, 1)
    clearInterval(jogTimer.current)
    jogTimer.current = setInterval(() => sendCmd(cmd, 1), JOG_REPEAT_MS)
  }
  const jogStop = () => {
    clearInterval(jogTimer.current)
    // jog_stop, not stop - halts movement without deselecting the motor
    // (stop is the full-abort command used by Force Stop), so repeated jog
    // presses don't need the motor reselected every time.
    sendCmd('jog_stop', 0)
  }

  // Target-vs-actual consistency (supposed force vs what the strain gauge
  // reports) - only meaningful once a session has actually commanded a
  // target; before that there's nothing to be consistent WITH.
  const hasTarget = ['twisting', 'ready', 'exercising'].includes(phase) && sessionRef.current.target > 0
  const target = sessionRef.current.target
  const deltaPct = hasTarget && target > 0 ? ((tension - target) / target) * 100 : null

  // Current session (in progress, or just-finished until the next Start
  // resets it) vs the one immediately before it, both indexed by elapsed
  // time WITHIN their own session rather than wall-clock time - that's what
  // makes them comparable on the same axis regardless of when each was run.
  const curSamples = sessionRef.current.samples
  const comparisonData = []
  for (let i = 0; i < previousSamples.length; i++) {
    comparisonData.push({ t: i * SAMPLE_DT_S, prevTension: previousSamples[i] })
  }
  for (let i = 0; i < curSamples.length; i++) {
    comparisonData.push({ t: i * SAMPLE_DT_S, curTension: curSamples[i] })
  }
  comparisonData.sort((a, b) => a.t - b.t)
  const comparisonWindowS = Math.max(
    previousSamples.length * SAMPLE_DT_S,
    curSamples.length * SAMPLE_DT_S,
    10,
  )

  return {
    online, tension, boardState, rec,
    level, setLevel, exercise, setExercise, phase, setPhase, countdown, summary, logRefreshKey,
    startSession, markReady, beginExercise, stopSession, forceStop,
    respondRecommendation, remarkText, setRemarkText, remarkStatus, logRemark,
    manualMotor, selectManualMotor, jogStart, jogStop,
    assessmentEnabled, assessmentActive, setAssessmentEnabled, startAssessment, repsCompleted,
    hasTarget, target, deltaPct, comparisonData, comparisonWindowS,
  }
}
