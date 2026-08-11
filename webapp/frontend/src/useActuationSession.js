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
// Preset force-level buttons (kg) replacing the old 0-100 slider. Sent to the
// board as-is (raw kg), matching set_force/twist's existing unit convention -
// tension_n already reads on this same scale, not true SI Newtons.
export const KG_OPTIONS = [1, 2, 3, 4, 5]

// Client-side only for now - no exercise field exists in the sessions
// database or the recommendation logic (sessions.py) yet, so this just
// drives the Recommendation card's displayed copy. ptReps is a placeholder
// stand-in for a real PT-entered value, not sourced from any clinician
// input - swap this out once that exists.
export const EXERCISES = [
  { id: 'knee_extension', label: 'Knee extension', ptReps: 10 },
  { id: 'hamstring_curl', label: 'Hamstring curl', ptReps: 8 },
]

export function useActuationSession(m) {
  const online = !!m?.actuationOk
  const tension = m?.actuationTension ?? 0
  const boardState = m?.actuationState ?? null
  const rec = m?.actuationRecommendation ?? null

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
      sendCmd('set_force', level)
      sendCmd('twist', level)
      setPhase('twisting')
      return
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, level])

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
    setPhase('exercising')
  }

  const stopSession = () => {
    const s = sessionRef.current
    const { durationS, peak, avg } = summarizeSession(s)
    setSummary({ target: s.target, durationS, peak, avg, samples: s.samples.length })
    sendCmd('untwist', 1)
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

  const jogStart = (cmd) => {
    sendCmd(cmd, 1)
    clearInterval(jogTimer.current)
    jogTimer.current = setInterval(() => sendCmd(cmd, 1), JOG_REPEAT_MS)
  }
  const jogStop = () => {
    clearInterval(jogTimer.current)
    sendCmd('stop', 0)
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
    respondRecommendation, remarkText, setRemarkText, remarkStatus, logRemark, jogStart, jogStop,
    hasTarget, target, deltaPct, comparisonData, comparisonWindowS,
  }
}
